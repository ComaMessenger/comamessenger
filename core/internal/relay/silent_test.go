package relay

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

func TestAPNsOmitsSoundOnlyForSilentNotifications(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body = nil
		_ = json.NewDecoder(r.Body).Decode(&body)
	}))
	defer server.Close()
	apns := NewAPNs(server.Client(), server.URL, "KEY123", "TEAM123", "app.coma", key)
	for _, silent := range []bool{false, true} {
		if err := apns.Send(context.Background(), "device-token", Notification{Ciphertext: "sealed", FallbackTitle: "Coma", FallbackBody: "New", Silent: silent}); err != nil {
			t.Fatal(err)
		}
		aps := body["aps"].(map[string]any)
		_, hasSound := aps["sound"]
		if hasSound == silent || aps["alert"] == nil || aps["mutable-content"] != float64(1) {
			t.Fatalf("silent=%v aps=%v", silent, aps)
		}
	}
}

type capturingSender struct{ notifications []Notification }

func (c *capturingSender) Send(_ context.Context, _ string, notification Notification) error {
	c.notifications = append(c.notifications, notification)
	return nil
}

// The relay accepts the optional field and keeps working for cores that do
// not send it.
func TestServerForwardsSilent(t *testing.T) {
	store := NewStore(testdb.New(t))
	ctx := context.Background()
	if err := store.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	ios := &capturingSender{}
	server := httptest.NewServer(NewServer(slog.New(slog.NewTextHandler(io.Discard, nil)), store, map[string]Sender{"ios": ios}).Handler())
	defer server.Close()
	post := func(path string, body any) *http.Response {
		encoded, _ := json.Marshal(body)
		response, err := server.Client().Post(server.URL+path, "application/json", bytes.NewReader(encoded))
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	var created struct {
		Handle string `json:"handle"`
	}
	_ = json.NewDecoder(post("/v1/devices", map[string]string{"platform": "ios", "token": "device-token"}).Body).Decode(&created)
	base := map[string]any{"handle": created.Handle, "ciphertext": "sealed", "fallback_title": "Coma", "fallback_body": "New"}
	if response := post("/v1/send", base); response.StatusCode != http.StatusAccepted {
		t.Fatalf("send without silent = %d", response.StatusCode)
	}
	base["silent"] = true
	if response := post("/v1/send", base); response.StatusCode != http.StatusAccepted {
		t.Fatalf("send with silent = %d", response.StatusCode)
	}
	if len(ios.notifications) != 2 || ios.notifications[0].Silent || !ios.notifications[1].Silent {
		t.Fatalf("notifications = %+v", ios.notifications)
	}
}
