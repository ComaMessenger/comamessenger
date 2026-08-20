package identity

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/mail"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/password"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
)

var (
	slugPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}$`)
	handlePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{1,31}$`)
)

type Service struct {
	repository    *Repository
	hasher        *password.Hasher
	tokens        *access.Manager
	refreshTTL    time.Duration
	invitationTTL time.Duration
	publicAppURL  string
	development   bool
	dummyHash     string
	now           func() time.Time
	emailSender   EmailSender
}

type EmailSender interface {
	EmailConfigured(context.Context, string) (bool, error)
	SendEmail(context.Context, string, string, string, string) error
}

func NewService(repository *Repository, hasher *password.Hasher, tokens *access.Manager, refreshTTL, invitationTTL time.Duration, publicAppURL string, development bool, emailSenders ...EmailSender) (*Service, error) {
	dummyHash, err := hasher.Hash("comamessenger dummy password")
	if err != nil {
		return nil, fmt.Errorf("create dummy password hash: %w", err)
	}
	var emailSender EmailSender
	if len(emailSenders) > 0 {
		emailSender = emailSenders[0]
	}
	return &Service{repository: repository, hasher: hasher, tokens: tokens, refreshTTL: refreshTTL,
		invitationTTL: invitationTTL, publicAppURL: strings.TrimRight(publicAppURL, "/"), development: development,
		dummyHash: dummyHash, now: time.Now, emailSender: emailSender}, nil
}

func (s *Service) BootstrapStatus(ctx context.Context) (bool, error) {
	return s.repository.BootstrapStatus(ctx)
}

func (s *Service) Bootstrap(ctx context.Context, input BootstrapInput, device Device) (Tokens, error) {
	input.OrganizationName = strings.TrimSpace(input.OrganizationName)
	input.OrganizationSlug = strings.ToLower(strings.TrimSpace(input.OrganizationSlug))
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	input.Handle = strings.ToLower(strings.TrimSpace(input.Handle))
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	input.Timezone = strings.TrimSpace(input.Timezone)
	if input.Timezone == "" {
		input.Timezone = "UTC"
	}
	if err := validateBootstrap(input); err != nil {
		return Tokens{}, err
	}
	passwordHash, err := s.hasher.Hash(input.Password)
	if err != nil {
		return Tokens{}, err
	}
	ids, err := newIDs(5)
	if err != nil {
		return Tokens{}, fmt.Errorf("generate bootstrap identifiers: %w", err)
	}
	refreshToken, refreshHash, err := access.NewRefreshToken()
	if err != nil {
		return Tokens{}, err
	}
	now := s.now().UTC()
	user, err := s.repository.Bootstrap(ctx, BootstrapRecord{
		OrganizationID: ids[0], OrganizationName: input.OrganizationName, OrganizationSlug: input.OrganizationSlug,
		ActorID: ids[1], DisplayName: input.DisplayName, Handle: input.Handle, Email: input.Email,
		PasswordHash: passwordHash, Timezone: input.Timezone, SessionID: ids[2], FamilyID: ids[3],
		RefreshHash: refreshHash[:], SessionExpiresAt: now.Add(s.refreshTTL), Device: device, AuditID: ids[4],
	})
	if err != nil {
		return Tokens{}, err
	}
	return s.issue(user, ids[2], refreshToken)
}

func (s *Service) Login(ctx context.Context, input LoginInput, device Device) (Tokens, error) {
	email := strings.ToLower(strings.TrimSpace(input.Email))
	user, err := s.repository.FindUserByEmail(ctx, email)
	hash := s.dummyHash
	if err == nil {
		hash = user.PasswordHash
	}
	matched, verifyErr := s.hasher.Verify(hash, input.Password)
	if verifyErr != nil || err != nil || !matched || user.Status != "active" {
		return Tokens{}, ErrInvalidCredentials
	}
	ids, err := newIDs(2)
	if err != nil {
		return Tokens{}, fmt.Errorf("generate session identifiers: %w", err)
	}
	refreshToken, refreshHash, err := access.NewRefreshToken()
	if err != nil {
		return Tokens{}, err
	}
	if err := s.repository.CreateSession(ctx, user.OrgID, user.ActorID, NewSession{
		ID: ids[0], FamilyID: ids[1], RefreshHash: refreshHash[:],
		ExpiresAt: s.now().UTC().Add(s.refreshTTL), Device: device,
	}); err != nil {
		return Tokens{}, err
	}
	return s.issue(user, ids[0], refreshToken)
}

