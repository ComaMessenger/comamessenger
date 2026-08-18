package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/coder/websocket"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/identity"
)

type session struct {
	logger          *slog.Logger
	connection      *websocket.Conn
	subscription    *Subscription
	store           *eventlog.Store
	user            identity.User
	config          config.RealtimeConfig
	connectionID    string
	requestID       string
	sessionID       string
	lastSeq         int64
	backlogHigh     int64
	minRetainedSeq  int64
	acks            chan int64
	protocolErrors  chan protocolErrorFrame
	ephemeralErrors chan protocolErrorFrame
	ephemeral       *Ephemeral
}

func (s *session) run(requestCtx context.Context) (websocket.StatusCode, string) {
	ctx, cancel := context.WithCancelCause(requestCtx)
	defer cancel(context.Canceled)

	results := make(chan error, 2)
	go func() { results <- s.readLoop(ctx) }()
	go func() { results <- s.writeLoop(ctx) }()

	var result error
	select {
	case result = <-results:
		var requested *closeError
		if errors.As(result, &requested) {
			_ = s.connection.Close(requested.code, requested.reason)
			cancel(result)
			return requested.code, requested.reason
		}
		cancel(result)
	case <-s.subscription.Context().Done():
		result = context.Cause(s.subscription.Context())
		code, reason := closeDetails(result)
		_ = s.connection.Close(code, reason)
		cancel(result)
		return code, reason
	case <-ctx.Done():
		result = context.Cause(ctx)
	}
	return closeDetails(result)
}

func (s *session) readLoop(ctx context.Context) error {
	for {
		messageType, payload, err := s.connection.Read(ctx)
		if err != nil {
			return err
		}
		if messageType != websocket.MessageText {
			return s.protocolFailure(ctx, "invalid_frame", "Only text JSON frames are supported.")
		}
		var envelope struct {
			Op string `json:"op"`
		}
		if err := json.Unmarshal(payload, &envelope); err != nil {
			return s.protocolFailure(ctx, "invalid_frame", "Frame must contain valid JSON.")
		}
		switch envelope.Op {
		case "ack":
			var frame ackFrame
			if err := decodeStrict(payload, &frame); err != nil || frame.Seq < 0 {
				return s.protocolFailure(ctx, "invalid_frame", "ACK frame is invalid.")
			}
			select {
			case s.acks <- frame.Seq:
			case <-ctx.Done():
				return context.Cause(ctx)
			}
		case "subscribe_active":
			var frame subscribeActiveFrame
			if decodeStrict(payload, &frame) != nil || s.ephemeral == nil {
				return s.protocolFailure(ctx, "invalid_frame", "Active subscription frame is invalid.")
			}
			if err := s.ephemeral.SubscribeActive(ctx, s.user, s.subscription, frame.ChatID, frame.ThreadRootID); err != nil {
				if reportErr := s.reportEphemeralError(ctx, err); reportErr != nil {
					return reportErr
				}
			}
		case "typing":
			var frame typingFrame
			if decodeStrict(payload, &frame) != nil || s.ephemeral == nil {
				return s.protocolFailure(ctx, "invalid_frame", "Typing frame is invalid.")
			}
			if err := s.ephemeral.Typing(ctx, s.user, s.subscription, frame.ChatID, frame.ThreadRootID, frame.Active); err != nil {
				if reportErr := s.reportEphemeralError(ctx, err); reportErr != nil {
					return reportErr
				}
			}
		case "presence":
			var frame presenceFrame
			if decodeStrict(payload, &frame) != nil || s.ephemeral == nil {
				return s.protocolFailure(ctx, "invalid_frame", "Presence frame is invalid.")
			}
			if err := s.ephemeral.Presence(ctx, s.user, s.subscription, frame.State); err != nil {
				if reportErr := s.reportEphemeralError(ctx, err); reportErr != nil {
					return reportErr
				}
			}
		default:
			return s.protocolFailure(ctx, "invalid_frame", "Operation is not supported in this phase.")
		}
	}
}

func (s *session) reportEphemeralError(ctx context.Context, err error) error {
	frame := protocolErrorFrame{Op: "error", Code: "invalid_frame", Message: "Ephemeral operation is invalid."}
	switch {
	case errors.Is(err, ErrEphemeralRateLimited):
		frame.Code = "rate_limited"
		frame.Message = "Ephemeral operation rate limit exceeded."
	case errors.Is(err, ErrEphemeralForbidden):
		frame.Code = "forbidden"
		frame.Message = "Ephemeral scope is not accessible."
	case errors.Is(err, ErrEphemeralUnavailable):
		frame.Code = "service_unavailable"
		frame.Message = "Ephemeral coordination is temporarily unavailable."
	}
	select {
	case s.ephemeralErrors <- frame:
		return nil
	case <-ctx.Done():
		return context.Cause(ctx)
	}
}

func (s *session) protocolFailure(ctx context.Context, code, message string) error {
	select {
	case s.protocolErrors <- protocolErrorFrame{Op: "error", Code: code, Message: message}:
	case <-ctx.Done():
		return context.Cause(ctx)
	}
	select {
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-time.After(s.config.PongTimeout):
		return &closeError{code: websocket.StatusPolicyViolation, reason: "protocol violation"}
	}
}

