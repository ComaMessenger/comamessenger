package mailrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/mailtemplate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	raw := os.Getenv("TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("mail_relay_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+name); err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(raw)
	parsed.Path = "/" + name
	pool, err := pgxpool.New(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(context.Background(), `DROP DATABASE `+name+` WITH (FORCE)`)
		admin.Close(context.Background())
	})
	store := NewStore(pool)
	if err := store.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureSchema(ctx); err != nil {
		t.Fatalf("schema is not idempotent: %v", err)
	}
	return store
}

// fakeRuSender records requests the way RuSender's API would receive them.
type fakeRuSender struct {
	mu       sync.Mutex
	requests []map[string]any
	headers  []http.Header
	status   int
	body     string
}

func (f *fakeRuSender) server(t *testing.T) *httptest.Server {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/public/emails" || r.Method != http.MethodPost {
			t.Errorf("unexpected provider call %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.requests = append(f.requests, body)
		f.headers = append(f.headers, r.Header.Clone())
		status, response := f.status, f.body
		count := len(f.requests)
		f.mu.Unlock()
		if status == 0 {
			status = http.StatusAccepted
			response = fmt.Sprintf(`{"ok":true,"data":{"id":"00000000-0000-0000-0000-%012d","status":"queued","recipients":[{"status":"queued"}]}}`, count)
		}
		w.Header().Set("Content-Type", "application/json")
		if status == http.StatusTooManyRequests {
			w.Header().Set("Retry-After", "7")
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, response)
	}))
	t.Cleanup(server.Close)
	return server
}

func (f *fakeRuSender) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

type fakeVerifier struct {
	mu        sync.Mutex
	published map[string][2]string
}

func (v *fakeVerifier) Challenge(_ context.Context, appURL string) (string, string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	value, ok := v.published[appURL]
	if !ok {
		return "", "", fmt.Errorf("not found")
	}
	return value[0], value[1], nil
}

type harness struct {
	t        *testing.T
	store    *Store
	provider *fakeRuSender
	verifier *fakeVerifier
	handler  http.Handler
	server   *Server
	now      time.Time
}

func newHarness(t *testing.T) *harness {
	h := &harness{t: t, store: testStore(t), provider: &fakeRuSender{}, verifier: &fakeVerifier{published: map[string][2]string{}}, now: time.Now()}
	provider := h.provider.server(t)
	server := NewServer(slog.New(slog.NewTextHandler(io.Discard, nil)), Options{
		Store: h.store, Provider: NewRuSender(provider.Client(), provider.URL, "rs_ck_v1_test", 12345), Verifier: h.verifier,
		Limits: DefaultLimits(), HashSecret: []byte(strings.Repeat("s", 32)), WebhookSecret: "webhook-secret-0123456789abcdef",
		FromAddress: "no-reply@coma-chat.com", Now: func() time.Time { return h.now },
	})
	server.register = newLimiter(6000, 1000)
	h.server = server
	h.handler = server.Handler()
	return h
}

func (h *harness) do(method, path, key, idempotency string, body any) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != nil {
		if raw, ok := body.(string); ok {
			reader = strings.NewReader(raw)
		} else {
			encoded, _ := json.Marshal(body)
			reader = bytes.NewReader(encoded)
		}
	}
	request := httptest.NewRequest(method, path, reader)
	request.RemoteAddr = "203.0.113.10:5555"
	if key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	if idempotency != "" {
		request.Header.Set("Idempotency-Key", idempotency)
	}
	recorder := httptest.NewRecorder()
	h.handler.ServeHTTP(recorder, request)
	return recorder
}