func (s *Service) Refresh(ctx context.Context, oldRefresh string, device Device) (Tokens, error) {
	if oldRefresh == "" || len(oldRefresh) > 1024 {
		return Tokens{}, ErrInvalidRefreshToken
	}
	sessionID, err := id.New()
	if err != nil {
		return Tokens{}, err
	}
	refreshToken, refreshHash, err := access.NewRefreshToken()
	if err != nil {
		return Tokens{}, err
	}
	now := s.now().UTC()
	oldHash := sha256.Sum256([]byte(oldRefresh))
	user, err := s.repository.RotateSession(ctx, oldHash[:], NewSession{
		ID: sessionID, RefreshHash: refreshHash[:], ExpiresAt: now.Add(s.refreshTTL), Device: device,
	}, now)
	if err != nil {
		return Tokens{}, err
	}
	return s.issue(user, sessionID, refreshToken)
}

func (s *Service) Authenticate(ctx context.Context, bearer string) (User, access.Identity, error) {
	identity, err := s.tokens.Parse(bearer)
	if err != nil {
		return User{}, access.Identity{}, ErrUnauthorized
	}
	user, err := s.repository.ResolveSession(ctx, identity.SessionID, identity.ActorID, s.now().UTC())
	if err != nil || user.OrgID != identity.OrgID {
		return User{}, access.Identity{}, ErrUnauthorized
	}
	return user, identity, nil
}

func (s *Service) Logout(ctx context.Context, actorID, sessionID string) error {
	return s.repository.RevokeSession(ctx, actorID, sessionID, s.now().UTC())
}

func (s *Service) RevokeSession(ctx context.Context, actorID, sessionID string) error {
	return s.repository.RevokeSession(ctx, actorID, sessionID, s.now().UTC())
}

func (s *Service) ListSessions(ctx context.Context, actorID, currentSessionID string) ([]Session, error) {
	return s.repository.ListSessions(ctx, actorID, currentSessionID)
}

func (s *Service) RevokeOtherSessions(ctx context.Context, actorID, currentSessionID string) ([]string, error) {
	return s.repository.RevokeOtherSessions(ctx, actorID, currentSessionID, s.now().UTC())
}

func (s *Service) UpdateProfile(ctx context.Context, current User, input UpdateProfileInput) (User, error) {
	displayName := current.DisplayName
	handle := current.Handle
	title := current.Title
	about := current.About
	timezone := current.Timezone
	if input.DisplayName != nil {
		displayName = strings.TrimSpace(*input.DisplayName)
		if len(displayName) < 1 || len(displayName) > 120 {
			return User{}, validationErrorf("display_name must contain 1 to 120 characters")
		}
	}
	if input.Handle != nil {
		handle = strings.ToLower(strings.TrimSpace(*input.Handle))
		if !handlePattern.MatchString(handle) {
			return User{}, validationErrorf("handle has invalid format")
		}
	}
	if input.Title != nil {
		title = strings.TrimSpace(*input.Title)
		if len([]rune(title)) > 120 {
			return User{}, validationErrorf("title must contain at most 120 characters")
		}
	}
	if input.About != nil {
		about = strings.TrimSpace(*input.About)
		if len([]rune(about)) > 280 {
			return User{}, validationErrorf("about must contain at most 280 characters")
		}
	}
	if input.Timezone != nil {
		timezone = strings.TrimSpace(*input.Timezone)
		if len(timezone) < 1 || len(timezone) > 64 {
			return User{}, validationErrorf("timezone has invalid length")
		}
	}
	return s.repository.UpdateProfile(ctx, current.ActorID, displayName, handle, title, about, timezone)
}

