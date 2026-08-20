package identity

import (
	"errors"
	"fmt"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/permission"
)

var (
	ErrAlreadyBootstrapped = errors.New("instance is already bootstrapped")
	ErrInvalidCredentials  = errors.New("invalid credentials")
	ErrInvalidRefreshToken = errors.New("invalid refresh token")
	ErrRefreshReuse        = errors.New("refresh token reuse detected")
	ErrUnauthorized        = errors.New("unauthorized")
	ErrNotFound            = errors.New("not found")
	ErrInvitationInvalid   = errors.New("invitation is invalid")
	ErrForbidden           = errors.New("forbidden")
	ErrReauthentication    = errors.New("reauthentication failed")
	ErrConflict            = errors.New("conflict")
)

type ValidationError struct {
	message string
}

func (e *ValidationError) Error() string { return e.message }

func validationErrorf(format string, args ...any) error {
	return &ValidationError{message: fmt.Sprintf(format, args...)}
}

func IsValidationError(err error) bool {
	var validationError *ValidationError
	return errors.As(err, &validationError)
}

type User struct {
	ActorID          string            `json:"id"`
	OrgID            string            `json:"org_id"`
	OrganizationName string            `json:"organization_name"`
	OrgRole          string            `json:"role"`
	Email            string            `json:"email"`
	DisplayName      string            `json:"display_name"`
	Handle           string            `json:"handle"`
	Timezone         string            `json:"timezone"`
	Status           string            `json:"status"`
	Permissions      []permission.Code `json:"permissions"`
	CreatedAt        time.Time         `json:"created_at"`
	PasswordHash     string            `json:"-"`
}

type Session struct {
	ID         string     `json:"id"`
	ActorID    string     `json:"-"`
	UserAgent  string     `json:"user_agent"`
	IPAddress  string     `json:"ip_address,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	LastSeenAt time.Time  `json:"last_seen_at"`
	ExpiresAt  time.Time  `json:"expires_at"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
	Current    bool       `json:"current"`
}

type Tokens struct {
	AccessToken  string    `json:"access_token"`
	AccessExpiry time.Time `json:"access_expires_at"`
	RefreshToken string    `json:"-"`
	User         User      `json:"user"`
}

type Device struct {
	UserAgent string
	IPAddress string
}

type BootstrapInput struct {
	OrganizationName string `json:"organization_name"`
	OrganizationSlug string `json:"organization_slug"`
	DisplayName      string `json:"display_name"`
	Handle           string `json:"handle"`
	Email            string `json:"email"`
	Password         string `json:"password"`
	Timezone         string `json:"timezone"`
}

type LoginInput struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type UpdateProfileInput struct {
	DisplayName *string `json:"display_name"`
	Handle      *string `json:"handle"`
	Timezone    *string `json:"timezone"`
}

type TransferOwnershipInput struct {
	TargetActorID   string `json:"target_actor_id"`
	CurrentPassword string `json:"current_password"`
}

type OwnershipTransfer struct {
	OrgID          string
	CurrentActorID string
	TargetActorID  string
	AuditID        string
}

type CreateInvitationInput struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

type AcceptInvitationInput struct {
	DisplayName string `json:"display_name"`
	Handle      string `json:"handle"`
	Password    string `json:"password"`
	Timezone    string `json:"timezone"`
}

type Invitation struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Role      string    `json:"role"`
	ExpiresAt time.Time `json:"expires_at"`
	AcceptURL string    `json:"accept_url,omitempty"`
}

type InvitationRecord struct {
	ID        string
	OrgID     string
	Email     string
	Role      string
	TokenHash []byte
	CreatedBy string
	ExpiresAt time.Time
	AuditID   string
}

type InvitationAcceptance struct {
	TokenHash      []byte
	ActorID        string
	DisplayName    string
	Handle         string
	PasswordHash   string
	Timezone       string
	SessionID      string
	FamilyID       string
	RefreshHash    []byte
	SessionExpires time.Time
	Device         Device
	AuditID        string
}

type BootstrapRecord struct {
	OrganizationID   string
	OrganizationName string
	OrganizationSlug string
	ActorID          string
	DisplayName      string
	Handle           string
	Email            string
	PasswordHash     string
	Timezone         string
	SessionID        string
	FamilyID         string
	RefreshHash      []byte
	SessionExpiresAt time.Time
	Device           Device
	AuditID          string
}

type NewSession struct {
	ID          string
	FamilyID    string
	RefreshHash []byte
	ExpiresAt   time.Time
	Device      Device
}