// install registers and verifies an installation for appURL.
func (h *harness) install(appURL string) (string, string) {
	h.t.Helper()
	response := h.do(http.MethodPost, "/v1/installations", "", "", map[string]string{"app_url": appURL})
	if response.Code != http.StatusCreated {
		h.t.Fatalf("register: %d %s", response.Code, response.Body)
	}
	var created struct{ InstallationID, Key, Challenge string }
	_ = json.Unmarshal(response.Body.Bytes(), &struct {
		ID        *string `json:"installation_id"`
		Key       *string `json:"key"`
		Challenge *string `json:"challenge"`
	}{&created.InstallationID, &created.Key, &created.Challenge})
	h.verifier.mu.Lock()
	h.verifier.published[appURL] = [2]string{created.InstallationID, created.Challenge}
	h.verifier.mu.Unlock()
	if response := h.do(http.MethodPost, "/v1/installations/verify", created.Key, "", nil); response.Code != http.StatusOK {
		h.t.Fatalf("verify: %d %s", response.Code, response.Body)
	}
	return created.InstallationID, created.Key
}

const linkToken = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd"

func resetMessage(to string) mailtemplate.Message {
	return mailtemplate.Message{Kind: mailtemplate.PasswordReset, To: to, Locale: "ru", WorkspaceName: "Ромашка",
		Data: mailtemplate.Data{Link: "https://chat.example.ru/reset-password?token=" + linkToken}}
}

func inviteMessage(to string) mailtemplate.Message {
	expires := time.Now().Add(72 * time.Hour)
	return mailtemplate.Message{Kind: mailtemplate.Invitation, To: to, Locale: "ru", WorkspaceName: "Ромашка",
		Data: mailtemplate.Data{Link: "https://chat.example.ru/invite/" + linkToken, Role: "member", ExpiresAt: &expires}}
}

var sequence atomic.Int64

func nextKey() string { return fmt.Sprintf("idem-%d-%d", time.Now().UnixNano(), sequence.Add(1)) }

func TestRegistrationRequiresPublicHTTPS(t *testing.T) {
	h := newHarness(t)
	for _, appURL := range []string{"http://chat.example.ru", "https://localhost", "https://127.0.0.1", "https://10.0.0.5", "https://169.254.169.254", "https://chat.example.ru?x=1", "https://u:p@chat.example.ru"} {
		if response := h.do(http.MethodPost, "/v1/installations", "", "", map[string]string{"app_url": appURL}); response.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", appURL, response.Code)
		}
	}
}

func TestPendingInstallationCannotSend(t *testing.T) {
	h := newHarness(t)
	response := h.do(http.MethodPost, "/v1/installations", "", "", map[string]string{"app_url": "https://chat.example.ru"})
	var created map[string]string
	_ = json.Unmarshal(response.Body.Bytes(), &created)
	if response := h.do(http.MethodPost, "/v1/messages", created["key"], nextKey(), resetMessage("a@b.ru")); response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "installation_pending") {
		t.Fatalf("pending send: %d %s", response.Code, response.Body)
	}
	// A wrong challenge (an attacker claiming someone else's address) fails.
	h.verifier.published["https://chat.example.ru"] = [2]string{created["installation_id"], "other"}
	if response := h.do(http.MethodPost, "/v1/installations/verify", created["key"], "", nil); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("verify with wrong challenge: %d", response.Code)
	}
	if h.provider.count() != 0 {
		t.Fatal("provider was called")
	}
}

