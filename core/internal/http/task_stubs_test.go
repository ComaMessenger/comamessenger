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

// Every task route of the contract and the waiting inbox exist; without a
// task service (tests, tools) they answer 501 not_implemented.
func TestTaskRoutesAnswerNotImplemented(t *testing.T) {
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
		"POST /chats/{chatID}/tasks",
		"GET /chats/{chatID}/tasks",
		"GET /tasks/mine",
		"GET /tasks/{messageID}",
		"PATCH /tasks/{messageID}",
		"PUT /tasks/{messageID}/status",
		"POST /tasks/{messageID}/take",
		"POST /tasks/{messageID}/items",
		"PATCH /tasks/{messageID}/items/{itemID}",
		"DELETE /tasks/{messageID}/items/{itemID}",
		"POST /tasks/{messageID}/nudge",
		"GET /inbox/waiting",
	}
	for _, route := range contract {
		if !routes[route] {
			t.Errorf("route %s is not registered", route)
		}
	}
	for _, handler := range []standardhttp.HandlerFunc{h.tasksNotImplemented, h.inboxNotImplemented} {
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
