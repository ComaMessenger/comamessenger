package relay

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/golang-jwt/jwt/v5"
)

func TestAPNsSignsRequestsAndMapsUnregisteredTokens(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	status, reason := http.StatusOK, ""
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/3/device/device-token" || r.Header.Get("apns-topic") != "app.coma" || r.Header.Get("apns-collapse-id") != "chat" {
			t.Errorf("request = %s %v", r.URL.Path, r.Header)
		}
		token, err := jwt.Parse(strings.TrimPrefix(r.Header.Get("authorization"), "bearer "), func(*jwt.Token) (any, error) {
			return &key.PublicKey, nil
		}, jwt.WithValidMethods([]string{"ES256"}))
		if err != nil || token.Header["kid"] != "KEY123" || token.Claims.(jwt.MapClaims)["iss"] != "TEAM123" {
			t.Errorf("provider token = %v %v", token, err)
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.WriteHeader(status)
		if reason != "" {
			_, _ = io.WriteString(w, `{"reason":"`+reason+`"}`)
		}
	}))
	defer server.Close()
	apns := NewAPNs(server.Client(), server.URL, "KEY123", "TEAM123", "app.coma", key)
	notification := Notification{Ciphertext: "sealed", FallbackTitle: "Coma", FallbackBody: "New message", CollapseID: "chat"}
	if err := apns.Send(context.Background(), "device-token", notification); err != nil {
		t.Fatal(err)
	}
	aps := body["aps"].(map[string]any)
	if body["c"] != "sealed" || aps["mutable-content"] != float64(1) {
		t.Fatalf("APNs body = %v", body)
	}
	status, reason = http.StatusBadRequest, "BadDeviceToken"
	if err := apns.Send(context.Background(), "device-token", notification); !errors.Is(err, ErrUnknownHandle) {
		t.Fatalf("bad token error = %v", err)
	}
	status, reason = http.StatusTooManyRequests, "TooManyRequests"
	if err := apns.Send(context.Background(), "device-token", notification); err == nil || errors.Is(err, ErrUnknownHandle) {
		t.Fatalf("throttled error = %v", err)
	}
}

func TestFCMExchangesTokenAndSendsDataMessages(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := x509.MarshalPKCS8PrivateKey(key)
	privatePEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}))
	tokenRequests, unregistered := 0, false
	var message map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			tokenRequests++
			_ = r.ParseForm()
			if _, err := jwt.Parse(r.Form.Get("assertion"), func(*jwt.Token) (any, error) { return &key.PublicKey, nil }); err != nil {
				t.Errorf("assertion: %v", err)
			}
			_, _ = io.WriteString(w, `{"access_token":"access","expires_in":3600}`)
		case "/v1/projects/coma-app/messages:send":
			if r.Header.Get("Authorization") != "Bearer access" {
				t.Errorf("authorization = %q", r.Header.Get("Authorization"))
			}
			_ = json.NewDecoder(r.Body).Decode(&message)
			if unregistered {
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, `{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`)
			}
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()
	fcm, err := NewFCM(server.Client(), server.URL, ServiceAccount{
		ProjectID: "coma-app", ClientEmail: "relay@coma-app.iam", PrivateKey: privatePEM, TokenURI: server.URL + "/token",
	})
	if err != nil {
		t.Fatal(err)
	}
	notification := Notification{Ciphertext: "sealed", FallbackTitle: "Coma", FallbackBody: "New message"}
	for range 2 {
		if err := fcm.Send(context.Background(), "fcm-token", notification); err != nil {
			t.Fatal(err)
		}
	}
	data := message["message"].(map[string]any)["data"].(map[string]any)
	if tokenRequests != 1 || data["c"] != "sealed" {
		t.Fatalf("token requests = %d, data = %v", tokenRequests, data)
	}
	if _, hasNotification := message["message"].(map[string]any)["notification"]; hasNotification {
		t.Fatal("FCM message must be data-only so the app can decrypt it")
	}
	unregistered = true
	if err := fcm.Send(context.Background(), "fcm-token", notification); !errors.Is(err, ErrUnknownHandle) {
		t.Fatalf("unregistered error = %v", err)
	}
}

type fakeSender struct {
	tokens []string
	err    error
}

func (f *fakeSender) Send(_ context.Context, token string, _ Notification) error {
	f.tokens = append(f.tokens, token)
	return f.err
}

func TestServerRegistersSendsAndForgetsDevices(t *testing.T) {
	store := NewStore(testdb.New(t))
	ctx := context.Background()
	if err := store.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	ios := &fakeSender{}
	server := httptest.NewServer(NewServer(slog.New(slog.NewTextHandler(io.Discard, nil)), store, map[string]Sender{"ios": ios}).Handler())
	defer server.Close()
	call := func(method, path string, body any) *http.Response {
		t.Helper()
		encoded, _ := json.Marshal(body)
		request, _ := http.NewRequest(method, server.URL+path, bytes.NewReader(encoded))
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	if response := call(http.MethodPost, "/v1/devices", map[string]string{"platform": "android", "token": "android-token"}); response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("unconfigured platform status = %d", response.StatusCode)
	}
	response := call(http.MethodPost, "/v1/devices", map[string]string{"platform": "ios", "token": "first-token"})
	var created struct {
		Handle string `json:"handle"`
	}
	_ = json.NewDecoder(response.Body).Decode(&created)
	if response.StatusCode != http.StatusCreated || !handlePattern.MatchString(created.Handle) {
		t.Fatalf("create = %d %q", response.StatusCode, created.Handle)
	}
	if response := call(http.MethodPut, "/v1/devices/"+created.Handle, map[string]string{"token": "rotated-token"}); response.StatusCode != http.StatusNoContent {
		t.Fatalf("rotate status = %d", response.StatusCode)
	}
	send := map[string]string{"handle": created.Handle, "ciphertext": "sealed", "fallback_title": "Coma", "fallback_body": "New message"}
	if response := call(http.MethodPost, "/v1/send", send); response.StatusCode != http.StatusAccepted || ios.tokens[0] != "rotated-token" {
		t.Fatalf("send = %d %v", response.StatusCode, ios.tokens)
	}
	ios.err = ErrUnknownHandle
	if response := call(http.MethodPost, "/v1/send", send); response.StatusCode != http.StatusGone {
		t.Fatalf("send to unregistered token = %d", response.StatusCode)
	}
	ios.err = nil
	if response := call(http.MethodPost, "/v1/send", send); response.StatusCode != http.StatusGone || len(ios.tokens) != 2 {
		t.Fatalf("forgotten handle = %d, provider calls %d", response.StatusCode, len(ios.tokens))
	}
}
