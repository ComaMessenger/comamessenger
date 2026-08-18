package access

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	issuer   = "comamessenger"
	audience = "comamessenger-api"
)

var ErrInvalidToken = errors.New("invalid access token")

type Identity struct {
	ActorID   string
	OrgID     string
	SessionID string
	Role      string
}

type Claims struct {
	OrgID     string `json:"org_id"`
	SessionID string `json:"session_id"`
	Role      string `json:"role"`
	jwt.RegisteredClaims
}

type Manager struct {
	key []byte
	ttl time.Duration
	now func() time.Time
}

func NewManager(key string, ttl time.Duration) (*Manager, error) {
	if len(key) < 32 {
		return nil, fmt.Errorf("access signing key must be at least 32 bytes")
	}
	if ttl < time.Minute || ttl > time.Hour {
		return nil, fmt.Errorf("access token TTL must be between 1 minute and 1 hour")
	}
	return &Manager{key: []byte(key), ttl: ttl, now: time.Now}, nil
}

func (m *Manager) Issue(identity Identity) (string, time.Time, error) {
	now := m.now().UTC()
	expiresAt := now.Add(m.ttl)
	claims := Claims{
		OrgID:     identity.OrgID,
		SessionID: identity.SessionID,
		Role:      identity.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			Subject:   identity.ActorID,
			Audience:  jwt.ClaimStrings{audience},
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now.Add(-5 * time.Second)),
		},
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(m.key)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("sign access token: %w", err)
	}
	return token, expiresAt, nil
}

func (m *Manager) Parse(value string) (Identity, error) {
	claims := &Claims{}
	token, err := jwt.ParseWithClaims(value, claims, func(token *jwt.Token) (any, error) {
		return m.key, nil
	},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(issuer),
		jwt.WithAudience(audience),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(5*time.Second),
		jwt.WithTimeFunc(m.now),
	)
	if err != nil || !token.Valid || claims.Subject == "" || claims.OrgID == "" || claims.SessionID == "" {
		return Identity{}, ErrInvalidToken
	}
	return Identity{ActorID: claims.Subject, OrgID: claims.OrgID, SessionID: claims.SessionID, Role: claims.Role}, nil
}

func NewRefreshToken() (plain string, hash [sha256.Size]byte, err error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", hash, fmt.Errorf("generate refresh token: %w", err)
	}
	plain = base64.RawURLEncoding.EncodeToString(random)
	hash = sha256.Sum256([]byte(plain))
	return plain, hash, nil
}

func HashRefreshToken(value string) [sha256.Size]byte {
	return sha256.Sum256([]byte(value))
}
