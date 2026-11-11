package http

import (
	"fmt"
	"io"
	"log/slog"
	standardhttp "net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/files"
)

// A player seeks a voice recording with Range requests; the local blob
// answers with 206 and keeps the safe download headers.
func TestWriteDownloadServesRangesWithSafeHeaders(t *testing.T) {
	content := []byte("0123456789abcdefghij")
	path := filepath.Join(t.TempDir(), "blob")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	handler := &identityHandlers{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	serve := func(rangeHeader string) *httptest.ResponseRecorder {
		t.Helper()
		reader, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		readyAt := time.Now().Add(-time.Minute)
		download := files.Download{File: files.File{ID: "f", Name: "voice.m4a", MIME: "audio/mp4", Size: int64(len(content)), ReadyAt: &readyAt}, Reader: reader}
		request := httptest.NewRequest(standardhttp.MethodGet, "/api/v1/files/f/download", nil)
		if rangeHeader != "" {
			request.Header.Set("Range", rangeHeader)
		}
		response := httptest.NewRecorder()
		handler.writeDownload(response, request, download, "/api/v1/files/f/download")
		return response
	}
	assertSafe := func(response *httptest.ResponseRecorder) {
		t.Helper()
		header := response.Header()
		if header.Get("Content-Type") != "audio/mp4" || header.Get("X-Content-Type-Options") != "nosniff" ||
			header.Get("Content-Security-Policy") != "sandbox; default-src 'none'" || header.Get("Content-Disposition") == "" ||
			header.Get("Cache-Control") != "private, no-store" {
			t.Fatalf("unsafe download headers: %v", header)
		}
	}

	full := serve("")
	if full.Code != standardhttp.StatusOK || full.Body.String() != string(content) || full.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("full download = %d %q accept-ranges=%q", full.Code, full.Body.String(), full.Header().Get("Accept-Ranges"))
	}
	assertSafe(full)

	partial := serve("bytes=10-14")
	if partial.Code != standardhttp.StatusPartialContent || partial.Body.String() != "abcde" || partial.Header().Get("Content-Range") != "bytes 10-14/20" {
		t.Fatalf("range download = %d %q content-range=%q", partial.Code, partial.Body.String(), partial.Header().Get("Content-Range"))
	}
	assertSafe(partial)

	tail := serve("bytes=-3")
	if tail.Code != standardhttp.StatusPartialContent || tail.Body.String() != "hij" {
		t.Fatalf("suffix range = %d %q", tail.Code, tail.Body.String())
	}

	if outside := serve("bytes=50-60"); outside.Code != standardhttp.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("unsatisfiable range = %d, want 416", outside.Code)
	}

	// Many ranges would multiply the response; the whole file comes back.
	many := serve("bytes=" + strings.TrimSuffix(strings.Repeat("0-0,", 100_000), ","))
	if many.Code != standardhttp.StatusOK || many.Body.Len() != len(content) || strings.HasPrefix(many.Header().Get("Content-Type"), "multipart/") {
		t.Fatalf("multi-range = %d, %d bytes, type %q; want 200 with the file once", many.Code, many.Body.Len(), many.Header().Get("Content-Type"))
	}
	assertSafe(many)
	if two := serve("bytes=0-1,5-6"); two.Code != standardhttp.StatusOK || two.Body.String() != string(content) {
		t.Fatalf("two ranges = %d %q, want the whole file", two.Code, two.Body.String())
	}
}

// Temporary completion failures tell the client to retry the same upload.
func TestFileErrorsAskForRetryOnTemporaryFailures(t *testing.T) {
	handler := &identityHandlers{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{fmt.Errorf("%w: copy failed", files.ErrUnavailable), standardhttp.StatusServiceUnavailable, "storage_unavailable"},
	}
	for _, item := range cases {
		response := httptest.NewRecorder()
		handler.fileError(response, httptest.NewRequest(standardhttp.MethodPost, "/api/v1/files/uploads/u/complete", nil), item.err)
		if response.Code != item.status || response.Header().Get("Retry-After") == "" || !strings.Contains(response.Body.String(), item.code) {
			t.Fatalf("%v: status %d, Retry-After %q, body %s", item.err, response.Code, response.Header().Get("Retry-After"), response.Body.String())
		}
	}
}
