package realtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	standardhttp "net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
)

const (
	statusAuthenticationFailed websocket.StatusCode = 4001
	statusSlowConsumer         websocket.StatusCode = 4008
	statusResyncRequired       websocket.StatusCode = 4009
)

var (
	errServiceRestart = errors.New("realtime service restarting")
	errSessionRevoked = errors.New("realtime session revoked")
	errSessionExpired = errors.New("realtime session expired")
)

type AuthenticateFunc func(context.Context, string) (identity.User, access.Identity, error)

type Server struct {
	logger              *slog.Logger
	allowedOrigin       string
	store               *eventlog.Store
	hub                 *Hub
	authenticate        AuthenticateFunc
	config              config.RealtimeConfig
	ephemeral           *Ephemeral
	pending             chan struct{}
	writeSlots          chan struct{}
	statsMu             sync.Mutex
	disconnects         map[string]uint64
	lastDisconnectError string
}

func NewServer(logger *slog.Logger, allowedOrigin string, store *eventlog.Store, hub *Hub, authenticate AuthenticateFunc, cfg config.RealtimeConfig, ephemeral *Ephemeral) *Server {
	if cfg.MaxPendingConnections == 0 {
		cfg.MaxPendingConnections = 256
	}
	if cfg.MaxConcurrentWrites == 0 {
		cfg.MaxConcurrentWrites = 8
	}
	return &Server{logger: logger, allowedOrigin: strings.TrimRight(allowedOrigin, "/"), store: store, hub: hub, authenticate: authenticate, config: cfg, ephemeral: ephemeral, pending: make(chan struct{}, cfg.MaxPendingConnections), writeSlots: make(chan struct{}, cfg.MaxConcurrentWrites), disconnects: make(map[string]uint64)}
}

func (s *Server) DisconnectStats() map[string]uint64 {
	s.statsMu.Lock()
	defer s.statsMu.Unlock()
	result := make(map[string]uint64, len(s.disconnects))
	for reason, count := range s.disconnects {
		result[reason] = count
	}
	return result
}

func (s *Server) LastDisconnectError() string {
	s.statsMu.Lock()
	defer s.statsMu.Unlock()
	return s.lastDisconnectError
}

func (s *Server) Shutdown() { s.hub.Shutdown(errServiceRestart) }

func (s *Server) RevokeSession(sessionID string) { s.hub.RevokeSession(sessionID) }

