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

// Until packages R1 and R2 land, every request and reminder route of the
// contract exists and answers 501 not_implemented.
func TestRequestAndReminderRoutesAnswerNotImplemented(t *testing.T) {
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
		"POST /chats/{chatID}/requests",
		"GET /requests/inbox",
		"GET /requests/{messageID}",
		"PUT /requests/{messageID}/answer",
		"GET /requests/{messageID}/answers",
		"POST /requests/{messageID}/remind",
		"POST /requests/{messageID}/close",
		"PUT /messages/{messageID}/reminder",
		"DELETE /messages/{messageID}/reminder",
		"GET /reminders",
		"GET /reminders/ids",
		"PUT /reminders/{reminderID}",
		"DELETE /reminders/{reminderID}",
	}
	for _, route := range contract {
		if !routes[route] {
			t.Errorf("route %s is not registered", route)
		}
	}
	for _, handler := range []standardhttp.HandlerFunc{h.requestsNotImplemented, h.remindersNotImplemented} {
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
