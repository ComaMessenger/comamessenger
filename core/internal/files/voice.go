package files

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"math/bits"
	"mime"
	"path/filepath"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/storage"
)

// Voice limits. A phone records AAC in an MP4 (m4a) container; at the
// 128 kbit/s Expo "high quality" preset ten minutes take about 9.6 MB, so
// 15 MiB leaves room for container overhead and a higher bitrate while
// staying under the default 16 MiB multipart threshold. A voice upload is
// single-part whatever the threshold (see CreateUpload).
const (
	VoiceWaveformLength       = 64
	MinVoiceDurationMs        = 300
	MaxVoiceDurationMs        = 10 * 60 * 1000
	MaxVoiceBytes       int64 = 15 << 20
	// voiceDurationSlackMs absorbs the gap between the recorder's clock
	// and the encoded duration (encoder priming, last partial frame).
	voiceDurationSlackMs = 1500
	// Parsing bounds. The first mp4HeadBytes come in one read; a top-level
	// header beyond them (after a long mdat) costs one more ranged read,
	// as does a moov outside them. Real recordings have four or five
	// top-level boxes; inner boxes are parsed in memory.
	mp4HeadBytes        int64 = 64 << 10
	maxMP4TopLevelBoxes       = 16
	maxMP4ChildBoxes          = 1024
	maxMoovBytes        int64 = 2 << 20
	// maxConcurrentVoiceChecks caps parallel voice verifications per process;
	// voiceSlotWait is how long a check waits for a slot before ErrBusy.
	maxConcurrentVoiceChecks = 4
	voiceSlotWait            = 5 * time.Second
)

var (
	errNotVoiceContainer = errors.New("not an audio-only MP4 container")
	// errVoiceRead marks a failure to read the recording, as opposed to
	// content that is not a voice recording.
	errVoiceRead = errors.New("could not read the voice recording")
)

// Voice is what makes an audio attachment a voice message: a duration and
// a fixed-length peak waveform, 0 silent to 255 loudest. Clients that do not
// know the field see an ordinary audio/mp4 file.
type Voice struct {
	DurationMs int   `json:"duration_ms"`
	Waveform   []int `json:"waveform"`
}

func (v Voice) waveformBytes() []byte {
	result := make([]byte, len(v.Waveform))
	for index, value := range v.Waveform {
		result[index] = byte(value)
	}
	return result
}

func voiceFromColumns(duration *int32, waveform []byte) *Voice {
	if duration == nil || len(waveform) != VoiceWaveformLength {
		return nil
	}
	result := &Voice{DurationMs: int(*duration), Waveform: make([]int, len(waveform))}
	for index, value := range waveform {
		result.Waveform[index] = int(value)
	}
	return result
}

// VoiceFromColumns lets other packages that read files rows directly build
// the API value from the stored columns.
func VoiceFromColumns(duration *int32, waveform []byte) *Voice {
	return voiceFromColumns(duration, waveform)
}

// voiceMIMEs are the types iOS (AVAudioRecorder, "audio/x-m4a" or
// "audio/m4a") and Android (MediaRecorder MPEG_4, "audio/mp4") report for an
// Expo recording. "audio/aac" is accepted as a declared type only: the
// content must still be an MP4 container, raw ADTS has no duration header.
var voiceMIMEs = map[string]bool{
	"audio/mp4": true, "audio/m4a": true, "audio/x-m4a": true, "audio/aac": true, "audio/x-aac": true,
}

var voiceExtensions = map[string]bool{".m4a": true, ".mp4": true, ".aac": true}

