// Package mailrelay is the Coma mail relay (ADR-0013). Installations send a
// message type with data; the relay checks the sender's key, the links and
// the limits, renders the letter from its own template and hands it to
// RuSender. It never stores addresses in clear or letter content, and it
// never logs keys, addresses or links.
package mailrelay

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/mailtemplate"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"golang.org/x/time/rate"
)

const keyPrefix = "cmr_"

var providerKeyNamespace = uuid.MustParse("6f1f3c52-31d6-4c9b-9a59-6c0d3b0e7a10")

var (
	idempotencyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)
	keyPattern         = regexp.MustCompile(`^cmr_[A-Za-z0-9_-]{43}$`)
)

// Verifier fetches the challenge an installation publishes at its address.
type Verifier interface {
	Challenge(ctx context.Context, appURL string) (installationID, challenge string, err error)
}

// Options configure a Server.
type Options struct {
	Store         *Store
	Provider      Provider
	Verifier      Verifier
	Limits        Limits
	HashSecret    []byte
	WebhookSecret string
	FromAddress   string
	// AllowInsecureOrigins accepts http:// and private hosts; tests only.
	AllowInsecureOrigins bool
	Now                  func() time.Time
}

type Server struct {
	logger   *slog.Logger
	options  Options
	register *limiter
	verify   *limiter
	perKey   *limiter
	invalid  *limiter
	trusted  []netip.Prefix
}

func NewServer(logger *slog.Logger, options Options) *Server {
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Limits.PerRecipient == 0 {
		options.Limits = DefaultLimits()
	}
	return &Server{
		logger: logger, options: options,
		register: newLimiter(5.0/60, 5),
		verify:   newLimiter(10.0/60, 5),
		perKey:   newLimiter(60, 30),
		invalid:  newLimiter(30, 30),
	}
}

// TrustProxies makes per-IP limits use X-Forwarded-For from these proxies.
func (s *Server) TrustProxies(prefixes []netip.Prefix) { s.trusted = prefixes }