func (s *Server) ServeHTTP(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if !s.validOrigin(r.Header.Get("Origin")) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(standardhttp.StatusForbidden)
		_ = json.NewEncoder(w).Encode(api.Error{
			Code: "origin_not_allowed", Message: "WebSocket origin is not allowed.", RequestId: middleware.GetReqID(r.Context()),
		})
		return
	}
	select {
	case s.pending <- struct{}{}:
	default:
		w.Header().Set("Retry-After", "1")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(standardhttp.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(api.Error{Code: "service_unavailable", Message: "Too many WebSocket handshakes are pending.", RequestId: middleware.GetReqID(r.Context())})
		return
	}
	pending := true
	defer func() {
		if pending {
			<-s.pending
		}
	}()
	connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		s.logger.Warn("accept websocket", "error", err)
		return
	}
	connection.SetReadLimit(int64(s.config.MaxFrameBytes))
	defer connection.CloseNow()

	authCtx, authCancel := context.WithTimeout(r.Context(), s.config.AuthTimeout)
	auth, err := readAuthFrame(authCtx, connection)
	authCancel()
	if err != nil {
		s.writeInitialError(r.Context(), connection, "invalid_frame", "The first frame must be a valid auth frame.")
		_ = connection.Close(websocket.StatusPolicyViolation, "invalid auth frame")
		return
	}
	user, accessIdentity, err := s.authenticate(r.Context(), auth.AccessToken)
	if err != nil {
		_ = connection.Close(statusAuthenticationFailed, "authentication failed")
		return
	}
	if accessIdentity.AuthenticationKind == "api_key" && !hasRealtimeScope(accessIdentity.Scopes) {
		_ = connection.Close(statusAuthenticationFailed, "messages:read scope required")
		return
	}
	if user.MustChangePassword {
		s.writeInitialError(r.Context(), connection, "password_change_required", "Change your password before connecting to realtime.")
		_ = connection.Close(statusAuthenticationFailed, "password change required")
		return
	}

	initialWatermark, err := s.store.Current(r.Context(), user.OrgID)
	if err != nil {
		s.logger.Error("prime realtime watermark", "org_id", user.OrgID, "error", err)
		_ = connection.Close(websocket.StatusInternalError, "event log unavailable")
		return
	}
	connectionID, err := id.New()
	if err != nil {
		_ = connection.Close(websocket.StatusInternalError, "connection id unavailable")
		return
	}
	subscription, err := s.hub.Register(user.OrgID, user.ActorID, accessIdentity.SessionID, connectionID, initialWatermark)
	if err != nil {
		if errors.Is(err, ErrConnectionLimit) {
			s.writeInitialError(r.Context(), connection, "rate_limited", "The actor connection limit was reached.")
			_ = connection.Close(websocket.StatusPolicyViolation, "connection limit reached")
			return
		}
		_ = connection.Close(websocket.StatusGoingAway, "service unavailable")
		return
	}
	<-s.pending
	pending = false
	defer subscription.Close()

	bounds, err := s.store.Bounds(r.Context(), user.OrgID)
	if err != nil {
		s.logger.Error("read realtime bounds", "org_id", user.OrgID, "error", err)
		_ = connection.Close(websocket.StatusInternalError, "event log unavailable")
		return
	}
	if auth.LastSeq > bounds.CurrentSeq {
		s.writeInitialError(r.Context(), connection, "invalid_frame", "last_seq is ahead of the server watermark.")
		_ = connection.Close(websocket.StatusPolicyViolation, "invalid checkpoint")
		return
	}
	if auth.LastSeq < bounds.MinRetainedSeq {
		frame := resyncFrame{Op: "resync_required", CurrentSeq: bounds.CurrentSeq, MinRetainedSeq: bounds.MinRetainedSeq, Reason: "event_history_expired"}
		_ = s.writeFrame(r.Context(), connection, frame)
		_ = connection.Close(statusResyncRequired, "event history expired")
		return
	}

	session := &session{
		logger: s.logger, connection: connection, subscription: subscription, store: s.store, user: user,
		authentication: accessIdentity,
		config:         s.config, connectionID: connectionID, requestID: auth.RequestID,
		sessionID: accessIdentity.SessionID, authExpiresAt: accessIdentity.ExpiresAt,
		lastSeq: auth.LastSeq, backlogHigh: bounds.CurrentSeq, minRetainedSeq: bounds.MinRetainedSeq,
		acks: make(chan int64, 32), protocolErrors: make(chan protocolErrorFrame, 1), ephemeralErrors: make(chan protocolErrorFrame, 8),
		ephemeral:  s.ephemeral,
		writeSlots: s.writeSlots,
	}
	startedAt := time.Now()
	s.logger.Info("websocket connected",
		"connection_id", connectionID, "org_id", user.OrgID, "actor_id", user.ActorID,
		"session_id", accessIdentity.SessionID, "last_seq", auth.LastSeq, "current_seq", bounds.CurrentSeq,
	)
	closeCode, closeReason, closeCause := session.run(r.Context())
	s.statsMu.Lock()
	s.disconnects[fmt.Sprintf("%d:%s", closeCode, closeReason)]++
	if closeCode == websocket.StatusInternalError && closeCause != nil {
		s.lastDisconnectError = closeCause.Error()
	}
	s.statsMu.Unlock()
	s.logger.Info("websocket disconnected",
		"connection_id", connectionID, "org_id", user.OrgID, "actor_id", user.ActorID,
		"session_id", accessIdentity.SessionID, "duration", time.Since(startedAt),
		"close_code", closeCode, "close_reason", closeReason, "error", closeCause,
	)
	_ = connection.Close(closeCode, closeReason)
}

func hasRealtimeScope(scopes []string) bool {
	for _, scope := range scopes {
		if scope == "messages:read" {
			return true
		}
	}
	return false
}

func (s *Server) validOrigin(origin string) bool {
	return origin == "" || strings.TrimRight(origin, "/") == s.allowedOrigin
}

func (s *Server) writeInitialError(ctx context.Context, connection *websocket.Conn, code, message string) {
	_ = s.writeFrame(ctx, connection, protocolErrorFrame{Op: "error", Code: code, Message: message})
}

func (s *Server) writeFrame(ctx context.Context, connection *websocket.Conn, frame any) error {
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, s.config.PongTimeout)
	defer cancel()
	return connection.Write(writeCtx, websocket.MessageText, payload)
}

type authFrame struct {
	Op          string `json:"op"`
	RequestID   string `json:"request_id"`
	AccessToken string `json:"access_token"`
	LastSeq     int64  `json:"last_seq"`
}

type helloFrame struct {
	Op                  string `json:"op"`
	RequestID           string `json:"request_id"`
	ConnectionID        string `json:"connection_id"`
	CurrentSeq          int64  `json:"current_seq"`
	MinRetainedSeq      int64  `json:"min_retained_seq"`
	HeartbeatIntervalMS int    `json:"heartbeat_interval_ms"`
	AckIntervalMS       int    `json:"ack_interval_ms"`
	AckBatchSize        int    `json:"ack_batch_size"`
	MaxUnackedEvents    int    `json:"max_unacked_events"`
}

type ackFrame struct {
	Op  string `json:"op"`
	Seq int64  `json:"seq"`
}

