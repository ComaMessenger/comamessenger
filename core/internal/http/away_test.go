package http

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	standardhttp "net/http"
	"net/http/httptest"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/away"
	"github.com/comamessenger/comamessenger/core/internal/identity"
)

// An API key never reaches the away routes: the status speaks for a
// person and only that person sets it.
func TestAwayRoutesRefuseAPIKeys(t *testing.T) {
	h := newIdentityHandlers(slog.New(slog.NewTextHandler(io.Discard, nil)), "", Dependencies{Away: away.NewService(nil, nil, nil, nil)})
	reached := false
	handler := h.awayPeopleOnly(standardhttp.HandlerFunc(func(standardhttp.ResponseWriter, *standardhttp.Request) { reached = true }))
	request := httptest.NewRequest(standardhttp.MethodPut, "/me/away", nil)
	request = request.WithContext(context.WithValue(request.Context(), authContextKey{}, authenticated{
		User: identity.User{ActorID: "robot"}, Identity: access.Identity{AuthenticationKind: "api_key"},
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if reached || response.Code != standardhttp.StatusForbidden {
		t.Fatalf("api key: status %d, reached %v", response.Code, reached)
	}
}

func TestAwayErrorsFollowTheContract(t *testing.T) {
	h := newIdentityHandlers(slog.New(slog.NewTextHandler(io.Discard, nil)), "", Dependencies{})
	for _, item := range []struct {
		err    error
		status int
		code   api.ErrorCode
		field  string
	}{
		{&away.InvalidError{Field: "ends_at", Reason: "too late"}, 422, api.ErrorCodeAwayInvalid, "ends_at"},
		{away.ErrSubstituteInvalid, 422, api.ErrorCodeAwaySubstituteInvalid, ""},
		{away.ErrVersionConflict, 409, api.ErrorCodeAwayVersionConflict, ""},
		{away.ErrForbidden, 403, api.ErrorCodeForbidden, ""},
		{errors.New("boom"), 500, "internal_error", ""},
	} {
		response := httptest.NewRecorder()
		h.writeAwayError(response, httptest.NewRequest(standardhttp.MethodPut, "/me/away", nil), item.err)
		var body api.Error
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if response.Code != item.status || body.Code != item.code {
			t.Errorf("%v: %d %s", item.err, response.Code, body.Code)
		}
		if item.field != "" && (body.Details == nil || (*body.Details)["field"] != item.field) {
			t.Errorf("%v: details = %v", item.err, body.Details)
		}
	}
}
