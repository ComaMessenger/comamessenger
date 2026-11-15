package identity

import (
	"context"
	"log/slog"
	"time"
)

// StatusExpiryPass is one more pass of RunStatusExpiry: another package's
// time-driven changes of people's statuses («Отсутствую» starts and ends,
// phase 6.7). It returns the high watermark of the events it wrote per
// organization; RunStatusExpiry wakes realtime for them.
type StatusExpiryPass func(ctx context.Context, now time.Time) (map[string]int64, error)

// AddStatusExpiryPass registers a pass. Call it before RunStatusExpiry.
func (s *Service) AddStatusExpiryPass(pass StatusExpiryPass) {
	s.statusExpiryPasses = append(s.statusExpiryPasses, pass)
}

func (s *Service) RunStatusExpiry(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.expireStatusesOnce(ctx)
		}
	}
}

func (s *Service) expireStatusesOnce(ctx context.Context) {
	if high, err := s.repository.ExpireStatuses(ctx, s.now().UTC(), 100); err == nil {
		s.wake(high)
	}
	for _, pass := range s.statusExpiryPasses {
		high, err := pass(ctx, s.now().UTC())
		if err != nil {
			slog.Warn("status expiry pass failed", "error", err)
			continue
		}
		s.wake(high)
	}
}

func (s *Service) wake(high map[string]int64) {
	if s.afterCommit == nil {
		return
	}
	for orgID, seq := range high {
		s.afterCommit(orgID, seq)
	}
}
