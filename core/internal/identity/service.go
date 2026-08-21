package identity

import (
	"context"
	"crypto/sha256"
	"errors"
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
	repository          *Repository
	hasher              *password.Hasher
	tokens              *access.Manager
	refreshTTL          time.Duration
	invitationTTL       time.Duration
	publicAppURL        string
	development         bool
	dummyHash           string
	now                 func() time.Time
	emailSender         EmailSender
	afterCommit         func(string, int64)
	bearerAuthenticator func(context.Context, string) (User, access.Identity, error)
}

func (s *Service) SetAfterCommit(callback func(string, int64)) {
	s.afterCommit = callback
}

func (s *Service) SetBearerAuthenticator(authenticator func(context.Context, string) (User, access.Identity, error)) {
	s.bearerAuthenticator = authenticator
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
	if strings.HasPrefix(bearer, "coma_agent_") {
		if s.bearerAuthenticator == nil {
			return User{}, access.Identity{}, ErrUnauthorized
		}
		user, authenticated, err := s.bearerAuthenticator(ctx, bearer)
		if err != nil {
			return User{}, access.Identity{}, ErrUnauthorized
		}
		return user, authenticated, nil
	}
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

func (s *Service) SetStatus(ctx context.Context, current User, input SetStatusInput) (CustomStatus, error) {
	status := CustomStatus{Emoji: strings.TrimSpace(input.Emoji), Text: strings.TrimSpace(input.Text), ExpiresAt: input.ExpiresAt}
	if len([]rune(status.Emoji)) > 16 {
		return CustomStatus{}, validationErrorf("emoji must contain at most 16 characters")
	}
	if len([]rune(status.Text)) > 100 {
		return CustomStatus{}, validationErrorf("text must contain at most 100 characters")
	}
	now := s.now().UTC()
	if status.ExpiresAt != nil {
		expires := status.ExpiresAt.UTC()
		if !expires.After(now) || expires.After(now.Add(366*24*time.Hour)) {
			return CustomStatus{}, validationErrorf("expires_at must be in the future and within one year")
		}
		status.ExpiresAt = &expires
	}
	result, seq, err := s.repository.UpdateStatus(ctx, current, status)
	if err == nil && s.afterCommit != nil {
		s.afterCommit(current.OrgID, seq)
	}
	return result, err
}

func (s *Service) ClearStatus(ctx context.Context, current User) (CustomStatus, error) {
	result, seq, err := s.repository.UpdateStatus(ctx, current, CustomStatus{})
	if err == nil && s.afterCommit != nil {
		s.afterCommit(current.OrgID, seq)
	}
	return result, err
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

func (s *Service) ForgotPassword(ctx context.Context, input ForgotPasswordInput) error {
	email := strings.ToLower(strings.TrimSpace(input.Email))
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email || len(email) > 254 {
		return nil
	}
	target, err := s.repository.PasswordResetTargetByEmail(ctx, email)
	if errors.Is(err, ErrNotFound) || (err == nil && target.Status != "active") {
		return nil
	}
	if err != nil {
		return err
	}
	if s.emailSender == nil {
		return nil
	}
	configured, err := s.emailSender.EmailConfigured(ctx, target.OrgID)
	if err != nil || !configured {
		return err
	}
	_, err = s.issuePasswordReset(ctx, target, "email", nil, true)
	return err
}

func (s *Service) IssueMemberPasswordReset(ctx context.Context, current User, actorID string) error {
	if !permission.Allows(current.OrgRole, current.Permissions, permission.MembersManage) {
		return ErrForbidden
	}
	if actorID == current.ActorID {
		return validationErrorf("use the personal recovery flow for your own account")
	}
	target, err := s.repository.PasswordResetTargetByActor(ctx, current.OrgID, actorID)
	if err != nil {
		return err
	}
	if target.Status != "active" || target.Role == "owner" || (current.OrgRole != "owner" && target.Role != "member") {
		return ErrForbidden
	}
	if s.emailSender == nil {
		return ErrEmailNotConfigured
	}
	configured, err := s.emailSender.EmailConfigured(ctx, target.OrgID)
	if err != nil {
		return err
	}
	if !configured {
		return ErrEmailNotConfigured
	}
	_, err = s.issuePasswordReset(ctx, target, "email", &current.ActorID, true)
	return err
}

func (s *Service) IssueOperatorPasswordReset(ctx context.Context, email string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email || len(email) > 254 {
		return "", validationErrorf("email has invalid format")
	}
	target, err := s.repository.PasswordResetTargetByEmail(ctx, email)
	if err != nil {
		return "", err
	}
	if target.Status != "active" {
		return "", ErrNotFound
	}
	return s.issuePasswordReset(ctx, target, "operator", nil, false)
}

func (s *Service) issuePasswordReset(ctx context.Context, target PasswordResetTarget, delivery string, issuedBy *string, send bool) (string, error) {
	token, tokenHash, err := access.NewRefreshToken()
	if err != nil {
		return "", err
	}
	ids, err := newIDs(2)
	if err != nil {
		return "", err
	}
	now := s.now().UTC()
	record := PasswordResetRecord{
		ID: ids[0], OrgID: target.OrgID, ActorID: target.ActorID, TokenHash: tokenHash[:],
		Delivery: delivery, IssuedBy: issuedBy, ExpiresAt: now.Add(time.Hour), AuditID: ids[1],
	}
	if err := s.repository.CreatePasswordReset(ctx, record, now); err != nil {
		return "", err
	}
	resetURL := s.publicAppURL + "/reset-password?token=" + url.QueryEscape(token)
	if send {
		body := "Reset your Coma password within one hour:\n" + resetURL
		if err := s.emailSender.SendEmail(ctx, target.OrgID, target.Email, "Reset your Coma password", body); err != nil {
			_ = s.repository.CancelPasswordReset(ctx, record.ID, target.ActorID, now)
			return "", fmt.Errorf("send password reset: %w", err)
		}
	}
	return resetURL, nil
}

func (s *Service) ResetPassword(ctx context.Context, input ResetPasswordInput) ([]string, error) {
	if input.Token == "" || len(input.Token) > 1024 {
		return nil, ErrTokenInvalid
	}
	if len(input.NewPassword) < 10 || len(input.NewPassword) > 1024 {
		return nil, validationErrorf("new_password length must be between 10 and 1024 bytes")
	}
	passwordHash, err := s.hasher.Hash(input.NewPassword)
	if err != nil {
		return nil, err
	}
	auditID, err := id.New()
	if err != nil {
		return nil, err
	}
	tokenHash := sha256.Sum256([]byte(input.Token))
	return s.repository.ResetPassword(ctx, tokenHash[:], passwordHash, auditID, s.now().UTC())
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
	email := strings.ToLower(strings.TrimSpace(input.Email))
	parsedEmail, err := mail.ParseAddress(email)
	if err != nil || parsedEmail.Address != email || len(email) > 254 {
		return Invitation{}, validationErrorf("email has invalid format")
	}
	role := strings.ToLower(strings.TrimSpace(input.Role))
	policyRole, policyTTL, allowMembers, err := s.repository.InvitationPolicy(ctx, current.OrgID)
	if err != nil {
		return Invitation{}, err
	}
	manager := permission.Allows(current.OrgRole, current.Permissions, permission.InvitationsManage)
	memberSelfService := current.OrgRole == "member" && allowMembers
	if !manager && !memberSelfService {
		return Invitation{}, ErrForbidden
	}
	if memberSelfService && !manager {
		if role != "" && role != "member" {
			return Invitation{}, ErrForbidden
		}
		role = "member"
	} else if role == "" {
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
	s.deliverInvitation(ctx, current.OrgID, &invitation)
	return invitation, nil
}

func (s *Service) Invitations(ctx context.Context, current User) ([]InvitationSummary, error) {
	if !permission.Allows(current.OrgRole, current.Permissions, permission.InvitationsManage) {
		return nil, ErrForbidden
	}
	return s.repository.Invitations(ctx, current.OrgID, s.now().UTC())
}

func (s *Service) RevokeInvitation(ctx context.Context, current User, invitationID string) error {
	if !permission.Allows(current.OrgRole, current.Permissions, permission.InvitationsManage) {
		return ErrForbidden
	}
	if uuid.Validate(invitationID) != nil {
		return ErrNotFound
	}
	auditID, err := id.New()
	if err != nil {
		return err
	}
	return s.repository.RevokeInvitation(ctx, current.OrgID, current.ActorID, invitationID, auditID)
}

func (s *Service) RotateInvitation(ctx context.Context, current User, invitationID string) (Invitation, error) {
	if !permission.Allows(current.OrgRole, current.Permissions, permission.InvitationsManage) {
		return Invitation{}, ErrForbidden
	}
	if uuid.Validate(invitationID) != nil {
		return Invitation{}, ErrNotFound
	}
	ids, err := newIDs(2)
	if err != nil {
		return Invitation{}, err
	}
	_, policyTTL, _, err := s.repository.InvitationPolicy(ctx, current.OrgID)
	if err != nil {
		return Invitation{}, err
	}
	if policyTTL <= 0 {
		policyTTL = s.invitationTTL
	}
	token, tokenHash, err := access.NewRefreshToken()
	if err != nil {
		return Invitation{}, err
	}
	invitation, err := s.repository.RotateInvitation(ctx, invitationID, InvitationRecord{
		ID: ids[0], OrgID: current.OrgID, TokenHash: tokenHash[:], CreatedBy: current.ActorID,
		ExpiresAt: s.now().UTC().Add(policyTTL), AuditID: ids[1],
	})
	if err != nil {
		return Invitation{}, err
	}
	invitation.AcceptURL = s.publicAppURL + "/invite/" + token
	s.deliverInvitation(ctx, current.OrgID, &invitation)
	return invitation, nil
}

func (s *Service) deliverInvitation(ctx context.Context, orgID string, invitation *Invitation) {
	if s.emailSender == nil {
		return
	}
	configured, err := s.emailSender.EmailConfigured(ctx, orgID)
	if err != nil || !configured {
		return
	}
	subject := "ComaMessenger invitation"
	body := "You were invited to ComaMessenger as " + invitation.Role + ".\n\nOpen this one-time link:\n" + invitation.AcceptURL
	if err := s.emailSender.SendEmail(ctx, orgID, invitation.Email, subject, body); err != nil {
		return
	}
	invitation.EmailSent = true
	_ = s.repository.MarkInvitationEmailSent(ctx, orgID, invitation.ID, s.now().UTC())
}

func (s *Service) AcceptInvitation(ctx context.Context, token string, input AcceptInvitationInput, device Device) (Tokens, error) {
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	input.Handle = strings.ToLower(strings.TrimSpace(input.Handle))
	input.Timezone = strings.TrimSpace(input.Timezone)
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
	if len(input.Timezone) > 64 {
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
	_, _, allowMembers, policyErr := s.repository.InvitationPolicy(ctx, user.OrgID)
	if policyErr != nil {
		return Tokens{}, policyErr
	}
	user.CanCreateInvitations = user.OrgRole == "owner" || (user.OrgRole == "member" && allowMembers) || permission.Allows(user.OrgRole, user.Permissions, permission.InvitationsManage)
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