func (s *Service) ChangePassword(ctx context.Context, current User, currentSessionID string, input ChangePasswordInput) ([]string, error) {
	if len(input.CurrentPassword) < 1 || len(input.CurrentPassword) > 1024 {
		return nil, validationErrorf("current_password length must be between 1 and 1024 bytes")
	}
	if len(input.NewPassword) < 10 || len(input.NewPassword) > 1024 {
		return nil, validationErrorf("new_password length must be between 10 and 1024 bytes")
	}
	passwordHash, err := s.repository.PasswordHash(ctx, current.OrgID, current.ActorID)
	if err != nil {
		return nil, err
	}
	matched, err := s.hasher.Verify(passwordHash, input.CurrentPassword)
	if err != nil || !matched {
		return nil, ErrReauthentication
	}
	unchanged, err := s.hasher.Verify(passwordHash, input.NewPassword)
	if err != nil {
		return nil, err
	}
	if unchanged {
		return nil, validationErrorf("new_password must differ from current_password")
	}
	newHash, err := s.hasher.Hash(input.NewPassword)
	if err != nil {
		return nil, err
	}
	auditID, err := id.New()
	if err != nil {
		return nil, fmt.Errorf("generate password change audit identifier: %w", err)
	}
	return s.repository.ChangePassword(ctx, current.OrgID, current.ActorID, currentSessionID, newHash, auditID, s.now().UTC())
}

func (s *Service) ChangeEmail(ctx context.Context, current User, currentSessionID string, input ChangeEmailInput) (EmailChangeResult, []string, error) {
	newEmail := strings.ToLower(strings.TrimSpace(input.NewEmail))
	parsedEmail, err := mail.ParseAddress(newEmail)
	if err != nil || parsedEmail.Address != newEmail || len(newEmail) > 254 {
		return EmailChangeResult{}, nil, validationErrorf("new_email has invalid format")
	}
	if newEmail == strings.ToLower(current.Email) {
		return EmailChangeResult{}, nil, validationErrorf("new_email must differ from the current email")
	}
	if len(input.CurrentPassword) < 1 || len(input.CurrentPassword) > 1024 {
		return EmailChangeResult{}, nil, validationErrorf("current_password length must be between 1 and 1024 bytes")
	}
	passwordHash, err := s.repository.PasswordHash(ctx, current.OrgID, current.ActorID)
	if err != nil {
		return EmailChangeResult{}, nil, err
	}
	matched, err := s.hasher.Verify(passwordHash, input.CurrentPassword)
	if err != nil || !matched {
		return EmailChangeResult{}, nil, ErrReauthentication
	}
	configured := false
	if s.emailSender != nil {
		configured, err = s.emailSender.EmailConfigured(ctx, current.OrgID)
		if err != nil {
			return EmailChangeResult{}, nil, err
		}
	}
	now := s.now().UTC()
	ids, err := newIDs(2)
	if err != nil {
		return EmailChangeResult{}, nil, err
	}
	if !configured {
		updated, revoked, err := s.repository.ChangeEmailImmediate(ctx, current.OrgID, current.ActorID, currentSessionID, newEmail, ids[0], now)
		if err != nil {
			return EmailChangeResult{}, nil, err
		}
		return EmailChangeResult{User: &updated}, revoked, nil
	}
	token, tokenHash, err := access.NewRefreshToken()
	if err != nil {
		return EmailChangeResult{}, nil, err
	}
	record := EmailChangeRecord{ID: ids[0], OrgID: current.OrgID, ActorID: current.ActorID, NewEmail: newEmail, TokenHash: tokenHash[:], ExpiresAt: now.Add(time.Hour), AuditID: ids[1]}
	if err := s.repository.CreateEmailChange(ctx, record, now); err != nil {
		return EmailChangeResult{}, nil, err
	}
	confirmationURL := s.publicAppURL + "/settings/security?email_token=" + url.QueryEscape(token)
	body := "Confirm your Coma email change within one hour:\n" + confirmationURL
	if err := s.emailSender.SendEmail(ctx, current.OrgID, newEmail, "Confirm your Coma email change", body); err != nil {
		_ = s.repository.CancelEmailChange(ctx, record.ID, current.ActorID, now)
		return EmailChangeResult{}, nil, fmt.Errorf("send email confirmation: %w", err)
	}
	_ = s.emailSender.SendEmail(ctx, current.OrgID, current.Email, "Coma email change requested", "A change of your Coma account email was requested. If this was not you, change your password and revoke other sessions.")
	return EmailChangeResult{PendingConfirmation: true}, nil, nil
}

