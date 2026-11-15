package http

import (
	"encoding/json"
	"io"
	"log/slog"
	standardhttp "net/http"
	"net/http/httptest"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/go-chi/chi/v5"
)

// Until packages P and A land, every poll and away route of the contract
// exists and answers 501 not_implemented.
func TestPollAndAwayRoutesAnswerNotImplemented(t *testing.T) {
	h := newIdentityHandlers(slog.New(slog.NewTextHandler(io.Discard, nil)), "", Dependencies{})
	router := chi.NewRouter()
	h.routes(router)
	routes := map[string]bool{}
	if err := chi.Walk(router, func(method, route string, _ standardhttp.Handler, _ ...func(standardhttp.Handler) standardhttp.Handler) error {
		routes[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	contract := []string{
		"POST /chats/{chatID}/polls",
		"GET /polls/{messageID}",
		"PATCH /polls/{messageID}",
		"PUT /polls/{messageID}/vote",
		"DELETE /polls/{messageID}/vote",
		"GET /polls/{messageID}/voters",
		"POST /polls/{messageID}/remind",
		"POST /polls/{messageID}/close",
		"GET /me/away",
		"PUT /me/away",
		"DELETE /me/away",
		"GET /me/substituting",
	}
	for _, route := range contract {
		if !routes[route] {
			t.Errorf("route %s is not registered", route)
		}
	}
	for _, handler := range []standardhttp.HandlerFunc{h.pollsNotImplemented, h.awayNotImplemented} {
		response := httptest.NewRecorder()
		handler(response, httptest.NewRequest(standardhttp.MethodGet, "/", nil))
		if response.Code != standardhttp.StatusNotImplemented {
			t.Fatalf("status = %d, want 501", response.Code)
		}
		var body api.Error
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Code != api.ErrorCodeNotImplemented {
			t.Fatalf("code = %q, want not_implemented", body.Code)
		}
	}
}
