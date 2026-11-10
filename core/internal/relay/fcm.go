package relay

import (
	"bytes"
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	FCMEndpoint    = "https://fcm.googleapis.com"
	GoogleTokenURL = "https://oauth2.googleapis.com/token"
)

// ServiceAccount is the subset of a Google service account JSON key FCM needs.
type ServiceAccount struct {
	ProjectID   string `json:"project_id"`
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
	TokenURI    string `json:"token_uri"`
}

// FCM sends data-only messages through the HTTP v1 API, so the app decrypts
// the payload and builds the notification itself.
type FCM struct {
	client  *http.Client
	baseURL string
	account ServiceAccount
	key     *rsa.PrivateKey
	now     func() time.Time

	mu          sync.Mutex
	accessToken string
	expiresAt   time.Time
}

func NewFCM(client *http.Client, baseURL string, account ServiceAccount) (*FCM, error) {
	block, _ := pem.Decode([]byte(account.PrivateKey))
	if block == nil {
		return nil, errors.New("FCM service account key is not PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("FCM service account key is not RSA")
	}
	if account.TokenURI == "" {
		account.TokenURI = GoogleTokenURL
	}
	return &FCM{client: client, baseURL: baseURL, account: account, key: key, now: time.Now}, nil
}

// token exchanges a signed service-account assertion for an OAuth access token.
func (f *FCM) token(ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	if f.accessToken != "" && now.Before(f.expiresAt.Add(-time.Minute)) {
		return f.accessToken, nil
	}
	assertion, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iss": f.account.ClientEmail, "scope": "https://www.googleapis.com/auth/firebase.messaging",
		"aud": f.account.TokenURI, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
	}).SignedString(f.key)
	if err != nil {
		return "", err
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {assertion}}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, f.account.TokenURI, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := f.client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	var result struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<16)).Decode(&result); err != nil || response.StatusCode != http.StatusOK || result.AccessToken == "" {
		return "", fmt.Errorf("google token endpoint responded %d", response.StatusCode)
	}
	f.accessToken, f.expiresAt = result.AccessToken, now.Add(time.Duration(result.ExpiresIn)*time.Second)
	return f.accessToken, nil
}

func (f *FCM) Send(ctx context.Context, deviceToken string, notification Notification) error {
	accessToken, err := f.token(ctx)
	if err != nil {
		return err
	}
	android := map[string]any{"priority": "HIGH"}
	if notification.CollapseID != "" {
		android["collapse_key"] = notification.CollapseID
	}
	body, err := json.Marshal(map[string]any{"message": map[string]any{
		"token": deviceToken,
		"data": map[string]string{
			"c": notification.Ciphertext, "title": notification.FallbackTitle, "body": notification.FallbackBody,
		},
		"android": android,
	}})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		f.baseURL+"/v1/projects/"+url.PathEscape(f.account.ProjectID)+"/messages:send", bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Content-Type", "application/json")
	response, err := f.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusOK {
		return nil
	}
	var failure struct {
		Error struct {
			Status  string `json:"status"`
			Details []struct {
				ErrorCode string `json:"errorCode"`
			} `json:"details"`
		} `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(response.Body, 1<<16)).Decode(&failure)
	for _, detail := range failure.Error.Details {
		// INVALID_ARGUMENT may also mean a bad payload, so only UNREGISTERED drops a device.
		if detail.ErrorCode == "UNREGISTERED" {
			return ErrUnknownHandle
		}
	}
	if response.StatusCode == http.StatusNotFound {
		return ErrUnknownHandle
	}
	return fmt.Errorf("FCM responded %d %s", response.StatusCode, failure.Error.Status)
}