// validateVoice checks client-declared voice metadata. The duration is
// re-read from the file when the upload completes.
func validateVoice(voice *Voice, name, declaredMIME string, size int64) error {
	if voice == nil {
		return nil
	}
	if !voiceMIMEs[declaredMIME] || !voiceExtensions[strings.ToLower(filepath.Ext(name))] {
		return fmt.Errorf("%w: a voice message must be an m4a (AAC in MP4) recording", ErrInvalid)
	}
	if size > MaxVoiceBytes {
		return fmt.Errorf("%w: a voice message may be at most %d bytes", ErrInvalid, MaxVoiceBytes)
	}
	if voice.DurationMs < MinVoiceDurationMs || voice.DurationMs > MaxVoiceDurationMs {
		return fmt.Errorf("%w: voice duration must be between %d and %d ms", ErrInvalid, MinVoiceDurationMs, MaxVoiceDurationMs)
	}
	if len(voice.Waveform) != VoiceWaveformLength {
		return fmt.Errorf("%w: voice waveform must have exactly %d values", ErrInvalid, VoiceWaveformLength)
	}
	for _, value := range voice.Waveform {
		if value < 0 || value > 255 {
			return fmt.Errorf("%w: voice waveform values must be between 0 and 255", ErrInvalid)
		}
	}
	return nil
}