func TestSendRendersOwnTemplate(t *testing.T) {
	h := newHarness(t)
	_, key := h.install("https://chat.example.ru")
	idempotency := nextKey()
	invite := inviteMessage("Anna@Example.com")
	response := h.do(http.MethodPost, "/v1/messages", key, idempotency, invite)
	if response.Code != http.StatusAccepted {
		t.Fatalf("send: %d %s", response.Code, response.Body)
	}
	data := h.provider.requests[0]["data"].(map[string]any)
	from := data["from"].(map[string]any)
	if from["email"] != "no-reply@coma-chat.com" || from["name"] != "Ромашка через Coma" {
		t.Fatalf("from: %v", from)
	}
	if data["to"].(map[string]any)["email"] != "anna@example.com" || data["keyId"].(float64) != 12345 {
		t.Fatalf("to/keyId: %v", data)
	}
	if !strings.Contains(data["text"].(string), "https://chat.example.ru/invite/"+linkToken) || data["html"] == "" {
		t.Fatal("letter is not rendered from the template")
	}
	if h.provider.headers[0].Get("Authorization") != "Bearer rs_ck_v1_test" || h.provider.headers[0].Get("Idempotency-Key") == "" {
		t.Fatal("provider headers")
	}
	// The same request again is a replay: no second letter.
	invite.To = "anna@example.com"
	replay := h.do(http.MethodPost, "/v1/messages", key, idempotency, invite)
	if replay.Code != http.StatusAccepted || replay.Header().Get("Idempotency-Replayed") != "true" || h.provider.count() != 1 {
		t.Fatalf("replay: %d %v %d", replay.Code, replay.Header(), h.provider.count())
	}
	other := resetMessage("anna@example.com")
	if conflict := h.do(http.MethodPost, "/v1/messages", key, idempotency, other); conflict.Code != http.StatusConflict {
		t.Fatalf("conflict: %d", conflict.Code)
	}
}

func TestRejectsArbitraryContentAndForeignLinks(t *testing.T) {
	h := newHarness(t)
	_, key := h.install("https://chat.example.ru")
	bodies := []string{
		`{"type":"invitation","to":"a@b.ru","workspace_name":"x","data":{"link":"https://chat.example.ru/invite/` + linkToken + `","role":"member","expires_at":"2030-01-01T00:00:00Z"},"html":"<a href=evil>"}`,
		`{"type":"custom","to":"a@b.ru","workspace_name":"x","data":{}}`,
		`{"type":"password_reset","to":"a@b.ru","workspace_name":"x","data":{"link":"https://evil.example/reset-password?token=` + linkToken + `"}}`,
	}
	for _, body := range bodies {
		if response := h.do(http.MethodPost, "/v1/messages", key, nextKey(), body); response.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", body, response.Code)
		}
	}
	if h.provider.count() != 0 {
		t.Fatal("provider was called")
	}
	if response := h.do(http.MethodPost, "/v1/messages", "cmr_"+strings.Repeat("A", 43), nextKey(), resetMessage("a@b.ru")); response.Code != http.StatusUnauthorized {
		t.Fatalf("forged key: %d", response.Code)
	}
}

func TestRecipientLimits(t *testing.T) {
	h := newHarness(t)
	_, key := h.install("https://chat.example.ru")
	// Three resets reach the per-type limit.
	for index := 0; index < 3; index++ {
		if response := h.do(http.MethodPost, "/v1/messages", key, nextKey(), resetMessage("a@b.ru")); response.Code != http.StatusAccepted {
			t.Fatalf("reset %d: %d %s", index, response.Code, response.Body)
		}
	}
	if response := h.do(http.MethodPost, "/v1/messages", key, nextKey(), resetMessage("a@b.ru")); response.Code != http.StatusTooManyRequests || !strings.Contains(response.Body.String(), "recipient_limit") {
		t.Fatalf("fourth reset: %d %s", response.Code, response.Body)
	}
	// Other types fill up to six per recipient.
	sent := 3
	for _, message := range []mailtemplate.Message{inviteMessage("a@b.ru"), inviteMessage("a@b.ru"), {Kind: mailtemplate.EmailChangeNotice, To: "a@b.ru", Locale: "ru"}} {
		if response := h.do(http.MethodPost, "/v1/messages", key, nextKey(), message); response.Code != http.StatusAccepted {
			t.Fatalf("letter %d: %d %s", sent, response.Code, response.Body)
		}
		sent++
	}
	if response := h.do(http.MethodPost, "/v1/messages", key, nextKey(), mailtemplate.Message{Kind: mailtemplate.EmailChangeNotice, To: "a@b.ru", Locale: "ru"}); response.Code != http.StatusTooManyRequests {
		t.Fatalf("seventh letter: %d", response.Code)
	}
	if h.provider.count() != 6 {
		t.Fatalf("provider got %d letters", h.provider.count())
	}
	// The window rolls: a day later the recipient can receive mail again.
	h.now = h.now.Add(25 * time.Hour)
	if response := h.do(http.MethodPost, "/v1/messages", key, nextKey(), resetMessage("a@b.ru")); response.Code != http.StatusAccepted {
		t.Fatalf("next day: %d", response.Code)
	}
}