func (s *Server) Handler() http.Handler {
	router := chi.NewRouter()
	router.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	router.Post("/v1/installations", s.createInstallation)
	router.Post("/v1/installations/verify", s.verifyInstallation)
	router.Get("/v1/quota", s.quota)
	router.Post("/v1/messages", s.send)
	router.Post("/v1/webhooks/rusender/{secret}", s.webhook)
	return router
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

func randomToken(bytes int) (string, error) {
	raw := make([]byte, bytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func hashKey(key string) []byte {
	sum := sha256.Sum256([]byte(key))
	return sum[:]
}

func (s *Server) recipientHash(address string) []byte {
	mac := hmac.New(sha256.New, s.options.HashSecret)
	mac.Write([]byte(strings.ToLower(strings.TrimSpace(address))))
	return mac.Sum(nil)
}

var basePathPattern = regexp.MustCompile(`^(/[a-z0-9][a-z0-9-]{0,31}){0,3}$`)

// NormalizeAppURL accepts an https origin on port 443 with an optional
// short base path (lower-case letters, digits and dashes) and returns it in
// canonical form: host lower-cased, IDN in punycode, no trailing dot, no
// default port, no trailing slash. allowInsecure (tests, local runs) also
// accepts http and other ports.
func NormalizeAppURL(raw string, allowInsecure bool) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 512 {
		return nil, errors.New("app_url is empty or too long")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Opaque != "" || parsed.ForceQuery {
		return nil, errors.New("app_url must be an absolute URL without credentials, query or fragment")
	}
	if parsed.Scheme != "https" && !(allowInsecure && parsed.Scheme == "http") {
		return nil, errors.New("app_url must use https")
	}
	host, err := mailtemplate.CanonicalHost(parsed)
	if err != nil {
		return nil, errors.New("app_url host is invalid")
	}
	if !allowInsecure && parsed.Port() != "" && parsed.Port() != "443" {
		return nil, errors.New("app_url must use port 443")
	}
	path := strings.TrimRight(parsed.EscapedPath(), "/")
	if !allowInsecure && !basePathPattern.MatchString(path) {
		return nil, errors.New("app_url path may hold only up to three short lower-case segments")
	}
	return &url.URL{Scheme: parsed.Scheme, Host: host, Path: path}, nil
}

func (s *Server) createInstallation(w http.ResponseWriter, r *http.Request) {
	if !s.register.allow("ip:" + s.clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many registrations from this address.")
		return
	}
	var input struct {
		AppURL string `json:"app_url"`
	}
	if !decodeStrict(w, r, 4<<10, &input) {
		return
	}
	appURL, err := NormalizeAppURL(input.AppURL, s.options.AllowInsecureOrigins)
	if err == nil && !s.options.AllowInsecureOrigins {
		err = PublicOrigin(appURL)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_app_url", err.Error())
		return
	}
	ctx := r.Context()
	host := appURL.Host
	site := mailtemplate.Site(host)
	blocked, err := s.options.Store.SiteBlocked(ctx, site)
	if err != nil {
		s.internal(w, "check host", err)
		return
	}
	if blocked {
		writeError(w, http.StatusForbidden, "installation_revoked", "Coma mail is disabled for this address.")
		return
	}
	// Unverified registrations cost nothing; count them per address and
	// client so nobody can lock another installation out.
	if pending, err := s.options.Store.PendingFor(ctx, appURL.String(), s.clientIP(r)); err != nil {
		s.internal(w, "count pending", err)
		return
	} else if pending >= 5 {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many unverified registrations for this address.")
		return
	}
	secret, err := randomToken(32)
	if err != nil {
		s.internal(w, "generate key", err)
		return
	}
	challenge, err := randomToken(32)
	if err != nil {
		s.internal(w, "generate challenge", err)
		return
	}
	id := uuid.NewString()
	key := keyPrefix + secret
	if err := s.options.Store.CreateInstallation(ctx, id, hashKey(key), appURL.String(), host, site, challenge, s.clientIP(r)); err != nil {
		s.internal(w, "create installation", err)
		return
	}
	s.logger.Info("installation registered", "installation_id", id, "host", host)
	writeJSON(w, http.StatusCreated, map[string]string{"installation_id": id, "key": key, "challenge": challenge, "status": "pending"})
}

// authenticate resolves the bearer key. Failed attempts are limited per IP so
// keys cannot be guessed at speed (they carry 256 bits anyway).
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (Installation, bool) {
	header := r.Header.Get("Authorization")
	key, found := strings.CutPrefix(header, "Bearer ")
	if !found || !keyPattern.MatchString(key) {
		s.invalid.allow("ip:" + s.clientIP(r))
		writeError(w, http.StatusUnauthorized, "invalid_key", "Installation key is missing or invalid.")
		return Installation{}, false
	}
	installation, err := s.options.Store.InstallationByKey(r.Context(), hashKey(key))
	if errors.Is(err, ErrNotFound) {
		if !s.invalid.allow("ip:" + s.clientIP(r)) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many invalid keys.")
			return Installation{}, false
		}
		writeError(w, http.StatusUnauthorized, "invalid_key", "Installation key is missing or invalid.")
		return Installation{}, false
	}
	if err != nil {
		s.internal(w, "load installation", err)
		return Installation{}, false
	}
	return installation, true
}

func (s *Server) verifyInstallation(w http.ResponseWriter, r *http.Request) {
	installation, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	switch installation.Status {
	case "active":
		writeJSON(w, http.StatusOK, map[string]string{"status": "active"})
		return
	case "suspended", "revoked":
		s.writeRevoked(w, installation)
		return
	}
	if !s.verify.allow("installation:" + installation.ID) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many verification attempts.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	id, challenge, err := s.options.Verifier.Challenge(ctx, installation.AppURL)
	if err != nil || id != installation.ID || subtle.ConstantTimeCompare([]byte(challenge), []byte(installation.Challenge)) != 1 {
		s.logger.Info("installation verification failed", "installation_id", installation.ID, "host", installation.AppHost)
		writeError(w, http.StatusUnprocessableEntity, "origin_unverified", "The installation address did not return the expected challenge.")
		return
	}
	if blocked, err := s.options.Store.SiteBlocked(ctx, installation.AppSite); err != nil {
		s.internal(w, "check host", err)
		return
	} else if blocked {
		writeError(w, http.StatusForbidden, "installation_revoked", "Coma mail is disabled for this address.")
		return
	}
	if err := s.options.Store.Activate(ctx, installation.ID, installation.AppURL, installation.AppSite); err != nil {
		s.internal(w, "activate installation", err)
		return
	}
	s.logger.Info("installation verified", "installation_id", installation.ID, "host", installation.AppHost)
	writeJSON(w, http.StatusOK, map[string]string{"status": "active"})
}

func (s *Server) quota(w http.ResponseWriter, r *http.Request) {
	installation, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	now := s.options.Now()
	used, err := s.options.Store.Usage(r.Context(), installation.AppSite, now)
	if err != nil {
		s.internal(w, "usage", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":              installation.Status,
		"daily_limit":         s.options.Limits.DailyLimit(installation, now),
		"used":                used,
		"per_recipient_limit": s.options.Limits.PerRecipient,
		"window_hours":        24,
	})
}

func (s *Server) send(w http.ResponseWriter, r *http.Request) {
	installation, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	switch installation.Status {
	case "pending":
		writeError(w, http.StatusForbidden, "installation_pending", "The installation address is not verified yet.")
		return
	case "suspended", "revoked":
		s.writeRevoked(w, installation)
		return
	}
	if !s.perKey.allow("site:" + installation.AppSite) {
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests.")
		return
	}
	idempotencyKey := r.Header.Get("Idempotency-Key")
	if !idempotencyPattern.MatchString(idempotencyKey) {
		writeError(w, http.StatusBadRequest, "invalid_request", "Idempotency-Key header is required.")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Request body is too large.")
		return
	}
	message, err := mailtemplate.Decode(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Request body does not match the message contract.")
		return
	}
	message.Normalize()
	base, err := NormalizeAppURL(installation.AppURL, true)
	if err != nil {
		s.internal(w, "stored app url", err)
		return
	}
	if err := message.Validate(base); err != nil {
		code := "invalid_request"
		if errors.Is(err, mailtemplate.ErrInvalidLink) {
			code = "invalid_link"
		}
		writeError(w, http.StatusBadRequest, code, err.Error())
		return
	}
	canonical, _ := json.Marshal(message)
	payloadHash := sha256.Sum256(canonical)
	recipient := s.recipientHash(CanonicalRecipient(message.To))
	now := s.options.Now()
	reserved, err := s.options.Store.Reserve(r.Context(), s.options.Limits, installation, message.Kind, recipient, idempotencyKey, payloadHash[:], uuid.NewString(), now)
	switch {
	case errors.Is(err, errConflict):
		writeError(w, http.StatusConflict, "idempotency_conflict", "This Idempotency-Key was used for another message.")
		return
	case errors.Is(err, errInProgress):
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusTooManyRequests, "rate_limited", "The same message is being sent.")
		return
	case errors.Is(err, errSuppressed):
		writeError(w, http.StatusUnprocessableEntity, "recipient_suppressed", "The recipient complained, unsubscribed or does not exist.")
		return
	case errors.Is(err, errRecipientLimit):
		writeError(w, http.StatusTooManyRequests, "recipient_limit", "Daily limit for this recipient is reached.")
		return
	case errors.Is(err, errInstallationLimit):
		writeError(w, http.StatusTooManyRequests, "installation_limit", "Daily limit of this installation is reached.")
		return
	case err != nil:
		s.internal(w, "reserve", err)
		return
	}
	if reserved.Replayed {
		w.Header().Set("Idempotency-Replayed", "true")
		writeJSON(w, http.StatusAccepted, map[string]string{"id": reserved.ID, "status": "queued"})
		return
	}
	rendered := mailtemplate.Render(message)
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 25*time.Second)
	defer cancel()
	result, err := s.options.Provider.Send(ctx, Envelope{
		// Stable across retries of the same request, so RuSender itself drops
		// a duplicate when an earlier answer was lost on the way back.
		IdempotencyKey: uuid.NewSHA1(providerKeyNamespace, []byte(installation.ID+"\x00"+idempotencyKey)).String(), FromAddress: s.options.FromAddress, FromName: rendered.FromName, To: message.To,
		Subject: rendered.Subject, Preview: rendered.Preview, Text: rendered.Text, HTML: rendered.HTML,
	})
	if err != nil {
		failure, _ := AsProviderError(err)
		if failure == nil {
			failure = &ProviderError{Kind: "unavailable"}
		}
		if failure.Kind == "suppressed" {
			_ = s.options.Store.Suppress(ctx, recipient, strings.ToLower(failure.Code))
			_ = s.options.Store.Complete(ctx, reserved.ID, "suppressed", "")
			writeError(w, http.StatusUnprocessableEntity, "recipient_suppressed", "The recipient complained, unsubscribed or does not exist.")
			return
		}
		_ = s.options.Store.Complete(ctx, reserved.ID, "failed", "")
		s.logger.Warn("provider refused letter", "installation_id", installation.ID, "kind", message.Kind, "provider_kind", failure.Kind, "provider_code", failure.Code, "provider_status", failure.Status)
		switch failure.Kind {
		case "rate_limited":
			w.Header().Set("Retry-After", strconv.Itoa(int(failure.RetryAfter.Seconds())))
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Delivery provider is busy, retry later.")
		case "quota":
			w.Header().Set("Retry-After", "3600")
			writeError(w, http.StatusServiceUnavailable, "provider_quota", "Coma mail is temporarily over its monthly volume.")
		default:
			writeError(w, http.StatusBadGateway, "provider_unavailable", "Delivery provider is unavailable, retry later.")
		}
		return
	}
	status := "sent"
	if result.Suppressed {
		status = "suppressed"
		_ = s.options.Store.Suppress(ctx, recipient, strings.ToLower(result.Reason))
	}
	if err := s.options.Store.Complete(ctx, reserved.ID, status, result.ID); err != nil {
		s.logger.Error("record letter", "error", err)
	}
	if result.Suppressed {
		writeError(w, http.StatusUnprocessableEntity, "recipient_suppressed", "The recipient complained, unsubscribed or does not exist.")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"id": reserved.ID, "status": "queued"})
}

