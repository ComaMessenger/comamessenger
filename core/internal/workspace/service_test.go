package workspace

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/identity"
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

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