func TestParallelRequestsDoNotPassLimit(t *testing.T) {
	h := newHarness(t)
	_, key := h.install("https://chat.example.ru")
	var wait sync.WaitGroup
	var accepted atomic.Int32
	for index := 0; index < 12; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if response := h.do(http.MethodPost, "/v1/messages", key, nextKey(), mailtemplate.Message{Kind: mailtemplate.EmailChangeNotice, To: "race@b.ru", Locale: "ru"}); response.Code == http.StatusAccepted {
				accepted.Add(1)
			}
		}()
	}
	wait.Wait()
	if accepted.Load() != 3 {
		t.Fatalf("accepted %d notices, want the per-type limit 3", accepted.Load())
	}
}

func TestInstallationAndGlobalLimits(t *testing.T) {
	h := newHarness(t)
	id, key := h.install("https://chat.example.ru")
	limit := 2
	if err := h.store.SetLimit(context.Background(), id, &limit); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 2; index++ {
		if response := h.do(http.MethodPost, "/v1/messages", key, nextKey(), resetMessage(fmt.Sprintf("u%d@b.ru", index))); response.Code != http.StatusAccepted {
			t.Fatal(response.Body)
		}
	}
	if response := h.do(http.MethodPost, "/v1/messages", key, nextKey(), resetMessage("u9@b.ru")); response.Code != http.StatusTooManyRequests || !strings.Contains(response.Body.String(), "installation_limit") {
		t.Fatalf("over installation limit: %d %s", response.Code, response.Body)
	}
	var quota map[string]any
	_ = json.Unmarshal(h.do(http.MethodGet, "/v1/quota", key, "", nil).Body.Bytes(), &quota)
	if quota["used"].(float64) != 2 || quota["daily_limit"].(float64) != 2 || quota["per_recipient_limit"].(float64) != 6 {
		t.Fatalf("quota: %v", quota)
	}
	// Re-registering the same host does not reset its spend.
	_, second := h.install("https://chat.example.ru")
	if response := h.do(http.MethodPost, "/v1/messages", key, nextKey(), resetMessage("u8@b.ru")); response.Code != http.StatusForbidden {
		t.Fatalf("replaced key still works: %d", response.Code)
	}
	_ = second
	// Many installations together cannot exceed 10 letters to one address.
	total := 0
	for index := 0; index < 6; index++ {
		_, otherKey := h.install(fmt.Sprintf("https://chat%d.example.ru", index))
		for _, message := range []mailtemplate.Message{resetMessage("victim@b.ru"), resetMessage("victim@b.ru")} {
			message.Data.Link = fmt.Sprintf("https://chat%d.example.ru/reset-password?token=%s", index, linkToken)
			if response := h.do(http.MethodPost, "/v1/messages", otherKey, nextKey(), message); response.Code == http.StatusAccepted {
				total++
			}
		}
	}
	if total != 10 {
		t.Fatalf("victim received %d letters, want 10", total)
	}
}

