package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
)

type rateDimension struct {
	name, subject string
	limit         int
}

func (service *Service) PlatformSettings(ctx context.Context, current identity.User) (PlatformSettings, error) {
	if !canManage(current) {
		return PlatformSettings{}, ErrForbidden
	}
	var result PlatformSettings
	if err := service.pool.QueryRow(ctx, `SELECT agent_rate_limit_per_minute FROM organizations WHERE id=$1`, current.OrgID).Scan(&result.OrganizationRateLimitPerMinute); errors.Is(err, pgx.ErrNoRows) {
		return PlatformSettings{}, ErrNotFound
	} else if err != nil {
		return PlatformSettings{}, fmt.Errorf("get agent platform settings: %w", err)
	}
	return result, nil
}

func (service *Service) UpdatePlatformSettings(ctx context.Context, current identity.User, input UpdatePlatformSettingsInput) (PlatformSettings, error) {
	if !canManage(current) {
		return PlatformSettings{}, ErrForbidden
	}
	if input.OrganizationRateLimitPerMinute < 1 || input.OrganizationRateLimitPerMinute > 1000000 {
		return PlatformSettings{}, fmt.Errorf("%w: organization rate limit must be between 1 and 1000000", ErrInvalid)
	}
	auditID, err := id.New()
	if err != nil {
		return PlatformSettings{}, err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return PlatformSettings{}, fmt.Errorf("begin agent settings update: %w", err)
	}
	defer tx.Rollback(ctx)
	var previous int
	if err := tx.QueryRow(ctx, `UPDATE organizations SET agent_rate_limit_per_minute=$2,version=version+1 WHERE id=$1 RETURNING agent_rate_limit_per_minute`, current.OrgID, input.OrganizationRateLimitPerMinute).Scan(&previous); err != nil {
		return PlatformSettings{}, fmt.Errorf("update agent platform settings: %w", err)
	}
	metadata, _ := json.Marshal(map[string]int{"organization_rate_limit_per_minute": input.OrganizationRateLimitPerMinute})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'agent.settings.update','organization',$2,$4)`, auditID, current.OrgID, current.ActorID, metadata); err != nil {
		return PlatformSettings{}, fmt.Errorf("audit agent settings update: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return PlatformSettings{}, fmt.Errorf("commit agent settings update: %w", err)
	}
	return PlatformSettings{OrganizationRateLimitPerMinute: input.OrganizationRateLimitPerMinute}, nil
}

func (service *Service) acquireBaseRateLimits(ctx context.Context, orgID, agentID, keyID string, orgLimit, agentLimit, keyLimit int) error {
	return service.acquireRateLimits(ctx, orgID, []rateDimension{
		{name: "organization", subject: orgID, limit: orgLimit},
		{name: "agent", subject: agentID, limit: agentLimit},
		{name: "key", subject: keyID, limit: keyLimit},
	})
}

func (service *Service) AcquireProviderRateLimit(ctx context.Context, authenticated access.Identity, provider string) error {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if authenticated.AuthenticationKind != "api_key" || authenticated.KeyID == "" || provider == "" || len(provider) > 100 {
		return identity.ErrUnauthorized
	}
	var limit int
	err := service.pool.QueryRow(ctx, `SELECT agent.provider_rate_limit_per_minute FROM agent_api_keys key JOIN agents agent ON agent.org_id=key.org_id AND agent.actor_id=key.agent_id JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id WHERE key.id=$1 AND key.org_id=$2 AND key.agent_id=$3 AND key.revoked_at IS NULL AND (key.expires_at IS NULL OR key.expires_at>now()) AND agent.enabled AND key.scopes<@agent.allowed_scopes AND actor.status='active' AND actor.deleted_at IS NULL`, authenticated.KeyID, authenticated.OrgID, authenticated.ActorID).Scan(&limit)
	if err != nil {
		return identity.ErrUnauthorized
	}
	return service.acquireRateLimits(ctx, authenticated.OrgID, []rateDimension{{name: "provider", subject: authenticated.ActorID + ":" + provider, limit: limit}})
}

func (service *Service) acquireRateLimits(ctx context.Context, orgID string, dimensions []rateDimension) error {
	window := service.now().UTC().Truncate(time.Minute)
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin agent rate limit: %w", err)
	}
	defer tx.Rollback(ctx)
	for _, dimension := range dimensions {
		var count int
		err := tx.QueryRow(ctx, `INSERT INTO agent_rate_limit_buckets(org_id,dimension,subject,window_start,request_count) VALUES($1,$2,$3,$4,1) ON CONFLICT(org_id,dimension,subject,window_start) DO UPDATE SET request_count=agent_rate_limit_buckets.request_count+1 RETURNING request_count`, orgID, dimension.name, dimension.subject, window).Scan(&count)
		if err != nil {
			return fmt.Errorf("increment %s agent rate limit: %w", dimension.name, err)
		}
		if count > dimension.limit {
			return ErrRateLimited
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit agent rate limit: %w", err)
	}
	return nil
}

func (service *Service) RunRateLimitCleanup(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, _ = service.pool.Exec(ctx, `DELETE FROM agent_rate_limit_buckets WHERE window_start<now()-interval '10 minutes'`)
		}
	}
}
