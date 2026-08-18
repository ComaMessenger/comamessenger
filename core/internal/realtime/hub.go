package realtime

import (
	"context"
	"errors"
	"sync"
)

var ErrConnectionLimit = errors.New("realtime actor connection limit reached")

type Subscription struct {
	OrgID   string
	ActorID string

	mu         sync.Mutex
	latest     int64
	notify     chan struct{}
	ctx        context.Context
	cancel     context.CancelCauseFunc
	unregister func()
	once       sync.Once
}

func (s *Subscription) Notifications() <-chan struct{} { return s.notify }
func (s *Subscription) Context() context.Context       { return s.ctx }

func (s *Subscription) Latest() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.latest
}

func (s *Subscription) advance(seq int64) {
	s.mu.Lock()
	if seq > s.latest {
		s.latest = seq
	}
	s.mu.Unlock()
	select {
	case s.notify <- struct{}{}:
	default:
	}
}

func (s *Subscription) Close() {
	s.once.Do(func() {
		s.cancel(context.Canceled)
		s.unregister()
	})
}

type orgState struct {
	watermark int64
	actors    map[string]int
	members   map[*Subscription]struct{}
}

type OrgSnapshot struct {
	OrgID     string
	Watermark int64
}

type Hub struct {
	mu                     sync.Mutex
	organizations          map[string]*orgState
	maxConnectionsPerActor int
	closed                 bool
}

func NewHub(maxConnectionsPerActor int) *Hub {
	return &Hub{organizations: make(map[string]*orgState), maxConnectionsPerActor: maxConnectionsPerActor}
}

func (h *Hub) Register(orgID, actorID string, initialWatermark int64) (*Subscription, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, context.Canceled
	}
	state := h.organizations[orgID]
	if state == nil {
		state = &orgState{watermark: initialWatermark, actors: make(map[string]int), members: make(map[*Subscription]struct{})}
		h.organizations[orgID] = state
	} else if initialWatermark > state.watermark {
		state.watermark = initialWatermark
		for member := range state.members {
			member.advance(initialWatermark)
		}
	}
	if state.actors[actorID] >= h.maxConnectionsPerActor {
		return nil, ErrConnectionLimit
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	subscription := &Subscription{
		OrgID: orgID, ActorID: actorID, latest: state.watermark, notify: make(chan struct{}, 1), ctx: ctx, cancel: cancel,
	}
	subscription.unregister = func() { h.unregister(subscription) }
	state.actors[actorID]++
	state.members[subscription] = struct{}{}
	return subscription, nil
}

func (h *Hub) unregister(subscription *Subscription) {
	h.mu.Lock()
	defer h.mu.Unlock()
	state := h.organizations[subscription.OrgID]
	if state == nil {
		return
	}
	delete(state.members, subscription)
	state.actors[subscription.ActorID]--
	if state.actors[subscription.ActorID] == 0 {
		delete(state.actors, subscription.ActorID)
	}
	if len(state.members) == 0 {
		delete(h.organizations, subscription.OrgID)
	}
}

func (h *Hub) Advance(orgID string, seq int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	state := h.organizations[orgID]
	if state == nil || seq <= state.watermark {
		return
	}
	state.watermark = seq
	for subscription := range state.members {
		subscription.advance(seq)
	}
}

func (h *Hub) Organizations() []OrgSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	result := make([]OrgSnapshot, 0, len(h.organizations))
	for orgID, state := range h.organizations {
		result = append(result, OrgSnapshot{OrgID: orgID, Watermark: state.watermark})
	}
	return result
}

func (h *Hub) Shutdown(cause error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	for _, state := range h.organizations {
		for subscription := range state.members {
			subscription.cancel(cause)
		}
	}
}
