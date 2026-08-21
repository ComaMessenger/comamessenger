package files

import (
	"archive/zip"
	"bytes"
	"compress/zlib"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	processingQueue          = "file-processing"
	extractorVersion         = "builtin-v1"
	maxProcessorInput        = 32 << 20
	maxExtractedText         = 1 << 20
	maxArchiveEntries        = 2_000
	maxArchiveUnpacked       = 20 << 20
	maxImagePixels     int64 = 40_000_000
)

var pdfLiteralPattern = regexp.MustCompile(`(?s)\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")`)

// ErrUnsafeContent lets a processor hook reject a file permanently. Other
// hook errors are treated as transient and retried by River.
var ErrUnsafeContent = errors.New("unsafe file content")

type ProcessorInput struct {
	FileID string
	OrgID  string
	Name   string
	MIME   string
	Data   []byte
}

type ProcessorHook interface {
	Process(context.Context, ProcessorInput) error
}

type ProcessingArgs struct {
	FileID string `json:"file_id" river:"unique"`
}

func (ProcessingArgs) Kind() string { return "file.process" }

type ProcessingWorker struct {
	river.WorkerDefaults[ProcessingArgs]
	service *Service
}

func (w *ProcessingWorker) Timeout(*river.Job[ProcessingArgs]) time.Duration { return 30 * time.Second }

func (w *ProcessingWorker) Work(ctx context.Context, job *river.Job[ProcessingArgs]) error {
	return w.service.ProcessFile(ctx, job.Args.FileID)
}

// NewProcessingClient installs the worker and wires transactional enqueueing.
func NewProcessingClient(pool *pgxpool.Pool, service *Service, logger *slog.Logger) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &ProcessingWorker{service: service})
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger:  logger,
		Queues:  map[string]river.QueueConfig{processingQueue: {MaxWorkers: 2}},
		Workers: workers,
	})
	if err != nil {
		return nil, fmt.Errorf("create file processing client: %w", err)
	}
	service.SetProcessingEnqueuer(func(ctx context.Context, tx pgx.Tx, fileID string) error {
		_, err := client.InsertTx(ctx, tx, ProcessingArgs{FileID: fileID}, &river.InsertOpts{
			Queue:       processingQueue,
			MaxAttempts: 5,
			UniqueOpts: river.UniqueOpts{
				ByArgs:  true,
				ByState: rivertype.UniqueOptsByStateDefault(),
			},
		})
		return err
	})
	return client, nil
}

type processRecord struct {
	ID, OrgID, UploaderID, Key, MIME, Name, Status string
	Size                                           int64
	PreviewFileID                                  *string
}