func (s *Service) ConfirmEmail(ctx context.Context, current User, currentSessionID string, input ConfirmEmailInput) (User, []string, error) {
	if input.Token == "" || len(input.Token) > 1024 {
		return User{}, nil, ErrTokenInvalid
	}
	hash := sha256.Sum256([]byte(input.Token))
	auditID, err := id.New()
	if err != nil {
		return User{}, nil, err
	}
	return s.repository.ConfirmEmailChange(ctx, current.OrgID, current.ActorID, currentSessionID, hash[:], auditID, s.now().UTC())
}

func (s *Service) TransferOwnership(ctx context.Context, current User, input TransferOwnershipInput) (User, error) {
	if current.OrgRole != "owner" {
		return User{}, ErrForbidden
	}
	input.TargetActorID = strings.TrimSpace(input.TargetActorID)
	if _, err := uuid.Parse(input.TargetActorID); err != nil {
		return User{}, validationErrorf("target_actor_id must be a valid UUID")
	}
	if input.TargetActorID == current.ActorID {
		return User{}, validationErrorf("target_actor_id must identify another active user")
	}
	if len(input.CurrentPassword) < 1 || len(input.CurrentPassword) > 1024 {
		return User{}, validationErrorf("current_password length must be between 1 and 1024 bytes")
	}
	passwordHash, err := s.repository.PasswordHash(ctx, current.OrgID, current.ActorID)
	if err != nil {
		return User{}, err
	}
	matched, err := s.hasher.Verify(passwordHash, input.CurrentPassword)
	if err != nil || !matched {
		return User{}, ErrReauthentication
	}
	auditID, err := id.New()
	if err != nil {
		return User{}, fmt.Errorf("generate ownership transfer audit identifier: %w", err)
	}
	return s.repository.TransferOwnership(ctx, OwnershipTransfer{
		OrgID: current.OrgID, CurrentActorID: current.ActorID,
		TargetActorID: input.TargetActorID, AuditID: auditID,
	})
}

func (s *Service) CreateInvitation(ctx context.Context, current User, input CreateInvitationInput) (Invitation, error) {
	if !permission.Allows(current.OrgRole, current.Permissions, permission.InvitationsManage) {
		return Invitation{}, ErrForbidden
	}
	email := strings.ToLower(strings.TrimSpace(input.Email))
	parsedEmail, err := mail.ParseAddress(email)
	if err != nil || parsedEmail.Address != email || len(email) > 254 {
		return Invitation{}, validationErrorf("email has invalid format")
	}
	role := strings.ToLower(strings.TrimSpace(input.Role))
	policyRole, policyTTL, err := s.repository.InvitationPolicy(ctx, current.OrgID)
	if err != nil {
		return Invitation{}, err
	}
	if role == "" {
		role = policyRole
	}
	if role != "member" && role != "admin" {
		return Invitation{}, validationErrorf("role must be admin or member")
	}
	ids, err := newIDs(2)
	if err != nil {
		return Invitation{}, err
	}
	token, tokenHash, err := access.NewRefreshToken()
	if err != nil {
		return Invitation{}, err
	}
	if policyTTL <= 0 {
		policyTTL = s.invitationTTL
	}
	expiresAt := s.now().UTC().Add(policyTTL)
	invitation, err := s.repository.CreateInvitation(ctx, InvitationRecord{
		ID: ids[0], OrgID: current.OrgID, Email: email, Role: role, TokenHash: tokenHash[:],
		CreatedBy: current.ActorID, ExpiresAt: expiresAt, AuditID: ids[1],
	})
	if err != nil {
		return Invitation{}, err
	}
	invitation.AcceptURL = s.publicAppURL + "/invite/" + token
	return invitation, nil
}