func TestProviderFailuresDoNotSpendLimit(t *testing.T) {
	h := newHarness(t)
	_, key := h.install("https://chat.example.ru")
	h.provider.status, h.provider.body = http.StatusTooManyRequests, `{"ok":false,"error":{"code":"RATE_LIMIT_EXCEEDED"}}`
	idempotency := nextKey()
	response := h.do(http.MethodPost, "/v1/messages", key, idempotency, mailtemplate.Message{Kind: mailtemplate.EmailChangeNotice, To: "a@b.ru", Locale: "ru"})
	if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "7" {
		t.Fatalf("rate limited: %d %v", response.Code, response.Header())
	}
	h.provider.status, h.provider.body = http.StatusInternalServerError, `{}`
	if response := h.do(http.MethodPost, "/v1/messages", key, idempotency, mailtemplate.Message{Kind: mailtemplate.EmailChangeNotice, To: "a@b.ru", Locale: "ru"}); response.Code != http.StatusBadGateway {
		t.Fatalf("provider down: %d", response.Code)
	}
	h.provider.status = 0
	for index := 0; index < 3; index++ {
		key2 := idempotency
		if index > 0 {
			key2 = nextKey()
		}
		if response := h.do(http.MethodPost, "/v1/messages", key, key2, mailtemplate.Message{Kind: mailtemplate.EmailChangeNotice, To: "a@b.ru", Locale: "ru"}); response.Code != http.StatusAccepted {
			t.Fatalf("after recovery %d: %d %s", index, response.Code, response.Body)
		}
	}
	h.provider.status, h.provider.body = http.StatusUnprocessableEntity, `{"ok":false,"error":{"code":"RECIPIENT_SUPPRESSED"}}`
	if response := h.do(http.MethodPost, "/v1/messages", key, nextKey(), resetMessage("gone@b.ru")); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("suppressed: %d", response.Code)
	}
	h.provider.status = 0
	before := h.provider.count()
	if response := h.do(http.MethodPost, "/v1/messages", key, nextKey(), resetMessage("gone@b.ru")); response.Code != http.StatusUnprocessableEntity || h.provider.count() != before {
		t.Fatalf("suppression not remembered: %d", response.Code)
	}
}

func TestComplaintsSuspendInstallation(t *testing.T) {
	h := newHarness(t)
	_, key := h.install("https://chat.example.ru")
	for index := 0; index < 3; index++ {
		if response := h.do(http.MethodPost, "/v1/messages", key, nextKey(), resetMessage(fmt.Sprintf("c%d@b.ru", index))); response.Code != http.StatusAccepted {
			t.Fatal(response.Body)
		}
	}
	if response := h.do(http.MethodPost, "/v1/webhooks/rusender/wrong", "", "", `{"events":[]}`); response.Code != http.StatusNotFound {
		t.Fatalf("wrong webhook secret: %d", response.Code)
	}
	for index := 1; index <= 3; index++ {
		body := fmt.Sprintf(`{"count":1,"events":[{"eventId":"e-%d","trigger":"email.complained","occurredAt":"2026-11-16T10:00:00Z","payload":{"emailId":"00000000-0000-0000-0000-%012d","recipient":{"email":"c%d@b.ru","type":"to"}}}]}`, index, index, index-1)
		for repeat := 0; repeat < 2; repeat++ {
			if response := h.do(http.MethodPost, "/v1/webhooks/rusender/webhook-secret-0123456789abcdef", "", "", body); response.Code != http.StatusNoContent {
				t.Fatalf("webhook: %d %s", response.Code, response.Body)
			}
		}
	}
	if response := h.do(http.MethodPost, "/v1/messages", key, nextKey(), resetMessage("new@b.ru")); response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "installation_revoked") {
		t.Fatalf("suspended installation sends: %d %s", response.Code, response.Body)
	}
	// A fresh registration for the same host stays blocked.
	if response := h.do(http.MethodPost, "/v1/installations", "", "", map[string]string{"app_url": "https://chat.example.ru"}); response.Code != http.StatusForbidden {
		t.Fatalf("re-registration of a blocked host: %d", response.Code)
	}
}

func TestRegistrationRateLimitPerIP(t *testing.T) {
	h := newHarness(t)
	h.server.register = newLimiter(5.0/60, 5)
	codes := []int{}
	for index := 0; index < 7; index++ {
		codes = append(codes, h.do(http.MethodPost, "/v1/installations", "", "", map[string]string{"app_url": fmt.Sprintf("https://r%d.example.ru", index)}).Code)
	}
	if codes[4] != http.StatusCreated || codes[5] != http.StatusTooManyRequests {
		t.Fatalf("codes %v", codes)
	}
}
