package workspace

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
)

func TestIntegrationSecretsAreEncryptedAndBoundToOrganization(t *testing.T) {
	service, err := NewService(nil, "test-secret-with-enough-entropy", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := integrationSecrets{
		S3:   S3Config{Endpoint: "https://storage.yandexcloud.net", Region: "ru-central1", Bucket: "coma", AccessKey: "AKIAEXAMPLE", SecretKey: "secret"},
		SMTP: SMTPConfig{Host: "smtp.example.com", Port: 587, Username: "coma", Password: "mail-secret", FromAddress: "coma@example.com", Security: "starttls"},
	}
	sealed, err := service.encrypt("org-one", want)
	if err != nil {
		t.Fatal(err)
	}
	if string(sealed) == string(mustJSON(t, want)) {
		t.Fatal("integration configuration was stored as plaintext")
	}
	got, err := service.decrypt("org-one", sealed)
	if err != nil {
		t.Fatal(err)
	}
	if got.S3.SecretKey != want.S3.SecretKey || got.SMTP.Password != want.SMTP.Password {
		t.Fatalf("decrypted secrets do not match: %#v", got)
	}
	if _, err := service.decrypt("org-two", sealed); err == nil {
		t.Fatal("encrypted configuration must not decrypt for another organization")
	}
}

func TestInfrastructureViewNeverReturnsSecrets(t *testing.T) {
	view := infrastructureView(3, integrationSecrets{
		S3:   S3Config{AccessKey: "SELECTEL-1234", SecretKey: "top-secret"},
		SMTP: SMTPConfig{Password: "mail-secret"},
	})
	if !view.S3.CredentialsConfigured || view.S3.AccessKeyHint != "••••1234" {
		t.Fatalf("unexpected masked S3 view: %#v", view.S3)
	}
	if !view.SMTP.CredentialsConfigured {
		t.Fatal("SMTP credential state was not exposed")
	}
}

func TestValidateProviderNeutralIntegrations(t *testing.T) {
	valid := integrationSecrets{
		S3:   S3Config{Endpoint: "https://s3.storage.selcloud.ru", Region: "ru-1", Bucket: "coma", ForcePathStyle: true, AccessKey: "key", SecretKey: "secret"},
		SMTP: SMTPConfig{Host: "smtp.example.com", Port: 465, FromAddress: "noreply@example.com", Security: "tls"},
	}
	if err := validateIntegrations(valid); err != nil {
		t.Fatalf("valid provider-neutral configuration rejected: %v", err)
	}
	invalid := valid
	invalid.S3.Endpoint = "file:///tmp/bucket"
	if err := validateIntegrations(invalid); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unsafe endpoint should be rejected, got %v", err)
	}
}

func TestMembersCannotMutateWorkspace(t *testing.T) {
	service, err := NewService(nil, "test-secret", nil)
	if err != nil {
		t.Fatal(err)
	}
	member := identity.User{OrgRole: "member"}
	if _, err := service.UpdateSettings(t.Context(), member, UpdateSettingsInput{}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member update should be forbidden, got %v", err)
	}
	if err := service.PutAsset(t.Context(), member, "logo", "image/png", []byte("png")); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member asset update should be forbidden, got %v", err)
	}
}

func TestAdministratorRequiresSpecificPermission(t *testing.T) {
	service, err := NewService(nil, "test-secret", nil)
	if err != nil {
		t.Fatal(err)
	}
	admin := identity.User{OrgRole: "admin"}
	if err := service.PutAsset(t.Context(), admin, "invalid", "image/png", []byte("png")); !errors.Is(err, ErrForbidden) {
		t.Fatalf("admin without branding permission should be forbidden, got %v", err)
	}
	admin.Permissions = []permission.Code{permission.BrandingManage}
	if err := service.PutAsset(t.Context(), admin, "invalid", "image/png", []byte("png")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("admin with branding permission should reach validation, got %v", err)
	}
}

func TestOnlyOwnerCanChangeAdministratorPermissions(t *testing.T) {
	service, err := NewService(nil, "test-secret", nil)
	if err != nil {
		t.Fatal(err)
	}
	permissions := []permission.Code{permission.AuditRead}
	admin := identity.User{
		OrgRole:     "admin",
		Permissions: []permission.Code{permission.MembersManage},
	}
	_, err = service.UpdateMember(t.Context(), admin, "target", UpdateMemberInput{Permissions: &permissions})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("admin permission update should be forbidden, got %v", err)
	}
	unknown := []permission.Code{"unknown"}
	owner := identity.User{OrgRole: "owner"}
	_, err = service.UpdateMember(t.Context(), owner, "target", UpdateMemberInput{Permissions: &unknown})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown permission should be invalid, got %v", err)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestMailDeliveryDefaultsAndValidation(t *testing.T) {
	if got := effectiveMailDelivery(integrationSecrets{}); got != MailDeliveryComa {
		t.Fatalf("empty settings = %q", got)
	}
	if got := effectiveMailDelivery(integrationSecrets{SMTP: SMTPConfig{Host: "smtp.example.com"}}); got != MailDeliverySMTP {
		t.Fatalf("existing SMTP = %q", got)
	}
	if got := effectiveMailDelivery(integrationSecrets{SMTP: SMTPConfig{Host: "smtp.example.com"}, MailDelivery: MailDeliveryOff}); got != MailDeliveryOff {
		t.Fatalf("explicit off = %q", got)
	}
	if err := validateIntegrations(integrationSecrets{MailDelivery: MailDeliverySMTP}); err == nil {
		t.Fatal("SMTP delivery without a host accepted")
	}
	if err := validateIntegrations(integrationSecrets{MailDelivery: "relay"}); err == nil {
		t.Fatal("unknown delivery accepted")
	}
	view := infrastructureView(1, integrationSecrets{})
	if view.Mail.Delivery != MailDeliveryComa {
		t.Fatalf("view = %+v", view.Mail)
	}
}

func TestBuildMessageEncodesHeaders(t *testing.T) {
	message, err := buildMessage(SMTPConfig{FromAddress: "coma@example.com", FromName: "Ромашка"}, "a@example.com", "Сброс пароля\r\nBcc: x@y", "текст", "<p>html</p>", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	header := message[:strings.Index(message, "\r\n\r\n")]
	if strings.Contains(header, "\r\nBcc:") || !strings.Contains(header, "Subject: =?utf-8?q?") || !strings.Contains(message, "multipart/alternative") {
		t.Fatalf("message:\n%s", message)
	}
}
