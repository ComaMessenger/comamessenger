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

func TestRequiredAgentScopeUsesClosedAllowlist(t *testing.T) {
	tests := []struct {
		method, path, scope string
		allowed             bool
	}{
		{standardhttp.MethodGet, "/api/v1/chats", "chats:read", true},
		{standardhttp.MethodGet, "/api/v1/chats/00000000-0000-7000-8000-000000000001/messages", "messages:read", true},
		{standardhttp.MethodPost, "/api/v1/chats/00000000-0000-7000-8000-000000000001/messages", "messages:write", true},
		{standardhttp.MethodPut, "/api/v1/messages/00000000-0000-7000-8000-000000000001/reactions/%F0%9F%91%8D", "reactions:write", true},
		{standardhttp.MethodGet, "/api/v1/files/00000000-0000-7000-8000-000000000001/download", "files:read", true},
		{standardhttp.MethodGet, "/api/v1/search", "search:read", true},
		{standardhttp.MethodGet, "/api/v1/actors", "members:read", true},
		{standardhttp.MethodGet, "/api/v1/me", "", true},
		{standardhttp.MethodGet, "/api/v1/agent-runtime/checkpoints/example", "runtime:execute", true},
		{standardhttp.MethodPut, "/api/v1/agent-runtime/checkpoints/example", "runtime:execute", true},
		{standardhttp.MethodPost, "/api/v1/agent-runtime/runs/00000000-0000-7000-8000-000000000001/complete", "runtime:execute", true},
		{standardhttp.MethodDelete, "/api/v1/agent-runtime/checkpoints/example", "", false},
		{standardhttp.MethodGet, "/api/v1/agent-runtime/private-future-route", "", false},
		{standardhttp.MethodPost, "/api/v1/files/uploads", "", false},
		{standardhttp.MethodGet, "/api/v1/agents", "", false},
	}
	for _, test := range tests {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			scope, allowed := requiredAgentScope(test.method, test.path)
			if scope != test.scope || allowed != test.allowed {
				t.Fatalf("scope=%q allowed=%v, want %q/%v", scope, allowed, test.scope, test.allowed)
			}
		})
	}
}
