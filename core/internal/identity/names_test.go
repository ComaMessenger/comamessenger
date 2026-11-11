package identity

import (
	"strings"
	"testing"
)

// Display and organization names are limited in characters, not bytes:
// 120 Cyrillic letters fit as 120 Latin ones do.
func TestBootstrapNamesCountCharacters(t *testing.T) {
	valid := BootstrapInput{
		OrganizationName: strings.Repeat("О", 120), OrganizationSlug: "names",
		DisplayName: strings.Repeat("Ж", 120), Handle: "owner",
		Email: "owner@example.com", Password: "long-enough-password", Timezone: "UTC",
	}
	if err := validateBootstrap(valid); err != nil {
		t.Fatalf("120 Cyrillic letters: %v", err)
	}
	tooLong := valid
	tooLong.DisplayName += "Ж"
	if err := validateBootstrap(tooLong); err == nil || !strings.Contains(err.Error(), "display_name") {
		t.Fatalf("121 letters display_name: %v", err)
	}
	tooLong = valid
	tooLong.OrganizationName += "О"
	if err := validateBootstrap(tooLong); err == nil || !strings.Contains(err.Error(), "organization_name") {
		t.Fatalf("121 letters organization_name: %v", err)
	}
}
