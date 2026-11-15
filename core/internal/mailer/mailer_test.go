package mailer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/mailrelay"
	"github.com/comamessenger/comamessenger/core/internal/mailtemplate"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/comamessenger/comamessenger/core/internal/workspace"
	"github.com/google/uuid"
)

const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd"

type provider struct {
	mu     sync.Mutex
	sent   []mailrelay.Envelope
	broken bool
}

func (p *provider) Send(_ context.Context, envelope mailrelay.Envelope) (mailrelay.ProviderResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.broken {
		return mailrelay.ProviderResult{}, &mailrelay.ProviderError{Kind: "unavailable", Status: 500}
	}
	p.sent = append(p.sent, envelope)
	return mailrelay.ProviderResult{ID: uuid.NewString()}, nil
}

func (p *provider) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.sent)
}

// challengeVerifier asks the mailer directly, standing in for the HTTPS
// request the relay makes to the installation.
type challengeVerifier struct{ mailer **Mailer }

func (v challengeVerifier) Challenge(ctx context.Context, _ string) (string, string, error) {
	id, challenge, ok := (*v.mailer).Challenge(ctx)
	if !ok {
		return "", "", errors.New("no challenge")
	}
	return id, challenge, nil
}

func setup(t *testing.T) (*Mailer, *provider, string) {
	t.Helper()
	pool := testdb.New(t)
	ctx := context.Background()
	orgID := uuid.NewString()
	ownerID := uuid.NewString()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Ромашка','romashka')`, []any{orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'user','owner','Owner','owner')`, []any{ownerID, orgID}},
		{`INSERT INTO users(actor_id,org_id,email,password_hash,preferences) VALUES($1,$2,'boris@example.com','hash','{"locale":"en"}')`, []any{ownerID, orgID}},
	} {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	ws, err := workspace.NewService(workspace.NewRepository(pool), strings.Repeat("k", 32), nil)
	if err != nil {
		t.Fatal(err)
	}
	store := mailrelay.NewStore(pool)
	if err := store.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	fake := &provider{}
	var mailer *Mailer
	relay := mailrelay.NewServer(slog.New(slog.NewTextHandler(io.Discard, nil)), mailrelay.Options{
		Store: store, Provider: fake, Verifier: challengeVerifier{&mailer}, Limits: mailrelay.DefaultLimits(),
		HashSecret: []byte(strings.Repeat("h", 32)), FromAddress: "no-reply@coma-chat.com", AllowInsecureOrigins: true,
	})
	server := httptest.NewServer(relay.Handler())
	t.Cleanup(server.Close)
	mailer = New(slog.New(slog.NewTextHandler(io.Discard, nil)), pool, ws, server.URL, "https://chat.example.ru", server.Client())
	ws.SetMailStatusSource(mailer)
	return mailer, fake, orgID
}

func invitation(to string) mailtemplate.Message {
	expires := time.Now().Add(72 * time.Hour)
	return mailtemplate.Message{Kind: mailtemplate.Invitation, To: to, Data: mailtemplate.Data{
		Link: "https://chat.example.ru/invite/" + token, Role: "member", ExpiresAt: &expires, InviterName: "Иван"}}
}

func reset(to string) mailtemplate.Message {
	return mailtemplate.Message{Kind: mailtemplate.PasswordReset, To: to, Data: mailtemplate.Data{Link: "https://chat.example.ru/reset-password?token=" + token}}
}

