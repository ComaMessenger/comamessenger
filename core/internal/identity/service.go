package identity

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/password"
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
}

func NewService(repository *Repository, hasher *password.Hasher, tokens *access.Manager, refreshTTL, invitationTTL time.Duration, publicAppURL string, development bool) (*Service, error) {
	dummyHash, err := hasher.Hash("comamessenger dummy password")
	if err != nil {
		return nil, fmt.Errorf("create dummy password hash: %w", err)
	}
	return &Service{repository: repository, hasher: hasher, tokens: tokens, refreshTTL: refreshTTL,
		invitationTTL: invitationTTL, publicAppURL: strings.TrimRight(publicAppURL, "/"), development: development,
		dummyHash: dummyHash, now: time.Now}, nil
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

func (s *Service) UpdateProfile(ctx context.Context, current User, input UpdateProfileInput) (User, error) {
	displayName := current.DisplayName
	handle := current.Handle
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
	if input.Timezone != nil {
		timezone = strings.TrimSpace(*input.Timezone)
		if len(timezone) < 1 || len(timezone) > 64 {
			return User{}, validationErrorf("timezone has invalid length")
		}
	}
	return s.repository.UpdateProfile(ctx, current.ActorID, displayName, handle, timezone)
}

func (s *Service) CreateInvitation(ctx context.Context, current User, input CreateInvitationInput) (Invitation, error) {
	if current.OrgRole != "owner" && current.OrgRole != "admin" {
		return Invitation{}, ErrForbidden
	}
	email := strings.ToLower(strings.TrimSpace(input.Email))
	parsedEmail, err := mail.ParseAddress(email)
	if err != nil || parsedEmail.Address != email || len(email) > 254 {
		return Invitation{}, validationErrorf("email has invalid format")
	}
	role := strings.ToLower(strings.TrimSpace(input.Role))
	if role == "" {
		role = "member"
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
	expiresAt := s.now().UTC().Add(s.invitationTTL)
	invitation, err := s.repository.CreateInvitation(ctx, InvitationRecord{
		ID: ids[0], OrgID: current.OrgID, Email: email, Role: role, TokenHash: tokenHash[:],
		CreatedBy: current.ActorID, ExpiresAt: expiresAt, AuditID: ids[1],
	})
	if err != nil {
		return Invitation{}, err
	}
	if s.development {
		invitation.AcceptURL = s.publicAppURL + "/invite/" + token
	}
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
