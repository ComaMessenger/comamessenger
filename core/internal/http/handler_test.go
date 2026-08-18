package http

import (
	"context"
	"errors"
	"io"
	"log/slog"
	standardhttp "net/http"
	"net/http/httptest"
	"testing"
)

func TestHealth(t *testing.T) {
	handler := NewHandler(
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		"http://localhost:5173",
		func(_ context.Context) error { return nil },
	)
	request := httptest.NewRequest(standardhttp.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != standardhttp.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, standardhttp.StatusOK)
	}
	if response.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("content type = %q, want application/json", response.Header().Get("Content-Type"))
	}
}

func TestReadinessUnavailable(t *testing.T) {
	handler := NewHandler(
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		"http://localhost:5173",
		func(_ context.Context) error { return errors.New("database unavailable") },
	)
	request := httptest.NewRequest(standardhttp.MethodGet, "/readyz", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != standardhttp.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, standardhttp.StatusServiceUnavailable)
	}
}
