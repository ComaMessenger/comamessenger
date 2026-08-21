package workspace

import (
	"errors"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/permission"
)

var (
	ErrForbidden       = errors.New("workspace action forbidden")
	ErrInvalid         = errors.New("invalid workspace input")
	ErrNotFound        = errors.New("workspace resource not found")
	ErrVersionConflict = errors.New("workspace version conflict")
)

type Settings struct {
	ID                      string `json:"id"`
	Name                    string `json:"name"`
	Slug                    string `json:"slug"`
	Version                 int64  `json:"version"`
	InvitationDefaultRole   string `json:"invitation_default_role"`
	InvitationTTLHours      int    `json:"invitation_ttl_hours"`
	DefaultTimezone         string `json:"default_timezone"`
	AllowMemberInvitations  bool   `json:"allow_member_invitations"`
	AllowPublicChatCreation bool   `json:"allow_public_chat_creation"`
	AllowChannelCreation    bool   `json:"allow_channel_creation"`
	AccentColor             string `json:"accent_color"`
	HasLogo                 bool   `json:"has_logo"`
	HasFavicon              bool   `json:"has_favicon"`
}

type UpdateSettingsInput struct {
	Name                    string `json:"name"`
	Slug                    string `json:"slug"`
	ExpectedVersion         int64  `json:"expected_version"`
	InvitationDefaultRole   string `json:"invitation_default_role"`
	InvitationTTLHours      int    `json:"invitation_ttl_hours"`
	DefaultTimezone         string `json:"default_timezone"`
	AllowMemberInvitations  bool   `json:"allow_member_invitations"`
	AllowPublicChatCreation bool   `json:"allow_public_chat_creation"`
	AllowChannelCreation    bool   `json:"allow_channel_creation"`
	AccentColor             string `json:"accent_color"`
}

type PublicBranding struct {
	OrgID                     string `json:"-"`
	WorkspaceName             string `json:"workspace_name"`
	AccentColor               string `json:"accent_color"`
	Version                   int64  `json:"version"`
	LogoURL                   string `json:"logo_url,omitempty"`
	FaviconURL                string `json:"favicon_url,omitempty"`
	PasswordRecoveryAvailable bool   `json:"password_recovery_available"`
	EmailDeliveryAvailable    bool   `json:"email_delivery_available"`
}

type Asset struct {
	ContentType string
	Content     []byte
	UpdatedAt   time.Time
}

type S3Config struct {
	Endpoint       string `json:"endpoint"`
	Region         string `json:"region"`
	Bucket         string `json:"bucket"`
	Prefix         string `json:"prefix"`
	ForcePathStyle bool   `json:"force_path_style"`
	AccessKey      string `json:"access_key"`
	SecretKey      string `json:"secret_key"`
}

type SMTPConfig struct {
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Username    string `json:"username"`
	Password    string `json:"password"`
	FromAddress string `json:"from_address"`
	FromName    string `json:"from_name"`
	Security    string `json:"security"`
}

type integrationSecrets struct {
	S3   S3Config   `json:"s3"`
	SMTP SMTPConfig `json:"smtp"`
}

type Infrastructure struct {
	Version int64                 `json:"version"`
	S3      S3ConfigurationView   `json:"s3"`
	SMTP    SMTPConfigurationView `json:"smtp"`
}

type S3ConfigurationView struct {
	Endpoint              string `json:"endpoint"`
	Region                string `json:"region"`
	Bucket                string `json:"bucket"`
	Prefix                string `json:"prefix"`
	ForcePathStyle        bool   `json:"force_path_style"`
	CredentialsConfigured bool   `json:"credentials_configured"`
	AccessKeyHint         string `json:"access_key_hint,omitempty"`
}

type SMTPConfigurationView struct {
	Host                  string `json:"host"`
	Port                  int    `json:"port"`
	Username              string `json:"username"`
	FromAddress           string `json:"from_address"`
	FromName              string `json:"from_name"`
	Security              string `json:"security"`
	CredentialsConfigured bool   `json:"credentials_configured"`
}

type UpdateInfrastructureInput struct {
	ExpectedVersion int64           `json:"expected_version"`
	S3              S3UpdateInput   `json:"s3"`
	SMTP            SMTPUpdateInput `json:"smtp"`
}

type S3UpdateInput struct {
	Endpoint         string  `json:"endpoint"`
	Region           string  `json:"region"`
	Bucket           string  `json:"bucket"`
	Prefix           string  `json:"prefix"`
	ForcePathStyle   bool    `json:"force_path_style"`
	AccessKey        *string `json:"access_key"`
	SecretKey        *string `json:"secret_key"`
	ClearCredentials bool    `json:"clear_credentials"`
}

type SMTPUpdateInput struct {
	Host             string  `json:"host"`
	Port             int     `json:"port"`
	Username         string  `json:"username"`
	Password         *string `json:"password"`
	FromAddress      string  `json:"from_address"`
	FromName         string  `json:"from_name"`
	Security         string  `json:"security"`
	ClearCredentials bool    `json:"clear_credentials"`
}

type ConnectionTestInput struct {
	Kind string `json:"kind"`
}
type ConnectionTestResult struct {
	OK        bool      `json:"ok"`
	Message   string    `json:"message"`
	CheckedAt time.Time `json:"checked_at"`
}

type Member struct {
	ActorID         string            `json:"actor_id"`
	Email           string            `json:"email"`
	DisplayName     string            `json:"display_name"`
	Handle          string            `json:"handle"`
	Title           string            `json:"title"`
	Role            string            `json:"role"`
	Status          string            `json:"status"`
	Permissions     []permission.Code `json:"permissions"`
	CreatedAt       time.Time         `json:"created_at"`
	LastSeenAt      *time.Time        `json:"last_seen_at"`
	StatusEmoji     string            `json:"status_emoji"`
	StatusText      string            `json:"status_text"`
	StatusExpiresAt *time.Time        `json:"status_expires_at"`
}

type UpdateMemberInput struct {
	Role        *string            `json:"role"`
	Status      *string            `json:"status"`
	Permissions *[]permission.Code `json:"permissions"`
}

type AuditEntry struct {
	ID         string         `json:"id"`
	ActorID    *string        `json:"actor_id"`
	ActorName  *string        `json:"actor_name"`
	ActorRole  *string        `json:"actor_role"`
	Action     string         `json:"action"`
	Category   string         `json:"category"`
	TargetType string         `json:"target_type"`
	TargetID   *string        `json:"target_id"`
	TargetName *string        `json:"target_name"`
	Metadata   map[string]any `json:"metadata"`
	Changes    map[string]any `json:"changes"`
	CreatedAt  time.Time      `json:"created_at"`
}

type AuditPage struct {
	Events      []AuditEntry `json:"events"`
	NextAfterID *string      `json:"next_after_id"`
}

type AuditFilter struct {
	Limit    int
	Category string
	ActorID  string
	From     *time.Time
	To       *time.Time
	AfterID  string
}
