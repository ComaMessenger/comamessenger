package http

import (
	"encoding/json"
	"io"
	"log/slog"
	standardhttp "net/http"
	"net/http/httptest"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/request"
)

// The errors of @department and of the group audiences of requests reach
// the client with the contract's codes and details.field.
func TestDepartmentMentionAndAudienceErrors(t *testing.T) {
	handler := &identityHandlers{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	type body struct {
		Code    string         `json:"code"`
		Details map[string]any `json:"details"`
	}
	decode := func(t *testing.T, response *httptest.ResponseRecorder) body {
		t.Helper()
		var result body
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	field := &message.FieldError{Field: "mentioned_department_ids", Message: "a message may mention at most 10 departments"}

	response := httptest.NewRecorder()
	handler.messageError(response, httptest.NewRequest(standardhttp.MethodPost, "/api/v1/chats/c/messages", nil), field)
	if got := decode(t, response); response.Code != standardhttp.StatusUnprocessableEntity || got.Code != "validation_failed" || got.Details["field"] != "mentioned_department_ids" {
		t.Fatalf("message: %d %+v", response.Code, got)
	}

	cases := []struct {
		err    error
		status int
		code   string
		field  string
	}{
		{request.ErrAudienceForbidden, standardhttp.StatusForbidden, "request_audience_forbidden", ""},
		{request.ErrDepartmentMissing, standardhttp.StatusNotFound, "department_not_found", ""},
		{request.ErrPositionMissing, standardhttp.StatusNotFound, "position_not_found", ""},
		{field, standardhttp.StatusUnprocessableEntity, "request_invalid", "mentioned_department_ids"},
	}
	for _, item := range cases {
		response := httptest.NewRecorder()
		handler.requestError(response, httptest.NewRequest(standardhttp.MethodPost, "/api/v1/chats/c/requests", nil), item.err)
		got := decode(t, response)
		if response.Code != item.status || got.Code != item.code || (item.field != "" && got.Details["field"] != item.field) {
			t.Fatalf("%v: %d %+v", item.err, response.Code, got)
		}
	}
}