func TestComaMailEndToEnd(t *testing.T) {
	mailer, fake, orgID := setup(t)
	ctx := context.Background()
	if configured, _ := mailer.EmailConfigured(ctx, orgID); configured {
		t.Fatal("email configured before registration")
	}
	if err := mailer.ensureRegistration(ctx); err != nil {
		t.Fatal(err)
	}
	if configured, err := mailer.EmailConfigured(ctx, orgID); err != nil || !configured {
		t.Fatalf("configured = %v, %v", configured, err)
	}
	if err := mailer.Send(ctx, orgID, invitation("anna@example.com")); err != nil {
		t.Fatal(err)
	}
	if fake.count() != 1 || fake.sent[0].FromName != "Ромашка через Coma" || !strings.Contains(fake.sent[0].Text, "Иван приглашает") {
		t.Fatalf("letter = %+v", fake.sent)
	}
	status := mailer.ComaStatus(ctx)
	if status.State != "active" || status.Used == nil || *status.Used != 1 || *status.DailyLimit != 100 || status.PerRecipientLimit != 6 {
		t.Fatalf("status = %+v", status)
	}

	// A provider outage queues the letter; the retry sends it once.
	fake.mu.Lock()
	fake.broken = true
	fake.mu.Unlock()
	if err := mailer.Send(ctx, orgID, reset("boris@example.com")); err != nil {
		t.Fatalf("temporary failure surfaced: %v", err)
	}
	var queued int
	var payload []byte
	if err := mailer.pool.QueryRow(ctx, `SELECT count(*) OVER (),payload FROM mail_outbox LIMIT 1`).Scan(&queued, &payload); err != nil || queued != 1 {
		t.Fatalf("outbox = %d, %v", queued, err)
	}
	if strings.Contains(string(payload), token) || strings.Contains(string(payload), "boris") {
		t.Fatal("queued letter is stored in clear")
	}
	fake.mu.Lock()
	fake.broken = false
	fake.mu.Unlock()
	if _, err := mailer.pool.Exec(ctx, `UPDATE mail_outbox SET available_at=now()`); err != nil {
		t.Fatal(err)
	}
	if err := mailer.processOutbox(ctx); err != nil {
		t.Fatal(err)
	}
	if err := mailer.pool.QueryRow(ctx, `SELECT count(*) FROM mail_outbox`).Scan(&queued); err != nil || queued != 0 || fake.count() != 2 {
		t.Fatalf("after retry: outbox %d, sent %d", queued, fake.count())
	}
	// The recipient's own language is used: Boris reads English.
	if !strings.HasPrefix(fake.sent[1].Subject, "Password reset") {
		t.Fatalf("subject = %q", fake.sent[1].Subject)
	}

	// Limits are final, not retried.
	for index := 0; index < 2; index++ {
		if err := mailer.Send(ctx, orgID, reset("boris@example.com")); err != nil {
			t.Fatal(err)
		}
	}
	if err := mailer.Send(ctx, orgID, reset("boris@example.com")); !errors.Is(err, ErrLimit) {
		t.Fatalf("fourth reset = %v", err)
	}
	// A link outside the installation's address is refused for good.
	foreign := reset("boris@example.com")
	foreign.Kind = mailtemplate.EmailConfirmation
	foreign.Data.Link = "https://evil.example/settings/security?email_token=" + token
	if err := mailer.Send(ctx, orgID, foreign); !errors.Is(err, ErrRejected) {
		t.Fatalf("foreign link = %v", err)
	}
}

func TestRevokedInstallationStopsComaMail(t *testing.T) {
	mailer, _, orgID := setup(t)
	ctx := context.Background()
	if err := mailer.ensureRegistration(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := mailer.pool.Exec(ctx, `UPDATE mail_installations SET status='revoked',status_reason='operator'`); err != nil {
		t.Fatal(err)
	}
	if err := mailer.Send(ctx, orgID, reset("a@example.com")); !errors.Is(err, ErrRejected) {
		t.Fatalf("send after revoke = %v", err)
	}
	if status := mailer.ComaStatus(ctx); status.State != "revoked" {
		t.Fatalf("status = %+v", status)
	}
	mailer.forgetState()
	if configured, _ := mailer.EmailConfigured(ctx, orgID); configured {
		t.Fatal("revoked installation still reported as configured")
	}
}

func TestComaMailNeedsPublicHTTPS(t *testing.T) {
	for _, appURL := range []string{"http://localhost:5173", "https://localhost", "https://10.0.0.4"} {
		mailer := New(slog.Default(), nil, nil, "https://mail.coma-chat.com", appURL, nil)
		if mailer.relayUsable() != "public_https_required" {
			t.Errorf("%s: %q", appURL, mailer.relayUsable())
		}
	}
	if reason := New(slog.Default(), nil, nil, "", "https://chat.example.ru", nil).relayUsable(); reason != "relay_disabled" {
		t.Fatal(reason)
	}
	if reason := New(slog.Default(), nil, nil, "https://mail.coma-chat.com", "https://chat.example.ru", nil).relayUsable(); reason != "" {
		t.Fatal(reason)
	}
	_ = fmt.Sprint(http.StatusOK)
}