type subscribeActiveFrame struct {
	Op           string  `json:"op"`
	ChatID       *string `json:"chat_id"`
	ThreadRootID *string `json:"thread_root_id"`
}
type typingFrame struct {
	Op           string  `json:"op"`
	ChatID       string  `json:"chat_id"`
	ThreadRootID *string `json:"thread_root_id"`
	Active       bool    `json:"active"`
}
type presenceFrame struct {
	Op    string `json:"op"`
	State string `json:"state"`
}
type typingEventFrame struct {
	Op           string    `json:"op"`
	ActorID      string    `json:"actor_id"`
	ChatID       string    `json:"chat_id"`
	ThreadRootID *string   `json:"thread_root_id"`
	Active       bool      `json:"active"`
	ExpiresAt    time.Time `json:"expires_at"`
}
type presenceEventFrame struct {
	Op        string    `json:"op"`
	ActorID   string    `json:"actor_id"`
	State     string    `json:"state"`
	ExpiresAt time.Time `json:"expires_at"`
}
type agentStatusFrame struct {
	Op           string  `json:"op"`
	RunID        string  `json:"run_id"`
	LeaseToken   string  `json:"lease_token"`
	ChatID       string  `json:"chat_id"`
	ThreadRootID *string `json:"thread_root_id"`
	State        string  `json:"state"`
}
type agentStatusEventFrame struct {
	Op           string    `json:"op"`
	ActorID      string    `json:"actor_id"`
	RunID        string    `json:"run_id"`
	ChatID       string    `json:"chat_id"`
	ThreadRootID *string   `json:"thread_root_id"`
	State        string    `json:"state"`
	ExpiresAt    time.Time `json:"expires_at"`
}
type messageStreamingFrame struct {
	Op           string  `json:"op"`
	RunID        string  `json:"run_id"`
	LeaseToken   string  `json:"lease_token"`
	ChatID       string  `json:"chat_id"`
	ThreadRootID *string `json:"thread_root_id"`
	StreamID     string  `json:"stream_id"`
	Index        int64   `json:"index"`
	Delta        string  `json:"delta"`
	Reset        bool    `json:"reset"`
	Done         bool    `json:"done"`
}
type messageStreamingEventFrame struct {
	Op           string    `json:"op"`
	ActorID      string    `json:"actor_id"`
	RunID        string    `json:"run_id"`
	ChatID       string    `json:"chat_id"`
	ThreadRootID *string   `json:"thread_root_id"`
	StreamID     string    `json:"stream_id"`
	Index        int64     `json:"index"`
	Delta        string    `json:"delta"`
	Reset        bool      `json:"reset"`
	Done         bool      `json:"done"`
	ExpiresAt    time.Time `json:"expires_at"`
}

type resyncFrame struct {
	Op             string `json:"op"`
	CurrentSeq     int64  `json:"current_seq"`
	MinRetainedSeq int64  `json:"min_retained_seq"`
	Reason         string `json:"reason"`
}

type protocolErrorFrame struct {
	Op        string  `json:"op"`
	RequestID *string `json:"request_id,omitempty"`
	Code      string  `json:"code"`
	Message   string  `json:"message"`
}

func readAuthFrame(ctx context.Context, connection *websocket.Conn) (authFrame, error) {
	messageType, payload, err := connection.Read(ctx)
	if err != nil {
		return authFrame{}, err
	}
	if messageType != websocket.MessageText {
		return authFrame{}, errors.New("auth frame must be text")
	}
	var frame authFrame
	if err := decodeStrict(payload, &frame); err != nil {
		return authFrame{}, err
	}
	if frame.Op != "auth" || frame.AccessToken == "" || frame.LastSeq < 0 {
		return authFrame{}, errors.New("invalid auth frame")
	}
	if _, err := uuid.Parse(frame.RequestID); err != nil {
		return authFrame{}, errors.New("request_id must be a UUID")
	}
	return frame, nil
}

func decodeStrict(payload []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("frame must contain one JSON object")
	}
	return nil
}

type closeError struct {
	code   websocket.StatusCode
	reason string
}

func (e *closeError) Error() string { return fmt.Sprintf("websocket close %d: %s", e.code, e.reason) }

func closeDetails(err error) (websocket.StatusCode, string) {
	var requested *closeError
	if errors.As(err, &requested) {
		return requested.code, requested.reason
	}
	if errors.Is(err, errServiceRestart) {
		return websocket.StatusServiceRestart, "service restart"
	}
	if errors.Is(err, errSessionRevoked) || errors.Is(err, errSessionExpired) {
		return statusAuthenticationFailed, "authentication expired"
	}
	if errors.Is(err, errLiveQueueExceeded) {
		return statusSlowConsumer, "outbound event queue exceeded"
	}
	if status := websocket.CloseStatus(err); status != -1 {
		if status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway {
			return websocket.StatusNormalClosure, "client disconnected"
		}
		return status, "client disconnected"
	}
	if errors.Is(err, context.Canceled) {
		return websocket.StatusNormalClosure, "connection closed"
	}
	return websocket.StatusInternalError, "realtime failure"
}
