package relay

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/time/rate"
)

var handlePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32,256}$`)

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
			if now.Sub(last) > 10*time.Minute {
				delete(l.buckets, name)
				delete(l.seen, name)
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

// Server is the relay's public API. It never logs tokens or ciphertext.
type Server struct {
	logger   *slog.Logger
	store    *Store
	senders  map[string]Sender
	register *limiter
	sendIP   *limiter
	sendDev  *limiter
}

func NewServer(logger *slog.Logger, store *Store, senders map[string]Sender) *Server {
	return &Server{
		logger: logger, store: store, senders: senders,
		register: newLimiter(20, 10), sendIP: newLimiter(6000, 600), sendDev: newLimiter(120, 30),
	}
}

func (s *Server) Handler() http.Handler {
	router := chi.NewRouter()
	router.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	router.Post("/v1/devices", s.createDevice)
	router.Put("/v1/devices/{handle}", s.updateDevice)
	router.Delete("/v1/devices/{handle}", s.deleteDevice)
	router.Post("/v1/send", s.send)
	return router
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func decode(w http.ResponseWriter, r *http.Request, destination any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return false
	}
	return true
}

func validToken(platform, token string) bool {
	return (platform == "ios" || platform == "android") && len(token) >= 8 && len(token) <= 4096
}

func (s *Server) createDevice(w http.ResponseWriter, r *http.Request) {
	if !s.register.allow(clientIP(r)) {
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	var input struct {
		Platform string `json:"platform"`
		Token    string `json:"token"`
	}
	if !decode(w, r, &input) {
		return
	}
	if !validToken(input.Platform, input.Token) || s.senders[input.Platform] == nil {
		http.Error(w, "unsupported device", http.StatusUnprocessableEntity)
		return
	}
	handle, err := s.store.Create(r.Context(), Device{Platform: input.Platform, Token: input.Token})
	if err != nil {
		s.fail(w, "create device", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]string{"handle": handle})
}

// updateDevice rotates the platform token; knowing the handle is the authority.
func (s *Server) updateDevice(w http.ResponseWriter, r *http.Request) {
	handle := chi.URLParam(r, "handle")
	if !handlePattern.MatchString(handle) {
		w.WriteHeader(http.StatusGone)
		return
	}
	if !s.register.allow(clientIP(r)) {
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	var input struct {
		Token string `json:"token"`
	}
	if !decode(w, r, &input) {
		return
	}
	if len(input.Token) < 8 || len(input.Token) > 4096 {
		http.Error(w, "invalid token", http.StatusUnprocessableEntity)
		return
	}
	if err := s.store.UpdateToken(r.Context(), handle, input.Token); errors.Is(err, ErrUnknownHandle) {
		w.WriteHeader(http.StatusGone)
		return
	} else if err != nil {
		s.fail(w, "update device", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteDevice(w http.ResponseWriter, r *http.Request) {
	handle := chi.URLParam(r, "handle")
	if !handlePattern.MatchString(handle) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := s.store.Delete(r.Context(), handle); err != nil {
		s.fail(w, "delete device", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) send(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Handle        string `json:"handle"`
		Ciphertext    string `json:"ciphertext"`
		FallbackTitle string `json:"fallback_title"`
		FallbackBody  string `json:"fallback_body"`
		CollapseID    string `json:"collapse_id"`
	}
	if !s.sendIP.allow(clientIP(r)) {
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	if !decode(w, r, &input) {
		return
	}
	// APNs payloads are capped at 4 KB; the envelope must fit around the ciphertext.
	if !handlePattern.MatchString(input.Handle) || input.Ciphertext == "" || len(input.Ciphertext) > 3000 ||
		len(input.FallbackTitle) > 64 || len(input.FallbackBody) > 128 || len(input.CollapseID) > 64 {
		http.Error(w, "invalid notification", http.StatusUnprocessableEntity)
		return
	}
	if !s.sendDev.allow(input.Handle) {
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	device, err := s.store.Lookup(r.Context(), input.Handle)
	if errors.Is(err, ErrUnknownHandle) {
		w.WriteHeader(http.StatusGone)
		return
	}
	if err != nil {
		s.fail(w, "look up device", err)
		return
	}
	sender := s.senders[device.Platform]
	if sender == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	err = sender.Send(ctx, device.Token, Notification{
		Ciphertext: input.Ciphertext, FallbackTitle: input.FallbackTitle,
		FallbackBody: input.FallbackBody, CollapseID: input.CollapseID,
	})
	switch {
	case err == nil:
		w.WriteHeader(http.StatusAccepted)
	case errors.Is(err, ErrUnknownHandle):
		_ = s.store.Delete(r.Context(), input.Handle)
		w.WriteHeader(http.StatusGone)
	default:
		s.logger.Warn("push provider rejected a notification", "platform", device.Platform, "error", err)
		w.WriteHeader(http.StatusBadGateway)
	}
}

func (s *Server) fail(w http.ResponseWriter, action string, err error) {
	s.logger.Error("relay storage failed", "action", action, "error", err)
	w.WriteHeader(http.StatusInternalServerError)
}
