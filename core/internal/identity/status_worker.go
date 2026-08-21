package identity

import (
	"context"
	"time"
)

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
			high, err := s.repository.ExpireStatuses(ctx, s.now().UTC(), 100)
			if err != nil {
				continue
			}
			if s.afterCommit != nil {
				for orgID, seq := range high {
					s.afterCommit(orgID, seq)
				}
			}
		}
	}
}
