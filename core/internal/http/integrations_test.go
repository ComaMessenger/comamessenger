package http

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	standardhttp "net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/comamessenger/comamessenger/core/internal/webhook"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func TestPublicWebhookEndpointVerifiesSignatureWithoutSession(t *testing.T) {
	pool := testdb.New(t)
	orgID, ownerID := uuid.NewString(), uuid.NewString()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `INSERT INTO organizations(id,name,slug) VALUES($1,'Hooks','hooks')`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'user','owner','Owner','owner')`, ownerID, orgID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	service, err := webhook.NewService(pool, "0123456789abcdef0123456789abcdef", nil)
	if err != nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: ownerID, OrgID: orgID, OrgRole: "owner", Permissions: permission.Effective("owner", nil)}
	created, err := service.Create(t.Context(), owner, webhook.CreateInput{Name: "Учёт"})
	if err != nil {
		t.Fatal(err)
	}
	handlers := &identityHandlers{logger: slog.New(slog.NewTextHandler(io.Discard, nil)), webhooks: service, webhookRate: newIPRateLimiter(600, 100)}
	router := chi.NewRouter()
	router.Post("/api/v1/hooks/{webhookID}", handlers.receiveWebhook)
	send := func(secret, delivery string) (int, map[string]any) {
		body := []byte(`{"slot_id":"s-2"}`)
		timestamp := strconv.FormatInt(time.Now().Unix(), 10)
		request := httptest.NewRequest(standardhttp.MethodPost, "/api/v1/hooks/"+created.ID, bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Coma-Timestamp", timestamp)
		request.Header.Set("X-Coma-Delivery", delivery)
		request.Header.Set("X-Coma-Signature", webhook.Sign(secret, timestamp, delivery, body))
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		var decoded map[string]any
		_ = json.Unmarshal(recorder.Body.Bytes(), &decoded)
		return recorder.Code, decoded
	}
	if status, body := send(created.Secret, "delivery-1"); status != standardhttp.StatusAccepted || body["status"] != "accepted" {
		t.Fatalf("accepted = %d %v", status, body)
	}
	if status, body := send("whsec_forged", "delivery-2"); status != standardhttp.StatusUnauthorized || body["code"] != "webhook_rejected" || !strings.Contains(body["message"].(string), "invalid_signature") {
		t.Fatalf("forged = %d %v", status, body)
	}
	if status, body := send(created.Secret, "delivery-1"); status != standardhttp.StatusOK || body["status"] != "duplicate" {
		t.Fatalf("replay = %d %v", status, body)
	}
}
