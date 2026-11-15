package mailrelay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/netguard"
)

// ChallengePath is where an installation publishes its registration
// challenge, relative to its public address.
const ChallengePath = "/api/v1/mail-relay/challenge"

// PublicOrigin rejects addresses the relay must never call: internal names,
// private, loopback, link-local and metadata addresses.
func PublicOrigin(appURL *url.URL) error {
	if _, _, err := (netguard.Policy{}).ForURL(appURL.String()); err != nil {
		return fmt.Errorf("app_url must be a public address: %w", err)
	}
	return nil
}

// HTTPVerifier reads the challenge over HTTPS through netguard: no
// redirects, no proxies, every resolved address checked at dial time.
type HTTPVerifier struct {
	// Insecure allows http and private networks; tests and local runs only.
	Insecure bool
	Client   *http.Client
}

func (v HTTPVerifier) Challenge(ctx context.Context, appURL string) (string, string, error) {
	base, err := NormalizeAppURL(appURL, v.Insecure)
	if err != nil {
		return "", "", err
	}
	client := v.Client
	if client == nil && v.Insecure {
		client = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	if client == nil {
		policy, _, err := (netguard.Policy{}).ForURL(base.String())
		if err != nil {
			return "", "", err
		}
		client = policy.Client(10 * time.Second)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String()+ChallengePath, nil)
	if err != nil {
		return "", "", err
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return "", "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("challenge status %d", response.StatusCode)
	}
	var body struct {
		InstallationID string `json:"installation_id"`
		Challenge      string `json:"challenge"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<10)).Decode(&body); err != nil {
		return "", "", errors.New("challenge body is not JSON")
	}
	return body.InstallationID, body.Challenge, nil
}
