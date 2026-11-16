package mailrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Envelope is one letter for the delivery provider.
type Envelope struct {
	IdempotencyKey string
	FromAddress    string
	FromName       string
	To             string
	Subject        string
	Preview        string
	Text           string
	HTML           string
}

// ProviderResult is a provider's answer for an accepted letter.
type ProviderResult struct {
	ID         string
	Suppressed bool
	Reason     string
}

// ProviderError classifies a failure so the relay can tell the installation
// whether to retry.
type ProviderError struct {
	Kind       string // rate_limited, quota, suppressed, rejected, unavailable
	Code       string
	Status     int
	RetryAfter time.Duration
}

func (e *ProviderError) Error() string {
	return fmt.Sprintf("provider %s (%d %s)", e.Kind, e.Status, e.Code)
}

// Provider sends a rendered letter.
type Provider interface {
	Send(context.Context, Envelope) (ProviderResult, error)
}

// RuSender talks to POST /api/v1/public/emails. The token needs only the
// email.send scope; it is never logged.
type RuSender struct {
	client  *http.Client
	baseURL string
	token   string
	keyID   int64
}

const RuSenderURL = "https://api.rusender.ru"

func NewRuSender(client *http.Client, baseURL, token string, keyID int64) *RuSender {
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	if baseURL == "" {
		baseURL = RuSenderURL
	}
	return &RuSender{client: client, baseURL: strings.TrimRight(baseURL, "/"), token: token, keyID: keyID}
}

type ruContact struct {
	Email string `json:"email"`
	Name  string `json:"name,omitempty"`
}

type ruMail struct {
	From        ruContact `json:"from"`
	To          ruContact `json:"to"`
	Subject     string    `json:"subject"`
	PreviewText string    `json:"previewText,omitempty"`
	HTML        string    `json:"html"`
	Text        string    `json:"text"`
	KeyID       int64     `json:"keyId,omitempty"`
}

type ruResponse struct {
	OK   bool `json:"ok"`
	Data struct {
		ID         string `json:"id"`
		Status     string `json:"status"`
		Recipients []struct {
			Status string `json:"status"`
			Reason *struct {
				Code string `json:"code"`
			} `json:"reason"`
		} `json:"recipients"`
	} `json:"data"`
	Error *struct {
		Code    string `json:"code"`
		Details any    `json:"details"`
	} `json:"error"`
}

func (r *RuSender) Send(ctx context.Context, envelope Envelope) (ProviderResult, error) {
	body, err := json.Marshal(map[string]ruMail{"data": {
		From:        ruContact{Email: envelope.FromAddress, Name: envelope.FromName},
		To:          ruContact{Email: envelope.To},
		Subject:     envelope.Subject,
		PreviewText: envelope.Preview,
		HTML:        envelope.HTML,
		Text:        envelope.Text,
		KeyID:       r.keyID,
	}})
	if err != nil {
		return ProviderResult{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+"/api/v1/public/emails", bytes.NewReader(body))
	if err != nil {
		return ProviderResult{}, err
	}
	request.Header.Set("Authorization", "Bearer "+r.token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", envelope.IdempotencyKey)
	response, err := r.client.Do(request)
	if err != nil {
		return ProviderResult{}, &ProviderError{Kind: "unavailable", Code: "network"}
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	var parsed ruResponse
	_ = json.Unmarshal(raw, &parsed)
	code := ""
	if parsed.Error != nil {
		code = parsed.Error.Code
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		if parsed.Data.ID == "" {
			return ProviderResult{}, &ProviderError{Kind: "unavailable", Code: "malformed_response", Status: response.StatusCode}
		}
		result := ProviderResult{ID: parsed.Data.ID}
		if len(parsed.Data.Recipients) > 0 {
			recipient := parsed.Data.Recipients[0]
			if recipient.Status == "suppressed" || recipient.Status == "bounced" {
				result.Suppressed = true
				result.Reason = recipient.Status
				if recipient.Reason != nil {
					result.Reason = recipient.Reason.Code
				}
			}
		}
		return result, nil
	}
	failure := &ProviderError{Code: code, Status: response.StatusCode}
	switch {
	case response.StatusCode == http.StatusTooManyRequests || code == "RATE_LIMIT_EXCEEDED" || code == "REQUEST_ALREADY_IN_PROGRESS":
		failure.Kind = "rate_limited"
		failure.RetryAfter = retryAfter(response.Header.Get("Retry-After"))
	case response.StatusCode == http.StatusPaymentRequired || code == "PAYMENT_REQUIRED" || code == "QUOTA_EXCEEDED":
		failure.Kind = "quota"
	case code == "RECIPIENT_SUPPRESSED" || code == "RECIPIENT_BOUNCED":
		failure.Kind = "suppressed"
	case response.StatusCode >= 500:
		failure.Kind = "unavailable"
	default:
		failure.Kind = "rejected"
	}
	return ProviderResult{}, failure
}

func retryAfter(value string) time.Duration {
	seconds, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || seconds < 1 {
		return 30 * time.Second
	}
	if seconds > 3600 {
		seconds = 3600
	}
	return time.Duration(seconds) * time.Second
}

// AsProviderError unwraps a provider failure.
func AsProviderError(err error) (*ProviderError, bool) {
	var failure *ProviderError
	ok := errors.As(err, &failure)
	return failure, ok
}
