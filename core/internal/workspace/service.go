package workspace

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	standardhttp "net/http"
	"net/mail"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
)

const maxBrandingAssetBytes = 512 * 1024

var (
	slugPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}$`)
	colorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

type ConnectionTester interface {
	TestS3(context.Context, S3Config) error
	TestSMTP(context.Context, SMTPConfig) error
}

type Service struct {
	repository *Repository
	aead       cipher.AEAD
	tester     ConnectionTester
	now        func() time.Time
}

func NewService(repository *Repository, encryptionSecret string, tester ConnectionTester) (*Service, error) {
	digest := sha256.Sum256([]byte("comamessenger/workspace-integrations/v1\x00" + encryptionSecret))
	block, err := aes.NewCipher(digest[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if tester == nil {
		tester = NetworkConnectionTester{}
	}
	return &Service{repository: repository, aead: aead, tester: tester, now: time.Now}, nil
}

func (s *Service) Settings(ctx context.Context, current identity.User) (Settings, error) {
	return s.repository.Settings(ctx, current.OrgID)
}

func (s *Service) UpdateSettings(ctx context.Context, current identity.User, input UpdateSettingsInput) (Settings, error) {
	if !allows(current, permission.WorkspaceSettings) &&
		!allows(current, permission.InvitationsManage) &&
		!allows(current, permission.WorkspacePolicies) &&
		!allows(current, permission.BrandingManage) {
		return Settings{}, ErrForbidden
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Slug = strings.ToLower(strings.TrimSpace(input.Slug))
	input.InvitationDefaultRole = strings.ToLower(strings.TrimSpace(input.InvitationDefaultRole))
	input.DefaultTimezone = strings.TrimSpace(input.DefaultTimezone)
	input.AccentColor = strings.ToUpper(strings.TrimSpace(input.AccentColor))
	if len(input.Name) < 1 || len(input.Name) > 120 {
		return Settings{}, fmt.Errorf("%w: name must contain 1 to 120 characters", ErrInvalid)
	}
	if !slugPattern.MatchString(input.Slug) {
		return Settings{}, fmt.Errorf("%w: slug has invalid format", ErrInvalid)
	}
	if input.ExpectedVersion < 1 {
		return Settings{}, fmt.Errorf("%w: expected_version is required", ErrInvalid)
	}
	if input.InvitationDefaultRole != "member" && input.InvitationDefaultRole != "admin" {
		return Settings{}, fmt.Errorf("%w: invalid invitation default role", ErrInvalid)
	}
	if input.InvitationTTLHours < 1 || input.InvitationTTLHours > 720 {
		return Settings{}, fmt.Errorf("%w: invitation TTL must be between 1 and 720 hours", ErrInvalid)
	}
	if len(input.DefaultTimezone) < 1 || len(input.DefaultTimezone) > 64 {
		return Settings{}, fmt.Errorf("%w: default timezone has invalid length", ErrInvalid)
	}
	if _, err := time.LoadLocation(input.DefaultTimezone); err != nil {
		return Settings{}, fmt.Errorf("%w: default timezone is invalid", ErrInvalid)
	}
	if !colorPattern.MatchString(input.AccentColor) {
		return Settings{}, fmt.Errorf("%w: accent color must be a six-digit hex color", ErrInvalid)
	}
	existing, err := s.repository.Settings(ctx, current.OrgID)
	if err != nil {
		return Settings{}, err
	}
	if input.ExpectedVersion != existing.Version {
		return Settings{}, ErrVersionConflict
	}
	if (input.Name != existing.Name || input.Slug != existing.Slug) &&
		!allows(current, permission.WorkspaceSettings) {
		return Settings{}, ErrForbidden
	}
	if (input.InvitationDefaultRole != existing.InvitationDefaultRole || input.InvitationTTLHours != existing.InvitationTTLHours || input.DefaultTimezone != existing.DefaultTimezone || input.AllowMemberInvitations != existing.AllowMemberInvitations) &&
		!allows(current, permission.InvitationsManage) {
		return Settings{}, ErrForbidden
	}
	if (input.AllowPublicChatCreation != existing.AllowPublicChatCreation || input.AllowChannelCreation != existing.AllowChannelCreation) &&
		!allows(current, permission.WorkspacePolicies) {
		return Settings{}, ErrForbidden
	}
	if input.AccentColor != existing.AccentColor && !allows(current, permission.BrandingManage) {
		return Settings{}, ErrForbidden
	}
	changes := map[string]any{}
	addChange := func(name string, from, to any) {
		if fmt.Sprint(from) != fmt.Sprint(to) {
			changes[name] = map[string]any{"from": from, "to": to}
		}
	}
	addChange("name", existing.Name, input.Name)
	addChange("slug", existing.Slug, input.Slug)
	addChange("invitation_default_role", existing.InvitationDefaultRole, input.InvitationDefaultRole)
	addChange("invitation_ttl_hours", existing.InvitationTTLHours, input.InvitationTTLHours)
	addChange("default_timezone", existing.DefaultTimezone, input.DefaultTimezone)
	addChange("allow_member_invitations", existing.AllowMemberInvitations, input.AllowMemberInvitations)
	addChange("allow_public_chat_creation", existing.AllowPublicChatCreation, input.AllowPublicChatCreation)
	addChange("allow_channel_creation", existing.AllowChannelCreation, input.AllowChannelCreation)
	addChange("accent_color", existing.AccentColor, input.AccentColor)
	return s.repository.UpdateSettings(ctx, current.OrgID, current.ActorID, input, changes)
}

func (s *Service) PublicBranding(ctx context.Context) (PublicBranding, error) {
	value, err := s.repository.PublicBranding(ctx)
	if err != nil || value.OrgID == "" {
		return value, err
	}
	value.PasswordRecoveryAvailable, err = s.EmailConfigured(ctx, value.OrgID)
	value.EmailDeliveryAvailable = value.PasswordRecoveryAvailable
	return value, err
}

func (s *Service) Asset(ctx context.Context, kind string) (Asset, error) {
	if kind != "logo" && kind != "favicon" {
		return Asset{}, ErrNotFound
	}
	return s.repository.Asset(ctx, kind)
}

func (s *Service) PutAsset(ctx context.Context, current identity.User, kind, contentType string, content []byte) error {
	if !allows(current, permission.BrandingManage) {
		return ErrForbidden
	}
	if kind != "logo" && kind != "favicon" {
		return fmt.Errorf("%w: invalid asset kind", ErrInvalid)
	}
	allowed := map[string]bool{"image/png": true, "image/jpeg": true, "image/webp": true, "image/x-icon": kind == "favicon", "image/vnd.microsoft.icon": kind == "favicon"}
	if !allowed[strings.ToLower(contentType)] {
		return fmt.Errorf("%w: unsupported branding image type", ErrInvalid)
	}
	if len(content) < 1 || len(content) > maxBrandingAssetBytes {
		return fmt.Errorf("%w: branding image must not exceed 512 KiB", ErrInvalid)
	}
	detected := strings.ToLower(standardhttp.DetectContentType(content))
	validMagic := detected == strings.ToLower(contentType)
	if kind == "favicon" && (contentType == "image/x-icon" || contentType == "image/vnd.microsoft.icon") {
		validMagic = len(content) >= 4 && content[0] == 0 && content[1] == 0 && content[2] == 1 && content[3] == 0
	}
	if !validMagic {
		return fmt.Errorf("%w: branding image content does not match its Content-Type", ErrInvalid)
	}
	return s.repository.PutAsset(ctx, current.OrgID, current.ActorID, kind, strings.ToLower(contentType), content)
}

func (s *Service) DeleteAsset(ctx context.Context, current identity.User, kind string) error {
	if !allows(current, permission.BrandingManage) {
		return ErrForbidden
	}
	if kind != "logo" && kind != "favicon" {
		return fmt.Errorf("%w: invalid asset kind", ErrInvalid)
	}
	return s.repository.DeleteAsset(ctx, current.OrgID, current.ActorID, kind)
}

func (s *Service) Infrastructure(ctx context.Context, current identity.User) (Infrastructure, error) {
	if !allows(current, permission.IntegrationsManage) {
		return Infrastructure{}, ErrForbidden
	}
	version, encrypted, err := s.repository.Integration(ctx, current.OrgID)
	if err != nil {
		return Infrastructure{}, err
	}
	secrets := integrationSecrets{}
	if len(encrypted) > 0 {
		secrets, err = s.decrypt(current.OrgID, encrypted)
		if err != nil {
			return Infrastructure{}, err
		}
	}
	return infrastructureView(version, secrets), nil
}

func (s *Service) EmailConfigured(ctx context.Context, orgID string) (bool, error) {
	config, err := s.emailConfiguration(ctx, orgID)
	if err != nil {
		return false, err
	}
	return config.Host != "" && config.FromAddress != "", nil
}

func (s *Service) SendEmail(ctx context.Context, orgID, recipient, subject, body string) error {
	config, err := s.emailConfiguration(ctx, orgID)
	if err != nil {
		return err
	}
	return sendSMTP(ctx, config, recipient, subject, body)
}

func (s *Service) emailConfiguration(ctx context.Context, orgID string) (SMTPConfig, error) {
	_, encrypted, err := s.repository.Integration(ctx, orgID)
	if err != nil {
		return SMTPConfig{}, err
	}
	if len(encrypted) == 0 {
		return SMTPConfig{}, nil
	}
	secrets, err := s.decrypt(orgID, encrypted)
	if err != nil {
		return SMTPConfig{}, err
	}
	return secrets.SMTP, nil
}

func (s *Service) UpdateInfrastructure(ctx context.Context, current identity.User, input UpdateInfrastructureInput) (Infrastructure, error) {
	if !allows(current, permission.IntegrationsManage) {
		return Infrastructure{}, ErrForbidden
	}
	version, encrypted, err := s.repository.Integration(ctx, current.OrgID)
	if err != nil {
		return Infrastructure{}, err
	}
	if input.ExpectedVersion != version {
		return Infrastructure{}, ErrVersionConflict
	}
	currentSecrets := integrationSecrets{}
	if len(encrypted) > 0 {
		currentSecrets, err = s.decrypt(current.OrgID, encrypted)
		if err != nil {
			return Infrastructure{}, err
		}
	}
	next := integrationSecrets{
		S3:   S3Config{Endpoint: strings.TrimSpace(input.S3.Endpoint), Region: strings.TrimSpace(input.S3.Region), Bucket: strings.TrimSpace(input.S3.Bucket), Prefix: strings.Trim(strings.TrimSpace(input.S3.Prefix), "/"), ForcePathStyle: input.S3.ForcePathStyle, AccessKey: currentSecrets.S3.AccessKey, SecretKey: currentSecrets.S3.SecretKey},
		SMTP: SMTPConfig{Host: strings.TrimSpace(input.SMTP.Host), Port: input.SMTP.Port, Username: strings.TrimSpace(input.SMTP.Username), Password: currentSecrets.SMTP.Password, FromAddress: strings.TrimSpace(input.SMTP.FromAddress), FromName: strings.TrimSpace(input.SMTP.FromName), Security: strings.ToLower(strings.TrimSpace(input.SMTP.Security))},
	}
	if input.S3.ClearCredentials {
		next.S3.AccessKey, next.S3.SecretKey = "", ""
	}
	if input.S3.AccessKey != nil {
		next.S3.AccessKey = strings.TrimSpace(*input.S3.AccessKey)
	}
	if input.S3.SecretKey != nil {
		next.S3.SecretKey = strings.TrimSpace(*input.S3.SecretKey)
	}
	if input.SMTP.ClearCredentials {
		next.SMTP.Password = ""
	}
	if input.SMTP.Password != nil {
		next.SMTP.Password = *input.SMTP.Password
	}
	if err := validateIntegrations(next); err != nil {
		return Infrastructure{}, err
	}
	sealed, err := s.encrypt(current.OrgID, next)
	if err != nil {
		return Infrastructure{}, err
	}
	nextVersion, err := s.repository.PutIntegration(ctx, current.OrgID, current.ActorID, input.ExpectedVersion, sealed)
	if err != nil {
		return Infrastructure{}, err
	}
	return infrastructureView(nextVersion, next), nil
}

func (s *Service) TestConnection(ctx context.Context, current identity.User, input ConnectionTestInput) (ConnectionTestResult, error) {
	result := ConnectionTestResult{CheckedAt: s.now().UTC()}
	if !allows(current, permission.IntegrationsManage) {
		return result, ErrForbidden
	}
	_, encrypted, err := s.repository.Integration(ctx, current.OrgID)
	if err != nil {
		return result, err
	}
	if len(encrypted) == 0 {
		result.Message = "configuration is not saved"
		return result, nil
	}
	secrets, err := s.decrypt(current.OrgID, encrypted)
	if err != nil {
		return result, err
	}
	switch strings.ToLower(strings.TrimSpace(input.Kind)) {
	case "s3":
		err = s.tester.TestS3(ctx, secrets.S3)
	case "smtp":
		err = s.tester.TestSMTP(ctx, secrets.SMTP)
	default:
		return result, fmt.Errorf("%w: unsupported connection kind", ErrInvalid)
	}
	if err != nil {
		result.Message = err.Error()
		return result, nil
	}
	result.OK, result.Message = true, "connection successful"
	return result, nil
}

func (s *Service) Members(ctx context.Context, current identity.User) ([]Member, error) {
	if !allows(current, permission.MembersManage) {
		return nil, ErrForbidden
	}
	return s.repository.Members(ctx, current.OrgID)
}

func (s *Service) UpdateMember(ctx context.Context, current identity.User, actorID string, input UpdateMemberInput) (Member, error) {
	if !allows(current, permission.MembersManage) {
		return Member{}, ErrForbidden
	}
	if input.Role != nil && *input.Role != "admin" && *input.Role != "member" {
		return Member{}, fmt.Errorf("%w: invalid role", ErrInvalid)
	}
	if input.Status != nil && *input.Status != "active" && *input.Status != "deactivated" {
		return Member{}, fmt.Errorf("%w: invalid status", ErrInvalid)
	}
	if input.Role == nil && input.Status == nil && input.Permissions == nil {
		return Member{}, fmt.Errorf("%w: no member changes supplied", ErrInvalid)
	}
	if input.Permissions != nil {
		if current.OrgRole != "owner" {
			return Member{}, ErrForbidden
		}
		if input.Role != nil && *input.Role != "admin" {
			return Member{}, fmt.Errorf("%w: only administrators may have explicit permissions", ErrInvalid)
		}
		seen := make(map[permission.Code]struct{}, len(*input.Permissions))
		for _, code := range *input.Permissions {
			if !permission.Valid(code) {
				return Member{}, fmt.Errorf("%w: invalid permission %q", ErrInvalid, code)
			}
			if _, duplicate := seen[code]; duplicate {
				return Member{}, fmt.Errorf("%w: duplicate permission %q", ErrInvalid, code)
			}
			seen[code] = struct{}{}
		}
	}
	return s.repository.UpdateMember(ctx, current.OrgID, current.ActorID, actorID, input)
}

func (s *Service) RequirePasswordChange(ctx context.Context, current identity.User, actorID string) ([]string, error) {
	if !allows(current, permission.MembersManage) {
		return nil, ErrForbidden
	}
	if actorID == current.ActorID {
		return nil, fmt.Errorf("%w: use the personal security page to change your own password", ErrInvalid)
	}
	return s.repository.RequirePasswordChange(ctx, current.OrgID, current.ActorID, actorID, current.OrgRole, s.now().UTC())
}

func (s *Service) Audit(ctx context.Context, current identity.User, filter AuditFilter) (AuditPage, error) {
	if !allows(current, permission.AuditRead) {
		return AuditPage{}, ErrForbidden
	}
	if filter.Limit == 0 {
		filter.Limit = 50
	}
	if filter.Limit < 1 || filter.Limit > 100 {
		return AuditPage{}, fmt.Errorf("%w: audit limit must be between 1 and 100", ErrInvalid)
	}
	validCategory := filter.Category == "" || filter.Category == "organization" || filter.Category == "members" || filter.Category == "invitations" || filter.Category == "security" || filter.Category == "chats" || filter.Category == "infrastructure"
	if !validCategory || filter.ActorID != "" && uuid.Validate(filter.ActorID) != nil || filter.AfterID != "" && uuid.Validate(filter.AfterID) != nil || filter.From != nil && filter.To != nil && !filter.From.Before(*filter.To) {
		return AuditPage{}, fmt.Errorf("%w: audit filters are invalid", ErrInvalid)
	}
	return s.repository.Audit(ctx, current.OrgID, filter)
}

func (s *Service) encrypt(orgID string, value integrationSecrets) ([]byte, error) {
	plain, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return append(nonce, s.aead.Seal(nil, nonce, plain, []byte(orgID))...), nil
}

func (s *Service) decrypt(orgID string, sealed []byte) (integrationSecrets, error) {
	if len(sealed) < s.aead.NonceSize() {
		return integrationSecrets{}, fmt.Errorf("encrypted integration configuration is invalid")
	}
	nonce, payload := sealed[:s.aead.NonceSize()], sealed[s.aead.NonceSize():]
	plain, err := s.aead.Open(nil, nonce, payload, []byte(orgID))
	if err != nil {
		return integrationSecrets{}, fmt.Errorf("decrypt integration configuration: %w", err)
	}
	var result integrationSecrets
	if err := json.Unmarshal(plain, &result); err != nil {
		return integrationSecrets{}, err
	}
	return result, nil
}

func infrastructureView(version int64, value integrationSecrets) Infrastructure {
	if value.SMTP.Port == 0 {
		value.SMTP.Port = 587
	}
	if value.SMTP.Security == "" {
		value.SMTP.Security = "starttls"
	}
	return Infrastructure{Version: version,
		S3:   S3ConfigurationView{Endpoint: value.S3.Endpoint, Region: value.S3.Region, Bucket: value.S3.Bucket, Prefix: value.S3.Prefix, ForcePathStyle: value.S3.ForcePathStyle, CredentialsConfigured: value.S3.AccessKey != "" && value.S3.SecretKey != "", AccessKeyHint: mask(value.S3.AccessKey)},
		SMTP: SMTPConfigurationView{Host: value.SMTP.Host, Port: value.SMTP.Port, Username: value.SMTP.Username, FromAddress: value.SMTP.FromAddress, FromName: value.SMTP.FromName, Security: value.SMTP.Security, CredentialsConfigured: value.SMTP.Password != ""},
	}
}

func validateIntegrations(value integrationSecrets) error {
	if value.S3.Endpoint != "" || value.S3.Bucket != "" || value.S3.Region != "" || value.S3.AccessKey != "" || value.S3.SecretKey != "" {
		if value.S3.Endpoint != "" {
			parsed, err := url.Parse(value.S3.Endpoint)
			if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
				return fmt.Errorf("%w: S3 endpoint must be an HTTP(S) URL", ErrInvalid)
			}
		}
		if value.S3.Region == "" || value.S3.Bucket == "" {
			return fmt.Errorf("%w: S3 region and bucket are required", ErrInvalid)
		}
		if (value.S3.AccessKey == "") != (value.S3.SecretKey == "") {
			return fmt.Errorf("%w: S3 access and secret keys must be set together", ErrInvalid)
		}
	}
	if value.SMTP.Host != "" {
		if value.SMTP.Port < 1 || value.SMTP.Port > 65535 {
			return fmt.Errorf("%w: SMTP port is invalid", ErrInvalid)
		}
		if value.SMTP.Security != "tls" && value.SMTP.Security != "starttls" && value.SMTP.Security != "none" {
			return fmt.Errorf("%w: SMTP security must be tls, starttls or none", ErrInvalid)
		}
		address, err := mail.ParseAddress(value.SMTP.FromAddress)
		if err != nil || address.Address != value.SMTP.FromAddress {
			return fmt.Errorf("%w: SMTP from address is invalid", ErrInvalid)
		}
	}
	return nil
}

func allows(user identity.User, required permission.Code) bool {
	return permission.Allows(user.OrgRole, user.Permissions, required)
}

func mask(value string) string {
	if value == "" {
		return ""
	}
	if len(value) <= 4 {
		return "••••"
	}
	return "••••" + value[len(value)-4:]
}
