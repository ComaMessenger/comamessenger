package agentconfig

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid   = errors.New("invalid agent configuration")
	ErrForbidden = errors.New("agent configuration forbidden")
	ErrNotFound  = errors.New("agent configuration not found")
)

type CredentialView struct {
	Configured bool       `json:"configured"`
	KeyHint    string     `json:"key_hint"`
	UpdatedAt  *time.Time `json:"updated_at"`
}

type UpdateCredentialInput struct {
	APIKey string `json:"api_key"`
	Clear  bool   `json:"clear"`
}

type RuntimeCredential struct {
	APIKey string `json:"api_key"`
}

type Service struct {
	pool *pgxpool.Pool
	aead cipher.AEAD
}

func NewService(pool *pgxpool.Pool, secret string) (*Service, error) {
	digest := sha256.Sum256([]byte("comamessenger/agent-provider-credentials/v1\x00" + secret))
	block, err := aes.NewCipher(digest[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Service{pool: pool, aead: aead}, nil
}

func (service *Service) Credential(ctx context.Context, current identity.User, agentID string) (CredentialView, error) {
	if !canManage(current) {
		return CredentialView{}, ErrForbidden
	}
	if uuid.Validate(agentID) != nil {
		return CredentialView{}, ErrNotFound
	}
	var nonce, ciphertext []byte
	var updatedAt time.Time
	err := service.pool.QueryRow(ctx, `SELECT credential.nonce,credential.ciphertext,credential.updated_at
		FROM agent_provider_credentials credential JOIN agents agent ON agent.org_id=credential.org_id AND agent.actor_id=credential.agent_id
		WHERE credential.org_id=$1 AND credential.agent_id=$2`, current.OrgID, agentID).Scan(&nonce, &ciphertext, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if err := service.pool.QueryRow(ctx, `SELECT true FROM agents WHERE org_id=$1 AND actor_id=$2`, current.OrgID, agentID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
			return CredentialView{}, ErrNotFound
		} else if err != nil {
			return CredentialView{}, err
		}
		return CredentialView{KeyHint: ""}, nil
	}
	if err != nil {
		return CredentialView{}, err
	}
	plain, err := service.open(current.OrgID, agentID, nonce, ciphertext)
	if err != nil {
		return CredentialView{}, err
	}
	return CredentialView{Configured: true, KeyHint: mask(plain), UpdatedAt: &updatedAt}, nil
}

func (service *Service) UpdateCredential(ctx context.Context, current identity.User, agentID string, input UpdateCredentialInput) (CredentialView, error) {
	if !canManage(current) {
		return CredentialView{}, ErrForbidden
	}
	if uuid.Validate(agentID) != nil || input.Clear == (strings.TrimSpace(input.APIKey) != "") || len(input.APIKey) > 16384 {
		return CredentialView{}, ErrInvalid
	}
	var nonce, ciphertext []byte
	var err error
	if !input.Clear {
		nonce, ciphertext, err = service.seal(current.OrgID, agentID, strings.TrimSpace(input.APIKey))
		if err != nil {
			return CredentialView{}, err
		}
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return CredentialView{}, err
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT true FROM agents WHERE org_id=$1 AND actor_id=$2 FOR UPDATE`, current.OrgID, agentID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		return CredentialView{}, ErrNotFound
	} else if err != nil {
		return CredentialView{}, err
	}
	if input.Clear {
		if _, err := tx.Exec(ctx, `DELETE FROM agent_provider_credentials WHERE org_id=$1 AND agent_id=$2`, current.OrgID, agentID); err != nil {
			return CredentialView{}, err
		}
	} else if _, err := tx.Exec(ctx, `INSERT INTO agent_provider_credentials(agent_id,org_id,nonce,ciphertext,updated_by)
		VALUES($1,$2,$3,$4,$5)
		ON CONFLICT(agent_id) DO UPDATE SET nonce=EXCLUDED.nonce,ciphertext=EXCLUDED.ciphertext,updated_by=EXCLUDED.updated_by,updated_at=now()`,
		agentID, current.OrgID, nonce, ciphertext, current.ActorID); err != nil {
		return CredentialView{}, err
	}
	if err := auditCredential(ctx, tx, current, agentID, !input.Clear); err != nil {
		return CredentialView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CredentialView{}, err
	}
	if input.Clear {
		return CredentialView{}, nil
	}
	return service.Credential(ctx, current, agentID)
}

func auditCredential(ctx context.Context, tx pgx.Tx, current identity.User, agentID string, configured bool) error {
	auditID, err := id.New()
	if err != nil {
		return err
	}
	metadata, _ := json.Marshal(map[string]bool{"configured": configured})
	_, err = tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'agent.provider_credential.update','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata)
	return err
}

func (service *Service) RuntimeCredential(ctx context.Context, current identity.User, authentication access.Identity) (RuntimeCredential, error) {
	if authentication.AuthenticationKind != "api_key" || authentication.ActorID != current.ActorID || authentication.OrgID != current.OrgID || !slices.Contains(authentication.Scopes, "runtime:execute") {
		return RuntimeCredential{}, ErrForbidden
	}
	var nonce, ciphertext []byte
	err := service.pool.QueryRow(ctx, `SELECT nonce,ciphertext FROM agent_provider_credentials WHERE org_id=$1 AND agent_id=$2`, current.OrgID, current.ActorID).Scan(&nonce, &ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return RuntimeCredential{}, ErrNotFound
	}
	if err != nil {
		return RuntimeCredential{}, err
	}
	plain, err := service.open(current.OrgID, current.ActorID, nonce, ciphertext)
	if err != nil {
		return RuntimeCredential{}, err
	}
	return RuntimeCredential{APIKey: plain}, nil
}

func (service *Service) seal(orgID, agentID, value string) ([]byte, []byte, error) {
	nonce := make([]byte, service.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, err
	}
	return nonce, service.aead.Seal(nil, nonce, []byte(value), aad(orgID, agentID)), nil
}

func (service *Service) open(orgID, agentID string, nonce, ciphertext []byte) (string, error) {
	plain, err := service.aead.Open(nil, nonce, ciphertext, aad(orgID, agentID))
	if err != nil {
		return "", fmt.Errorf("decrypt agent provider credential: %w", err)
	}
	return string(plain), nil
}

func aad(orgID, agentID string) []byte { return []byte(orgID + "\x00" + agentID + "\x001") }
func canManage(current identity.User) bool {
	return permission.Allows(current.OrgRole, current.Permissions, permission.AgentsManage)
}
func mask(value string) string {
	if len(value) <= 8 {
		return "••••"
	}
	return value[:4] + "••••" + value[len(value)-4:]
}
