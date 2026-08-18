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
		Dependencies{},
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
		Dependencies{},
	)
	request := httptest.NewRequest(standardhttp.MethodGet, "/readyz", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != standardhttp.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, standardhttp.StatusServiceUnavailable)
	}
}

func TestCORSAllowsCredentialedWebRequests(t *testing.T) {
	handler := NewHandler(
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		"http://localhost:5173",
		func(_ context.Context) error { return nil },
		Dependencies{},
	)
	request := httptest.NewRequest(standardhttp.MethodOptions, "/api/v1/auth/refresh", nil)
	request.Header.Set("Origin", "http://localhost:5173")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != standardhttp.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.Code, standardhttp.StatusNoContent)
	}
	if response.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatal("credentialed CORS requests are not enabled")
	}
}