// verifyVoice re-reads a completed voice upload and replaces the claimed
// duration with the one encoded in the container. It rejects anything that
// is not an audio-only AAC MP4 or whose length is far from the claim. Only
// box headers and the moov box are read; mdat stays in storage.
func (s *Service) verifyVoice(ctx context.Context, claim uploadClaim) (int, error) {
	// One check per actor at a time, and a bounded wait for one of the
	// shared slots: a single sender cannot queue up the whole service.
	if _, running := s.voiceActors.LoadOrStore(claim.File.UploaderID, struct{}{}); running {
		return 0, ErrTooManyChecks
	}
	defer s.voiceActors.Delete(claim.File.UploaderID)
	wait := time.NewTimer(s.voiceSlotWait)
	defer wait.Stop()
	select {
	case s.voiceChecks <- struct{}{}:
		defer func() { <-s.voiceChecks }()
	case <-wait.C:
		return 0, ErrBusy
	case <-ctx.Done():
		return 0, fmt.Errorf("%w: %v", ErrUnavailable, ctx.Err())
	}
	ranges, ok := s.store.(storage.RangeReader)
	if !ok {
		return 0, fmt.Errorf("storage cannot read voice headers")
	}
	read := func(offset, length int64) ([]byte, error) {
		return ranges.ReadRange(ctx, claim.File.storageKey, offset, length)
	}
	actual, err := mp4AudioDuration(read, claim.File.Size)
	if errors.Is(err, errVoiceRead) {
		// The store failed to answer (5xx, timeout, broken connection): not
		// evidence against the recording. The upload stays open.
		return 0, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if err != nil {
		return 0, fmt.Errorf("%w: voice content is not an m4a recording", ErrInvalid)
	}
	claimed := claim.File.Voice.DurationMs
	tolerance := max(voiceDurationSlackMs, claimed/10)
	if actual < MinVoiceDurationMs || actual > MaxVoiceDurationMs+voiceDurationSlackMs || abs(actual-claimed) > tolerance {
		return 0, fmt.Errorf("%w: voice duration does not match the recording", ErrInvalid)
	}
	return min(actual, MaxVoiceDurationMs), nil
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

// normalizeVoiceMIME stores every accepted voice recording as audio/mp4, the
// type browsers and both mobile platforms play.
func normalizeVoiceMIME(declared string) string {
	value, _, _ := mime.ParseMediaType(declared)
	if voiceMIMEs[value] {
		return "audio/mp4"
	}
	return declared
}

// mp4Boxes calls visit for every box in data, in order, without collecting
// them. Sizes are bounded by data and the count by maxMP4ChildBoxes, so a
// crafted header can neither read past the buffer nor cost unbounded work.
func mp4Boxes(data []byte, visit func(kind string, payload []byte) error) error {
	count := 0
	for offset := 0; offset < len(data); {
		count++
		if count > maxMP4ChildBoxes || len(data)-offset < 8 {
			return errNotVoiceContainer
		}
		size := uint64(binary.BigEndian.Uint32(data[offset:]))
		kind := string(data[offset+4 : offset+8])
		header := uint64(8)
		switch size {
		case 0:
			size = uint64(len(data) - offset)
		case 1:
			if len(data)-offset < 16 {
				return errNotVoiceContainer
			}
			size = binary.BigEndian.Uint64(data[offset+8:])
			header = 16
		}
		if size < header || size > uint64(len(data)-offset) {
			return errNotVoiceContainer
		}
		if err := visit(kind, data[offset+int(header):offset+int(size)]); err != nil {
			return err
		}
		offset += int(size)
	}
	return nil
}

// mp4Single returns the payload of the one box of a kind among data's
// children; zero or several such boxes are an error.
func mp4Single(data []byte, kind string) ([]byte, error) {
	var found []byte
	seen := 0
	err := mp4Boxes(data, func(child string, payload []byte) error {
		if child == kind {
			seen++
			found = payload
		}
		return nil
	})
	if err != nil || seen != 1 {
		return nil, errNotVoiceContainer
	}
	return found, nil
}

// mp4HeaderDuration reads (timescale, duration) from an mvhd or mdhd payload.
func mp4HeaderDuration(payload []byte) (uint64, uint64, bool) {
	if len(payload) < 4 {
		return 0, 0, false
	}
	switch payload[0] {
	case 0:
		if len(payload) < 20 {
			return 0, 0, false
		}
		return uint64(binary.BigEndian.Uint32(payload[12:])), uint64(binary.BigEndian.Uint32(payload[16:])), true
	case 1:
		if len(payload) < 32 {
			return 0, 0, false
		}
		return uint64(binary.BigEndian.Uint32(payload[20:])), binary.BigEndian.Uint64(payload[24:]), true
	default:
		return 0, 0, false
	}
}

// durationMs converts media units to milliseconds with a 128-bit product,
// so a 64-bit duration cannot wrap around into a plausible value.
func durationMs(timescale, duration uint64) (int, bool) {
	if timescale == 0 || duration == 0 || duration == ^uint64(0) {
		return 0, false
	}
	high, low := bits.Mul64(duration, 1000)
	if high >= timescale {
		return 0, false
	}
	value, _ := bits.Div64(high, low, timescale)
	if value > math.MaxInt32 {
		return 0, false
	}
	return int(value), true
}

// mp4AACTrack checks one trak is a sound track whose every sample entry is
// AAC (mp4a) and returns its media duration in milliseconds, 0 if unknown.
func mp4AACTrack(track []byte) (int, error) {
	media, err := mp4Single(track, "mdia")
	if err != nil {
		return 0, err
	}
	handler, err := mp4Single(media, "hdlr")
	if err != nil || len(handler) < 12 || string(handler[8:12]) != "soun" {
		return 0, errNotVoiceContainer
	}
	information, err := mp4Single(media, "minf")
	if err != nil {
		return 0, err
	}
	table, err := mp4Single(information, "stbl")
	if err != nil {
		return 0, err
	}
	descriptions, err := mp4Single(table, "stsd")
	if err != nil || len(descriptions) < 8 {
		return 0, errNotVoiceContainer
	}
	declared := binary.BigEndian.Uint32(descriptions[4:8])
	entries := 0
	if err := mp4Boxes(descriptions[8:], func(kind string, _ []byte) error {
		entries++
		if kind != "mp4a" {
			return errNotVoiceContainer
		}
		return nil
	}); err != nil || entries == 0 || uint32(entries) != declared {
		return 0, errNotVoiceContainer
	}
	header, err := mp4Single(media, "mdhd")
	if err != nil {
		return 0, err
	}
	if scale, duration, ok := mp4HeaderDuration(header); ok {
		if value, ok := durationMs(scale, duration); ok {
			return value, nil
		}
	}
	return 0, nil
}

// mp4TopLevel lists what may sit at the top of a voice recording. Anything
// else, such as a fragment (moof), a stray trak or a second movie, is refused.
var mp4TopLevel = map[string]bool{"ftyp": true, "moov": true, "mdat": true, "free": true, "skip": true, "wide": true, "uuid": true, "udta": true}

// mp4AudioDuration walks the top-level boxes of an object of the given size
// through read, which returns exactly length bytes at offset. It needs the
// first box to be ftyp and exactly one moov of at most maxMoovBytes; media
// data is skipped by offset, never read. The moov box may come after mdat,
// as both iOS and Android recorders write it last.
func mp4AudioDuration(fetch func(offset, length int64) ([]byte, error), size int64) (int, error) {
	if size < 8 {
		return 0, errNotVoiceContainer
	}
	head, err := fetch(0, min(size, mp4HeadBytes))
	if err != nil {
		return 0, fmt.Errorf("%w: %v", errVoiceRead, err)
	}
	read := func(offset, length int64) ([]byte, error) {
		if offset+length <= int64(len(head)) {
			return head[offset : offset+length], nil
		}
		return fetch(offset, length)
	}
	var moov []byte
	count := 0
	for offset := int64(0); offset < size; {
		count++
		if count > maxMP4TopLevelBoxes || size-offset < 8 {
			return 0, errNotVoiceContainer
		}
		header, err := read(offset, min(16, size-offset))
		if err != nil {
			return 0, fmt.Errorf("%w: %v", errVoiceRead, err)
		}
		boxSize := int64(binary.BigEndian.Uint32(header))
		kind := string(header[4:8])
		headerSize := int64(8)
		switch boxSize {
		case 0:
			boxSize = size - offset
		case 1:
			if len(header) < 16 {
				return 0, errNotVoiceContainer
			}
			large := binary.BigEndian.Uint64(header[8:])
			if large > uint64(size-offset) {
				return 0, errNotVoiceContainer
			}
			boxSize = int64(large)
			headerSize = 16
		}
		if boxSize < headerSize || boxSize > size-offset || !mp4TopLevel[kind] || (count == 1) != (kind == "ftyp") {
			return 0, errNotVoiceContainer
		}
		if kind == "moov" {
			if moov != nil || boxSize-headerSize > maxMoovBytes || boxSize == headerSize {
				return 0, errNotVoiceContainer
			}
			if moov, err = read(offset+headerSize, boxSize-headerSize); err != nil {
				return 0, fmt.Errorf("%w: %v", errVoiceRead, err)
			}
		}
		offset += boxSize
	}
	if moov == nil {
		return 0, errNotVoiceContainer
	}
	return mp4MovieDuration(moov)
}

// mp4MovieDuration checks a moov payload: one mvhd, no fragments (mvex), only
// AAC sound tracks, and returns the movie duration (else the longest track).
func mp4MovieDuration(moov []byte) (int, error) {
	movieHeader, err := mp4Single(moov, "mvhd")
	if err != nil {
		return 0, err
	}
	tracks, trackDuration := 0, 0
	if err := mp4Boxes(moov, func(kind string, payload []byte) error {
		switch kind {
		case "mvex", "moof", "moov":
			return errNotVoiceContainer
		case "trak":
			tracks++
			value, err := mp4AACTrack(payload)
			if err != nil {
				return err
			}
			trackDuration = max(trackDuration, value)
		}
		return nil
	}); err != nil {
		return 0, err
	}
	if tracks == 0 {
		return 0, errNotVoiceContainer
	}
	if scale, duration, ok := mp4HeaderDuration(movieHeader); ok {
		if value, ok := durationMs(scale, duration); ok {
			return value, nil
		}
	}
	if trackDuration > 0 {
		return trackDuration, nil
	}
	return 0, errNotVoiceContainer
}

// MP4AudioDurationMs checks an in-memory recording; see mp4AudioDuration.
func MP4AudioDurationMs(data []byte) (int, error) {
	return mp4AudioDuration(func(offset, length int64) ([]byte, error) {
		if offset < 0 || length < 0 || offset+length > int64(len(data)) {
			return nil, errNotVoiceContainer
		}
		return data[offset : offset+length], nil
	}, int64(len(data)))
}