func (s *session) writeLoop(ctx context.Context) error {
	hello := helloFrame{
		Op: "hello", RequestID: s.requestID, ConnectionID: s.connectionID,
		CurrentSeq: s.backlogHigh, MinRetainedSeq: s.minRetainedSeq,
		HeartbeatIntervalMS: int(s.config.HeartbeatInterval.Milliseconds()),
		AckIntervalMS:       int(s.config.AckInterval.Milliseconds()), AckBatchSize: int(s.config.AckBatchSize),
		MaxUnackedEvents: int(s.config.MaxUnackedEvents),
	}
	if err := s.write(ctx, hello); err != nil {
		return err
	}

	deliveredThrough := s.lastSeq
	lastAck := s.lastSeq
	pending := make([]int64, 0, s.config.MaxUnackedEvents)
	lastAckProgress := time.Now()
	backlog := true
	target := s.backlogHigh

	heartbeat := time.NewTicker(s.config.HeartbeatInterval)
	defer heartbeat.Stop()
	ackWatch := time.NewTicker(time.Second)
	defer ackWatch.Stop()

	for {
		if deliveredThrough < target && len(pending) < int(s.config.MaxUnackedEvents) {
			available := int(s.config.MaxUnackedEvents) - len(pending)
			queryLimit := available
			if !backlog {
				queryLimit = int(s.config.MaxQueuedEvents) + 1
			}
			frames, err := s.store.Replay(ctx, s.user, s.sessionID, deliveredThrough, target, queryLimit)
			if err != nil {
				return err
			}
			if !backlog && len(frames) > int(s.config.MaxQueuedEvents) {
				return &closeError{code: statusSlowConsumer, reason: "outbound event queue exceeded"}
			}
			if len(frames) == 0 {
				deliveredThrough = target
			} else {
				queuedBytes := 0
				for _, frame := range frames {
					payload, err := json.Marshal(frame)
					if err != nil {
						return err
					}
					queuedBytes += len(payload)
				}
				s.logger.Debug("prepared websocket event batch",
					"connection_id", s.connectionID, "queued_events", len(frames), "queued_bytes", queuedBytes,
					"unacked_events", len(pending), "event_lag", target-deliveredThrough,
				)
				if !backlog && queuedBytes > int(s.config.MaxQueuedBytes) {
					return &closeError{code: statusSlowConsumer, reason: "outbound byte queue exceeded"}
				}
				sendCount := len(frames)
				if sendCount > available {
					sendCount = available
				}
				for _, frame := range frames[:sendCount] {
					if err := s.write(ctx, frame); err != nil {
						return err
					}
					pending = append(pending, frame.Seq)
					deliveredThrough = frame.Seq
				}
				if sendCount == len(frames) && len(frames) < queryLimit {
					deliveredThrough = target
				}
			}
			if backlog && deliveredThrough >= s.backlogHigh {
				backlog = false
				target = s.subscription.Latest()
			}
			continue
		}

		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case frame := <-s.protocolErrors:
			if err := s.write(ctx, frame); err != nil {
				return err
			}
			return &closeError{code: websocket.StatusPolicyViolation, reason: "protocol violation"}
		case frame := <-s.ephemeralErrors:
			if err := s.write(ctx, frame); err != nil {
				return err
			}
		case frame := <-s.subscription.Ephemeral():
			if err := s.write(ctx, frame); err != nil {
				return err
			}
		case ack := <-s.acks:
			if ack < lastAck || ack > deliveredThrough {
				if err := s.write(ctx, protocolErrorFrame{Op: "error", Code: "invalid_frame", Message: "ACK must be monotonic and cannot exceed delivered sequence."}); err != nil {
					return err
				}
				return &closeError{code: websocket.StatusPolicyViolation, reason: "invalid ack"}
			}
			if ack > lastAck {
				lastAck = ack
				lastAckProgress = time.Now()
			}
			index := 0
			for index < len(pending) && pending[index] <= ack {
				index++
			}
			pending = pending[index:]
		case <-s.subscription.Notifications():
			latest := s.subscription.Latest()
			if latest > target {
				target = latest
			}
		case <-heartbeat.C:
			pingCtx, cancel := context.WithTimeout(ctx, s.config.PongTimeout)
			err := s.connection.Ping(pingCtx)
			cancel()
			if err != nil {
				return err
			}
		case <-ackWatch.C:
			if len(pending) > 0 && time.Since(lastAckProgress) > s.config.AckTimeout {
				return &closeError{code: statusSlowConsumer, reason: "ack timeout"}
			}
		}
	}
}

func (s *session) write(ctx context.Context, frame any) error {
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	if uint64(len(payload)) > s.config.MaxFrameBytes {
		return &closeError{code: websocket.StatusInternalError, reason: "outbound frame exceeds configured limit"}
	}
	writeCtx, cancel := context.WithTimeout(ctx, s.config.PongTimeout)
	defer cancel()
	return s.connection.Write(writeCtx, websocket.MessageText, payload)
}