// ProcessFile is idempotent. A failed processor never changes the original
// file's ready state, so downloads remain available while River retries.
func (s *Service) ProcessFile(ctx context.Context, fileID string) error {
	var record processRecord
	var processing string
	err := s.pool.QueryRow(ctx, `
		SELECT id, org_id, uploader_id, storage_key, mime, name, status, size, preview_file_id, processing_status
		FROM files WHERE id = $1`, fileID).Scan(
		&record.ID, &record.OrgID, &record.UploaderID, &record.Key, &record.MIME, &record.Name,
		&record.Status, &record.Size, &record.PreviewFileID, &processing)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load file for processing: %w", err)
	}
	if record.Status != "ready" || processing == "ready" || processing == "skipped" {
		return nil
	}
	if _, err := s.pool.Exec(ctx, `UPDATE files SET processing_status = 'processing' WHERE id = $1 AND status = 'ready'`, fileID); err != nil {
		return fmt.Errorf("claim file processing: %w", err)
	}

	reader, _, err := s.store.Open(ctx, record.Key)
	if err != nil {
		s.markProcessingFailed(ctx, fileID)
		return fmt.Errorf("open file for processing: %w", err)
	}
	data, readErr := readBounded(reader, maxProcessorInput)
	closeErr := reader.Close()
	if readErr != nil || closeErr != nil {
		s.markProcessingFailed(ctx, fileID)
		return errors.Join(readErr, closeErr)
	}
	for _, hook := range s.processorHooks {
		if err := hook.Process(ctx, ProcessorInput{FileID: record.ID, OrgID: record.OrgID, Name: record.Name, MIME: record.MIME, Data: data}); err != nil {
			s.markProcessingFailed(ctx, fileID)
			if errors.Is(err, ErrUnsafeContent) {
				return nil
			}
			return fmt.Errorf("file processor hook: %w", err)
		}
	}

	var extracted string
	switch {
	case strings.HasPrefix(record.MIME, "image/"):
		if record.PreviewFileID == nil {
			preview, err := makeImagePreview(data)
			if err != nil {
				s.markProcessingFailed(ctx, fileID)
				return nil
			}
			if err := s.savePreview(ctx, record, preview); err != nil {
				s.markProcessingFailed(ctx, fileID)
				return err
			}
		}
	case record.MIME == "text/plain" || strings.HasPrefix(record.MIME, "text/"):
		if !utf8.Valid(data) {
			s.markProcessingFailed(ctx, fileID)
			return nil
		}
		extracted = normalizeExtractedText(string(data))
	case record.MIME == "application/pdf":
		extracted = normalizeExtractedText(extractPDFText(data))
	case record.MIME == "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || strings.EqualFold(filepathExtension(record.Name), ".docx"):
		extracted, err = extractDOCXText(data)
		if err != nil {
			s.markProcessingFailed(ctx, fileID)
			return nil
		}
	default:
		_, err = s.pool.Exec(ctx, `UPDATE files SET processing_status = 'skipped', extractor_version = $2 WHERE id = $1`, fileID, extractorVersion)
		return err
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE files SET extracted_text = NULLIF($2, ''), extractor_version = $3, processing_status = 'ready'
		WHERE id = $1 AND status = 'ready'`, fileID, extracted, extractorVersion)
	if err != nil {
		return fmt.Errorf("finish file processing: %w", err)
	}
	return nil
}

func filepathExtension(name string) string {
	index := strings.LastIndexByte(name, '.')
	if index < 0 {
		return ""
	}
	return strings.ToLower(name[index:])
}

func (s *Service) markProcessingFailed(ctx context.Context, fileID string) {
	_, _ = s.pool.Exec(ctx, `UPDATE files SET processing_status = 'failed', extractor_version = $2 WHERE id = $1 AND status = 'ready'`, fileID, extractorVersion)
}

func readBounded(reader io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("processor input exceeds %d bytes", limit)
	}
	return data, nil
}

func normalizeExtractedText(value string) string {
	value = strings.ReplaceAll(value, "\x00", "")
	value = strings.Join(strings.Fields(value), " ")
	if len(value) > maxExtractedText {
		value = value[:maxExtractedText]
		for !utf8.ValidString(value) {
			value = value[:len(value)-1]
		}
	}
	return value
}

func makeImagePreview(data []byte) ([]byte, error) {
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > maxImagePixels {
		return nil, errors.New("invalid or oversized image")
	}
	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	width, height := config.Width, config.Height
	if width > 512 || height > 512 {
		ratio := min(float64(512)/float64(width), float64(512)/float64(height))
		width, height = max(1, int(float64(width)*ratio)), max(1, int(float64(height)*ratio))
	}
	destination := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(destination, destination.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
	xdraw.CatmullRom.Scale(destination, destination.Bounds(), source, source.Bounds(), draw.Over, nil)
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, destination, &jpeg.Options{Quality: 82}); err != nil {
		return nil, err
	}
	return encoded.Bytes(), nil
}

func (s *Service) savePreview(ctx context.Context, parent processRecord, data []byte) error {
	previewID, err := id.New()
	if err != nil {
		return err
	}
	compact := strings.ReplaceAll(previewID, "-", "")
	key := "previews/" + compact[:2] + "/" + previewID + ".jpg"
	checksum := sha256.Sum256(data)
	if _, err := s.store.Put(ctx, storage.PutRequest{Key: key, ContentType: "image/jpeg", Size: int64(len(data)), ExpectedSHA256: &checksum, Body: bytes.NewReader(data)}); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `
		UPDATE organization_storage_usage SET used_bytes = used_bytes + $2, updated_at = now()
		WHERE org_id = $1 AND used_bytes + reserved_bytes + $2 <= COALESCE(quota_bytes, $3)`, parent.OrgID, len(data), s.quotaBytes)
	if err != nil || result.RowsAffected() != 1 {
		_ = s.store.Delete(context.Background(), key)
		if err != nil {
			return err
		}
		return ErrStorageFull
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO files (id, org_id, uploader_id, storage_driver, bucket, storage_key, name, mime, size, sha256, status, processing_status, ready_at)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, 'image/jpeg', $8, $9, 'ready', 'skipped', now())`,
		previewID, parent.OrgID, parent.UploaderID, s.store.Driver(), s.bucket, key, "preview-"+parent.ID+".jpg", len(data), checksum[:]); err != nil {
		_ = s.store.Delete(context.Background(), key)
		return err
	}
	result, err = tx.Exec(ctx, `UPDATE files SET preview_file_id = $2 WHERE id = $1 AND preview_file_id IS NULL`, parent.ID, previewID)
	if err != nil || result.RowsAffected() != 1 {
		_ = s.store.Delete(context.Background(), key)
		if err != nil {
			return err
		}
		return nil
	}
	if err := tx.Commit(ctx); err != nil {
		_ = s.store.Delete(context.Background(), key)
		return err
	}
	return nil
}

