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

// Until package S1 lands, every org structure route of the contract exists
// and answers 501 not_implemented.
func TestOrgRoutesAnswerNotImplemented(t *testing.T) {
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
		"GET /org",
		"POST /org/departments",
		"PATCH /org/departments/{departmentID}",
		"DELETE /org/departments/{departmentID}",
		"POST /org/departments/{departmentID}/move",
		"PUT /org/departments/{departmentID}/members/{actorID}",
		"DELETE /org/departments/{departmentID}/members/{actorID}",
		"POST /org/departments/{departmentID}/chat",
		"PUT /org/departments/{departmentID}/chat",
		"DELETE /org/departments/{departmentID}/chat",
		"GET /org/departments/{departmentID}/chat/missing",
		"POST /org/departments/{departmentID}/chat/add-missing",
		"PUT /org/people/{actorID}",
		"POST /org/people/assign",
		"POST /org/positions",
		"POST /org/positions/bulk",
		"PATCH /org/positions/{positionID}",
		"DELETE /org/positions/{positionID}",
		"GET /org/title-suggestions",
	}
	for _, route := range contract {
		if !routes[route] {
			t.Errorf("route %s is not registered", route)
		}
	}
	response := httptest.NewRecorder()
	h.orgNotImplemented(response, httptest.NewRequest(standardhttp.MethodGet, "/", nil))
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
