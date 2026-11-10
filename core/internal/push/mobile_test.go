package push

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
)

func openPayload(t *testing.T, key []byte, sealed string) mobilePayload {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], nil)
	if err != nil {
		t.Fatalf("open payload: %v", err)
	}
	var payload mobilePayload
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestSealPayloadUsesFreshNonces(t *testing.T) {
	key := []byte(strings.Repeat("k", 32))
	first, err := sealPayload(key, []byte(`{"v":1,"title":"T","body":"B","event_seq":1}`))
	if err != nil {
		t.Fatal(err)
	}
	second, _ := sealPayload(key, []byte(`{"v":1,"title":"T","body":"B","event_seq":1}`))
	if first == second {
		t.Fatal("sealPayload() reused a nonce")
	}
	if got := openPayload(t, key, first); got.Title != "T" || got.EventSeq != 1 {
		t.Fatalf("payload = %+v", got)
	}
}

func TestRegisterMobileDeviceRequiresRelay(t *testing.T) {
	_, err := NewService(nil, config.PushConfig{}).RegisterMobileDevice(context.Background(), identity.User{}, "", MobileDeviceInput{})
	if !errors.Is(err, ErrMobileUnavailable) {
		t.Fatalf("RegisterMobileDevice() error = %v", err)
	}
}

type recordingRelay struct {
	messages []RelayMessage
	err      error
}

func (r *recordingRelay) Send(_ context.Context, message RelayMessage) error {
	r.messages = append(r.messages, message)
	return r.err
}