func extractDOCXText(data []byte) (string, error) {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(archive.File) > maxArchiveEntries {
		return "", errors.New("invalid or oversized DOCX archive")
	}
	var unpacked uint64
	for _, file := range archive.File {
		unpacked += file.UncompressedSize64
		if unpacked > maxArchiveUnpacked {
			return "", errors.New("DOCX unpacked size limit exceeded")
		}
	}
	for _, file := range archive.File {
		if file.Name != "word/document.xml" {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			return "", err
		}
		decoder := xml.NewDecoder(io.LimitReader(reader, maxArchiveUnpacked+1))
		var output strings.Builder
		for {
			token, err := decoder.Token()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				reader.Close()
				return "", err
			}
			start, ok := token.(xml.StartElement)
			if !ok || start.Name.Local != "t" {
				continue
			}
			var text string
			if err := decoder.DecodeElement(&text, &start); err != nil {
				reader.Close()
				return "", err
			}
			output.WriteString(text)
			output.WriteByte(' ')
		}
		reader.Close()
		return normalizeExtractedText(output.String()), nil
	}
	return "", errors.New("DOCX document.xml is missing")
}

func extractPDFText(data []byte) string {
	chunks := [][]byte{data}
	for offset := 0; offset < len(data); {
		stream := bytes.Index(data[offset:], []byte("stream"))
		if stream < 0 {
			break
		}
		stream += offset + len("stream")
		if stream < len(data) && data[stream] == '\r' {
			stream++
		}
		if stream < len(data) && data[stream] == '\n' {
			stream++
		}
		end := bytes.Index(data[stream:], []byte("endstream"))
		if end < 0 {
			break
		}
		end += stream
		headerStart := max(0, stream-256)
		if bytes.Contains(data[headerStart:stream], []byte("FlateDecode")) {
			compressed := bytes.TrimSpace(data[stream:end])
			if reader, err := zlib.NewReader(bytes.NewReader(compressed)); err == nil {
				if decoded, err := readBounded(reader, maxArchiveUnpacked); err == nil {
					chunks = append(chunks, decoded)
				}
				reader.Close()
			}
		}
		offset = end + len("endstream")
	}
	var output strings.Builder
	for _, chunk := range chunks {
		for _, match := range pdfLiteralPattern.FindAll(chunk, -1) {
			end := bytes.LastIndexByte(match, ')')
			if end > 0 {
				output.WriteString(unescapePDFLiteral(match[1:end]))
				output.WriteByte(' ')
			}
		}
	}
	return output.String()
}

func unescapePDFLiteral(value []byte) string {
	var output strings.Builder
	for index := 0; index < len(value); index++ {
		if value[index] != '\\' || index+1 >= len(value) {
			output.WriteByte(value[index])
			continue
		}
		index++
		switch value[index] {
		case 'n':
			output.WriteByte('\n')
		case 'r':
			output.WriteByte('\r')
		case 't':
			output.WriteByte('\t')
		case 'b':
			output.WriteByte('\b')
		case 'f':
			output.WriteByte('\f')
		case '\\', '(', ')':
			output.WriteByte(value[index])
		default:
			output.WriteByte(value[index])
		}
	}
	return output.String()
}

func checksumHex(value [32]byte) string { return hex.EncodeToString(value[:]) }