func (s *Service) AcceptInvitation(ctx context.Context, token string, input AcceptInvitationInput, device Device) (Tokens, error) {
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	input.Handle = strings.ToLower(strings.TrimSpace(input.Handle))
	input.Timezone = strings.TrimSpace(input.Timezone)
	if input.Timezone == "" {
		input.Timezone = "UTC"
	}
	if len(token) < 32 || len(token) > 1024 {
		return Tokens{}, ErrInvitationInvalid
	}
	if len(input.DisplayName) < 1 || len(input.DisplayName) > 120 {
		return Tokens{}, validationErrorf("display_name must contain 1 to 120 characters")
	}
	if !handlePattern.MatchString(input.Handle) {
		return Tokens{}, validationErrorf("handle has invalid format")
	}
	if len(input.Password) < 10 || len(input.Password) > 1024 {
		return Tokens{}, validationErrorf("password length must be between 10 and 1024 bytes")
	}
	if len(input.Timezone) < 1 || len(input.Timezone) > 64 {
		return Tokens{}, validationErrorf("timezone has invalid length")
	}
	now := s.now().UTC()
	tokenHash := access.HashRefreshToken(token)
	valid, err := s.repository.InvitationValid(ctx, tokenHash[:], now)
	if err != nil {
		return Tokens{}, err
	}
	if !valid {
		return Tokens{}, ErrInvitationInvalid
	}
	passwordHash, err := s.hasher.Hash(input.Password)
	if err != nil {
		return Tokens{}, err
	}
	ids, err := newIDs(4)
	if err != nil {
		return Tokens{}, err
	}
	refreshToken, refreshHash, err := access.NewRefreshToken()
	if err != nil {
		return Tokens{}, err
	}
	user, err := s.repository.AcceptInvitation(ctx, InvitationAcceptance{
		TokenHash: tokenHash[:], ActorID: ids[0], DisplayName: input.DisplayName, Handle: input.Handle,
		PasswordHash: passwordHash, Timezone: input.Timezone, SessionID: ids[1], FamilyID: ids[2],
		RefreshHash: refreshHash[:], SessionExpires: now.Add(s.refreshTTL), Device: device, AuditID: ids[3],
	}, now)
	if err != nil {
		return Tokens{}, err
	}
	return s.issue(user, ids[1], refreshToken)
}

func (s *Service) issue(user User, sessionID, refreshToken string) (Tokens, error) {
	accessToken, expiresAt, err := s.tokens.Issue(access.Identity{
		ActorID: user.ActorID, OrgID: user.OrgID, SessionID: sessionID, Role: user.OrgRole,
	})
	if err != nil {
		return Tokens{}, err
	}
	user.PasswordHash = ""
	return Tokens{AccessToken: accessToken, AccessExpiry: expiresAt, RefreshToken: refreshToken, User: user}, nil
}

func validateBootstrap(input BootstrapInput) error {
	if len(input.OrganizationName) < 1 || len(input.OrganizationName) > 120 {
		return validationErrorf("organization_name must contain 1 to 120 characters")
	}
	if !slugPattern.MatchString(input.OrganizationSlug) {
		return validationErrorf("organization_slug has invalid format")
	}
	if len(input.DisplayName) < 1 || len(input.DisplayName) > 120 {
		return validationErrorf("display_name must contain 1 to 120 characters")
	}
	if !handlePattern.MatchString(input.Handle) {
		return validationErrorf("handle has invalid format")
	}
	parsedEmail, err := mail.ParseAddress(input.Email)
	if err != nil || parsedEmail.Address != input.Email || len(input.Email) > 254 {
		return validationErrorf("email has invalid format")
	}
	if len(input.Timezone) < 1 || len(input.Timezone) > 64 {
		return validationErrorf("timezone has invalid length")
	}
	if len(input.Password) < 10 || len(input.Password) > 1024 {
		return validationErrorf("password length must be between 10 and 1024 bytes")
	}
	return nil
}

func newIDs(count int) ([]string, error) {
	values := make([]string, count)
	for index := range values {
		value, err := id.New()
		if err != nil {
			return nil, err
		}
		values[index] = value
	}
	return values, nil
}
