package mailtemplate

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

var base, _ = url.Parse("https://chat.example.ru")

const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd"

func invitation() Message {
	expires := time.Date(2026, 11, 23, 10, 0, 0, 0, time.UTC)
	return Message{Kind: Invitation, To: "anna@example.com", Locale: "ru", WorkspaceName: "Ромашка",
		Data: Data{Link: "https://chat.example.ru/invite/" + token, InviterName: "Иван Петров", Role: "member", ExpiresAt: &expires}}
}

func TestDecodeRejectsUnknownFields(t *testing.T) {
	for _, body := range []string{
		`{"type":"invitation","to":"a@b.ru","workspace_name":"x","data":{},"subject":"buy"}`,
		`{"type":"invitation","to":"a@b.ru","workspace_name":"x","data":{"html":"<b>"}}`,
		`{"type":"digest"} {"type":"digest"}`,
	} {
		if _, err := Decode([]byte(body)); err == nil {
			t.Fatalf("accepted %s", body)
		}
	}
}

func TestValidateLinks(t *testing.T) {
	cases := map[string]bool{
		"https://chat.example.ru/invite/" + token:                true,
		"https://chat.example.ru.evil.com/invite/" + token:       false,
		"https://evil.com/invite/" + token:                       false,
		"http://chat.example.ru/invite/" + token:                 false,
		"https://user@chat.example.ru/invite/" + token:           false,
		"https://chat.example.ru/invite/" + token + "#x":         false,
		"https://chat.example.ru/invite/" + token + "?next=evil": false,
		"https://chat.example.ru/invite/short":                   false,
		"https://chat.example.ru/invite/../login":                false,
		"https://chat.example.ru/invite/" + token + "/../../x":   false,
		"https://chat.example.ru//evil.com/invite/" + token:      false,
		"javascript:alert(1)":                                    false,
	}
	for link, ok := range cases {
		message := invitation()
		message.Data.Link = link
		err := message.Validate(base)
		if (err == nil) != ok {
			t.Errorf("%s: got %v", link, err)
		}
	}
	reset := Message{Kind: PasswordReset, To: "a@b.ru", Locale: "ru", Data: Data{Link: "https://chat.example.ru/reset-password?token=" + token}}
	if err := reset.Validate(base); err != nil {
		t.Fatal(err)
	}
	reset.Data.Link += "&next=https://evil.com"
	if err := reset.Validate(base); err == nil {
		t.Fatal("extra query accepted")
	}
	confirm := Message{Kind: EmailConfirmation, To: "a@b.ru", Locale: "ru", Data: Data{Link: "https://chat.example.ru/settings/security?email_token=" + token}}
	if err := confirm.Validate(base); err != nil {
		t.Fatal(err)
	}
	withPath, _ := url.Parse("https://example.org/coma")
	invite := invitation()
	invite.Data.Link = "https://example.org/coma/invite/" + token
	if err := invite.Validate(withPath); err != nil {
		t.Fatal(err)
	}
	invite.Data.Link = "https://example.org/invite/" + token
	if err := invite.Validate(withPath); err == nil {
		t.Fatal("link outside base path accepted")
	}
}

func TestValidateFields(t *testing.T) {
	notice := Message{Kind: EmailChangeNotice, To: "a@b.ru", Locale: "ru"}
	if err := notice.Validate(base); err != nil {
		t.Fatal(err)
	}
	notice.Data.Link = "https://chat.example.ru/"
	if err := notice.Validate(base); err == nil {
		t.Fatal("notice with link accepted")
	}
	for _, to := range []string{"a@b.ru\r\nBcc: x@y.ru", "Anna <a@b.ru>", "a@b.ru, c@d.ru", "nobody"} {
		message := invitation()
		message.To = to
		if err := message.Validate(base); err == nil {
			t.Errorf("recipient %q accepted", to)
		}
	}
	message := invitation()
	message.Data.Role = "owner"
	if err := message.Validate(base); err == nil {
		t.Fatal("owner role accepted")
	}
	digest := Message{Kind: Digest, To: "a@b.ru", Locale: "ru", Data: Data{Link: "https://chat.example.ru/", SettingsLink: "https://chat.example.ru/settings/notifications", Total: 3, Mentions: 1, Direct: 1, Chats: 2}}
	if err := digest.Validate(base); err != nil {
		t.Fatal(err)
	}
	digest.Data.Mentions = 9
	if err := digest.Validate(base); err == nil {
		t.Fatal("inconsistent counters accepted")
	}
}

func TestCleanName(t *testing.T) {
	cases := map[string]string{
		"Ромашка":                    "Ромашка",
		"  Ромашка\r\nBcc: x@y.ru ":  "Coma",
		"Выиграй приз на evil.com":   "Coma",
		"Выиграй приз на evil . com": "Coma",
		"Скидки www.example":         "Coma",
		"Пиши на spam@example.com":   "Coma",
		"Зайди на сайт.рф":           "Coma",
		"Отдел‮продаж":               "Отделпродаж",
		"<b>Жирный</b> «Цех»":        "bЖирный/b Цех",
		strings.Repeat("я", 100):     strings.Repeat("я", 59) + "…",
		"Coma 2.0":                   "Coma 2.0",
	}
	for input, want := range cases {
		if got := CleanName(input, "Coma"); got != want {
			t.Errorf("CleanName(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestRenderInvitation(t *testing.T) {
	message := invitation()
	message.WorkspaceName = `<script>alert(1)</script>`
	message.Data.InviterName = "Иван \"<img src=x>\""
	rendered := Render(message)
	if strings.Contains(rendered.HTML, "<script>") || strings.Contains(rendered.HTML, "<img") {
		t.Fatal("HTML injection survived")
	}
	if !strings.Contains(rendered.Text, "https://chat.example.ru/invite/"+token) || !strings.Contains(rendered.Text, "23 ноября 2026 года") {
		t.Fatalf("text: %s", rendered.Text)
	}
	if !strings.HasSuffix(rendered.FromName, "через Coma") || strings.ContainsAny(rendered.Subject, "\r\n") {
		t.Fatalf("headers: %q %q", rendered.FromName, rendered.Subject)
	}
	plain := Render(invitation())
	if plain.Subject != "Иван Петров приглашает вас в пространство «Ромашка»" || plain.FromName != "Ромашка через Coma" {
		t.Fatalf("subject %q from %q", plain.Subject, plain.FromName)
	}
}

func TestRenderDigestHasOnlyCounters(t *testing.T) {
	message := Message{Kind: Digest, To: "a@b.ru", Locale: "ru", WorkspaceName: "Ромашка", Data: Data{Link: "https://chat.example.ru/", SettingsLink: "https://chat.example.ru/settings/notifications", Total: 12, Mentions: 2, Direct: 4, Chats: 3}}
	rendered := Render(message)
	for _, want := range []string{"12 новых уведомлений", "12 уведомлений в 3 чатах", "2 упоминания вас", "4 сообщения в личных чатах"} {
		if !strings.Contains(rendered.Subject+rendered.Text, want) {
			t.Errorf("missing %q in %s", want, rendered.Text)
		}
	}
	message.Locale = "en"
	if english := Render(message); !strings.Contains(english.Subject, "12 new notifications") {
		t.Fatal(english.Subject)
	}
}
