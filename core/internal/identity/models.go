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
	ErrEmailTaken          = errors.New("email is already in use")
	ErrTokenInvalid        = errors.New("token is invalid")
	ErrEmailNotConfigured  = errors.New("email is not configured")
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
	ActorID            string            `json:"id"`
	OrgID              string            `json:"org_id"`
	OrganizationName   string            `json:"organization_name"`
	OrgRole            string            `json:"role"`
	Email              string            `json:"email"`
	DisplayName        string            `json:"display_name"`
	Handle             string            `json:"handle"`
	Title              string            `json:"title"`
	About              string            `json:"about"`
	Timezone           string            `json:"timezone"`
	Status             string            `json:"status"`
	Permissions        []permission.Code `json:"permissions"`
	CreatedAt          time.Time         `json:"created_at"`
	PasswordHash       string            `json:"-"`
	MustChangePassword bool              `json:"must_change_password"`
	StatusEmoji        string            `json:"status_emoji"`
	StatusText         string            `json:"status_text"`
	StatusExpiresAt    *time.Time        `json:"status_expires_at"`
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
	Title       *string `json:"title"`
	About       *string `json:"about"`
	Timezone    *string `json:"timezone"`
}

type ChangePasswordInput struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

type ChangeEmailInput struct {
	NewEmail        string `json:"new_email"`
	CurrentPassword string `json:"current_password"`
}

type ConfirmEmailInput struct {
	Token string `json:"token"`
}

type ForgotPasswordInput struct {
	Email string `json:"email"`
}

type ResetPasswordInput struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

type SetStatusInput struct {
	Emoji     string     `json:"emoji"`
	Text      string     `json:"text"`
	ExpiresAt *time.Time `json:"expires_at"`
}

type CustomStatus struct {
	Emoji     string     `json:"emoji"`
	Text      string     `json:"text"`
	ExpiresAt *time.Time `json:"expires_at"`
}

type PasswordResetTarget struct {
	OrgID   string
	ActorID string
	Email   string
	Role    string
	Status  string
}

type PasswordResetRecord struct {
	ID        string
	OrgID     string
	ActorID   string
	TokenHash []byte
	Delivery  string
	IssuedBy  *string
	ExpiresAt time.Time
	AuditID   string
}

type EmailChangeResult struct {
	PendingConfirmation bool  `json:"pending_confirmation"`
	User                *User `json:"user"`
}

type EmailChangeRecord struct {
	ID        string
	OrgID     string
	ActorID   string
	NewEmail  string
	TokenHash []byte
	ExpiresAt time.Time
	AuditID   string
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
	EmailSent bool      `json:"email_sent"`
}

type InvitationSummary struct {
	ID            string     `json:"id"`
	Email         string     `json:"email"`
	Role          string     `json:"role"`
	CreatedByID   string     `json:"created_by_id"`
	CreatedByName string     `json:"created_by_name"`
	CreatedAt     time.Time  `json:"created_at"`
	ExpiresAt     time.Time  `json:"expires_at"`
	EmailSentAt   *time.Time `json:"email_sent_at"`
	Status        string     `json:"status"`
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