// webhookEvent is one RuSender event; see docs/webhooks/email-events.
type webhookEvent struct {
	EventID string `json:"eventId"`
	Trigger string `json:"trigger"`
	Payload struct {
		EmailID   string `json:"emailId"`
		Recipient struct {
			Email string `json:"email"`
		} `json:"recipient"`
		Reason *struct {
			Code       string `json:"code"`
			BounceType string `json:"bounceType"`
		} `json:"reason"`
	} `json:"payload"`
}

func (s *Server) webhook(w http.ResponseWriter, r *http.Request) {
	secret := chi.URLParam(r, "secret")
	if s.options.WebhookSecret == "" || subtle.ConstantTimeCompare([]byte(secret), []byte(s.options.WebhookSecret)) != 1 {
		http.NotFound(w, r)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var batch struct {
		Events []webhookEvent `json:"events"`
	}
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Malformed webhook body.")
		return
	}
	ctx := r.Context()
	for _, event := range batch.Events {
		if err := s.handleEvent(ctx, event); err != nil {
			s.logger.Error("webhook event", "trigger", event.Trigger, "error", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleEvent(ctx context.Context, event webhookEvent) error {
	var status, reason string
	switch event.Trigger {
	case "email.complained":
		status, reason = "complained", "complained"
	case "email.bounced":
		if event.Payload.Reason != nil && event.Payload.Reason.BounceType != "" && event.Payload.Reason.BounceType != "permanent" {
			return nil
		}
		status, reason = "bounced", "bounced"
	case "email.unsubscribed":
		reason = "unsubscribed"
	default:
		return nil
	}
	if event.EventID == "" || event.Payload.EmailID == "" {
		return nil
	}
	site, applied, err := s.options.Store.ApplyEvent(ctx, event.EventID, event.Payload.EmailID, status, reason)
	if err != nil || !applied || status == "" {
		return err
	}
	sent, bounced, complained, complainers, err := s.options.Store.Reputation(ctx, site)
	if err != nil {
		return err
	}
	// Three different people complaining, at least 0.3 % of the week's
	// letters; or more than 10 % hard bounces among 30 letters or more. The
	// suspension lasts three days; the operator decides on anything longer.
	byComplaints := complainers >= 3 && complained*1000 >= sent*3
	byBounces := sent >= 30 && bounced*10 > sent
	if byComplaints || byBounces {
		reason := "auto_complaints"
		if !byComplaints {
			reason = "auto_bounces"
		}
		s.logger.Warn("installation suspended", "site", site, "reason", reason, "sent", sent, "bounced", bounced, "complained", complained)
		return s.options.Store.SuspendSite(ctx, site, reason, s.options.Now().Add(72*time.Hour))
	}
	return nil
}

// writeRevoked tells a reinstalled server to register again and everyone
// else that Coma mail is off for them.
func (s *Server) writeRevoked(w http.ResponseWriter, installation Installation) {
	if installation.Status == "revoked" && installation.Reason == "replaced" {
		writeError(w, http.StatusForbidden, "installation_replaced", "A newer registration of this address replaced this key.")
		return
	}
	writeError(w, http.StatusForbidden, "installation_revoked", "Coma mail is disabled for this installation.")
}

func (s *Server) internal(w http.ResponseWriter, action string, err error) {
	s.logger.Error("mail relay failure", "action", action, "error", err)
	writeError(w, http.StatusInternalServerError, "internal", "Internal error.")
}

func decodeStrict(w http.ResponseWriter, r *http.Request, limit int64, destination any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Malformed request body.")
		return false
	}
	return true
}

type limiter struct {
	mu      sync.Mutex
	every   rate.Limit
	burst   int
	buckets map[string]*rate.Limiter
	seen    map[string]time.Time
}

func newLimiter(perMinute float64, burst int) *limiter {
	return &limiter{every: rate.Limit(perMinute / 60), burst: burst, buckets: map[string]*rate.Limiter{}, seen: map[string]time.Time{}}
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.buckets) > 100_000 {
		for name, last := range l.seen {
			if now.Sub(last) > time.Hour {
				delete(l.buckets, name)
				delete(l.seen, name)
			}
		}
	}
	if len(l.buckets) >= 100_000 {
		// Still full after dropping idle buckets: forget an arbitrary half
		// rather than growing without bound.
		dropped := 0
		for name := range l.buckets {
			delete(l.buckets, name)
			delete(l.seen, name)
			if dropped++; dropped >= 50_000 {
				break
			}
		}
	}
	bucket, ok := l.buckets[key]
	if !ok {
		bucket = rate.NewLimiter(l.every, l.burst)
		l.buckets[key] = bucket
	}
	l.seen[key] = now
	return bucket.Allow()
}

// clientIP is the TCP peer, or the rightmost untrusted X-Forwarded-For entry
// when the peer is a trusted proxy.
func (s *Server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if !s.isTrusted(host) {
		return clientKey(host)
	}
	forwarded := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	for index := len(forwarded) - 1; index >= 0; index-- {
		address, err := netip.ParseAddr(strings.TrimSpace(forwarded[index]))
		if err != nil {
			break
		}
		if !s.isTrusted(address.String()) {
			return clientKey(address.Unmap().String())
		}
	}
	return clientKey(host)
}

// clientKey keys IPv6 clients by their /64: one subscriber gets a whole
// prefix and could otherwise pick a fresh address for every request.
func clientKey(host string) string {
	address, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	address = address.Unmap()
	if address.Is6() {
		prefix, _ := address.Prefix(64)
		return prefix.String()
	}
	return address.String()
}

func (s *Server) isTrusted(host string) bool {
	address, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	address = address.Unmap()
	for _, prefix := range s.trusted {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}
