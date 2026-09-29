package relay

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Notification is what the relay forwards: ciphertext for the app and a
// neutral text for when it cannot be decrypted.
type Notification struct {
	Ciphertext    string
	FallbackTitle string
	FallbackBody  string
	CollapseID    string
}

type Sender interface {
	Send(ctx context.Context, token string, notification Notification) error
}

const (
	APNsProduction = "https://api.push.apple.com"
	APNsSandbox    = "https://api.sandbox.push.apple.com"
)

// APNs sends through Apple's HTTP/2 provider API with a token-based (.p8) key.
type APNs struct {
	client  *http.Client
	baseURL string
	keyID   string
	teamID  string
	topic   string
	key     *ecdsa.PrivateKey
	now     func() time.Time

	mu        sync.Mutex
	jwt       string
	jwtIssued time.Time
}

func ParseAPNsKey(pemBytes []byte) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("APNs key is not PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("APNs key is not an ECDSA key")
	}
	return key, nil
}

func NewAPNs(client *http.Client, baseURL, keyID, teamID, topic string, key *ecdsa.PrivateKey) *APNs {
	return &APNs{client: client, baseURL: baseURL, keyID: keyID, teamID: teamID, topic: topic, key: key, now: time.Now}
}

// providerToken is reused for up to 50 minutes; Apple rejects tokens older
// than an hour and throttles refreshing more often than every 20 minutes.
func (a *APNs) providerToken() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	if a.jwt != "" && now.Sub(a.jwtIssued) < 50*time.Minute {
		return a.jwt, nil
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{"iss": a.teamID, "iat": now.Unix()})
	token.Header["kid"] = a.keyID
	signed, err := token.SignedString(a.key)
	if err != nil {
		return "", err
	}
	a.jwt, a.jwtIssued = signed, now
	return signed, nil
}

func (a *APNs) Send(ctx context.Context, deviceToken string, notification Notification) error {
	body, err := json.Marshal(map[string]any{
		"aps": map[string]any{
			"alert":           map[string]string{"title": notification.FallbackTitle, "body": notification.FallbackBody},
			"sound":           "default",
			"mutable-content": 1,
		},
		// The Notification Service Extension replaces the alert with the decrypted content.
		"c": notification.Ciphertext,
	})
	if err != nil {
		return err
	}
	providerToken, err := a.providerToken()
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/3/device/"+deviceToken, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("authorization", "bearer "+providerToken)
	request.Header.Set("apns-topic", a.topic)
	request.Header.Set("apns-push-type", "alert")
	request.Header.Set("apns-priority", "10")
	if notification.CollapseID != "" {
		request.Header.Set("apns-collapse-id", notification.CollapseID)
	}
	response, err := a.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusOK {
		return nil
	}
	var failure struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&failure)
	if response.StatusCode == http.StatusGone || failure.Reason == "BadDeviceToken" || failure.Reason == "Unregistered" || failure.Reason == "DeviceTokenNotForTopic" {
		return ErrUnknownHandle
	}
	return fmt.Errorf("APNs responded %d %s", response.StatusCode, failure.Reason)
}