func TestMobileDeliveryFollowsTheSessionFamily(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	orgID, senderID, recipientID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	chatID, familyID, rotatedID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Mobile push','mobile-push')`, []any{orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle,timezone) VALUES ($2,$1,'user','owner','Anna','anna','UTC'),($3,$1,'user','member','Lev','lev','UTC')`, []any{orgID, senderID, recipientID}},
		{`INSERT INTO users(actor_id,org_id,email,password_hash,preferences) VALUES ($2,$1,'anna@example.test','hash','{}'),($3,$1,'lev@example.test','hash','{"locale":"en"}')`, []any{orgID, senderID, recipientID}},
		// The device registers on the first session of the family, which a refresh then replaces.
		{`INSERT INTO sessions(id,org_id,actor_id,family_id,refresh_hash,expires_at) VALUES($3,$1,$2,$3,decode(repeat('01',32),'hex'),now()+interval '1 day')`, []any{orgID, recipientID, familyID}},
		{`INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($3,$1,'group','private','Design',$2)`, []any{orgID, senderID, chatID}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES ($3,$2,$1,'owner'),($3,$4,$1,'member')`, []any{orgID, senderID, chatID, recipientID}},
	} {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	cfg := config.PushConfig{RelayURL: "https://relay.example.test", PollInterval: time.Second}
	service := NewService(pool, cfg)
	recipient := identity.User{OrgID: orgID, ActorID: recipientID}
	key := []byte(strings.Repeat("s", 32))
	device, err := service.RegisterMobileDevice(ctx, recipient, familyID, MobileDeviceInput{
		Platform: "ios", RelayHandle: strings.Repeat("h", 43),
		NotificationKey: base64.StdEncoding.EncodeToString(key), AppVersion: "0.1.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.RegisterMobileDevice(ctx, recipient, familyID, MobileDeviceInput{
		Platform: "ios", RelayHandle: strings.Repeat("h", 43), NotificationKey: "short",
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("short key error = %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sessions(id,org_id,actor_id,family_id,refresh_hash,expires_at) VALUES($3,$1,$2,$4,decode(repeat('02',32),'hex'),now()+interval '1 day')`, orgID, recipientID, rotatedID, familyID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE sessions SET revoked_at=now(),replaced_by=$2 WHERE id=$1`, familyID, rotatedID); err != nil {
		t.Fatal(err)
	}

	relay := &recordingRelay{}
	worker := NewWorker(slog.New(slog.NewTextHandler(io.Discard, nil)), pool, cfg, nil).WithRelay(relay)
	send := func(t *testing.T, body string) {
		t.Helper()
		var seq int64
		if err := pool.QueryRow(ctx, `UPDATE organizations SET event_seq=event_seq+1 WHERE id=$1 RETURNING event_seq`, orgID).Scan(&seq); err != nil {
			t.Fatal(err)
		}
		messageID := uuid.NewString()
		if _, err := pool.Exec(ctx, `INSERT INTO messages(id,org_id,chat_id,actor_id,client_msg_id,create_fingerprint,body,body_format,created_seq)
			VALUES($1,$2,$3,$4,$5,decode(repeat('02',32),'hex'),$6,'plain',$7)`, messageID, orgID, chatID, senderID, uuid.NewString(), body, seq); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO events(org_id,seq,type,actor_id,chat_id,subject_id) VALUES($1,$2,'message.created',$3,$4,$5)`, orgID, seq, senderID, chatID, messageID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO notification_jobs(org_id,event_seq) VALUES($1,$2)`, orgID, seq); err != nil {
			t.Fatal(err)
		}
		if err := worker.tick(ctx); err != nil {
			t.Fatal(err)
		}
	}

	send(t, "Secret plans")
	if len(relay.messages) != 1 {
		t.Fatalf("relay messages after refresh rotation = %d", len(relay.messages))
	}
	message := relay.messages[0]
	if strings.Contains(message.Ciphertext, "Secret") || message.FallbackBody != "New message" || message.CollapseID != chatID {
		t.Fatalf("relay message leaks or misses data: %+v", message)
	}
	payload := openPayload(t, key, message.Ciphertext)
	if payload.Title != "Anna · Design" || payload.Body != "New message" || payload.URL != "/chat/"+chatID || payload.Badge != 1 {
		t.Fatalf("payload without preview = %+v", payload)
	}

	if _, err := pool.Exec(ctx, `UPDATE users SET preferences='{"locale":"en","push_preview":true}' WHERE actor_id=$1`, recipientID); err != nil {
		t.Fatal(err)
	}
	send(t, "Visible text")
	if got := openPayload(t, key, relay.messages[1].Ciphertext); got.Body != "Visible text" || got.Badge != 2 {
		t.Fatalf("payload with preview = %+v", got)
	}

	// Logout revokes the live session of the family: no more deliveries, and the device is dropped.
	if _, err := pool.Exec(ctx, `UPDATE sessions SET revoked_at=now() WHERE id=$1`, rotatedID); err != nil {
		t.Fatal(err)
	}
	send(t, "After logout")
	if len(relay.messages) != 2 {
		t.Fatalf("relay messages after logout = %d", len(relay.messages))
	}
	var devices int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM mobile_push_devices WHERE id=$1`, device.ID).Scan(&devices); err != nil {
		t.Fatal(err)
	}
	if devices != 0 {
		t.Fatal("device of a dead session family was kept")
	}
}

func TestHTTPRelayMapsResponses(t *testing.T) {
	status := http.StatusAccepted
	var received RelayMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/send" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&received)
		w.WriteHeader(status)
	}))
	defer server.Close()
	relay := NewHTTPRelay(server.URL+"/", server.Client())
	if err := relay.Send(context.Background(), RelayMessage{Handle: "h"}); err != nil || received.Handle != "h" {
		t.Fatalf("accepted send: %v, %+v", err, received)
	}
	status = http.StatusGone
	if err := relay.Send(context.Background(), RelayMessage{}); !errors.Is(err, ErrUnknownHandle) {
		t.Fatalf("gone error = %v", err)
	}
	status = http.StatusServiceUnavailable
	if err := relay.Send(context.Background(), RelayMessage{}); err == nil || errors.Is(err, ErrUnknownHandle) {
		t.Fatalf("unavailable error = %v", err)
	}
}
