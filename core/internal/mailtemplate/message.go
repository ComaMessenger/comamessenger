// Package mailtemplate holds the only email bodies Coma sends: the mail relay
// (ADR-0013) and the workspace SMTP transport build every letter from a
// typed Message here. Installations never supply a subject, HTML or text.
package mailtemplate

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

type Kind string

const (
	Invitation        Kind = "invitation"
	PasswordReset     Kind = "password_reset"
	EmailConfirmation Kind = "email_confirmation"
	EmailChangeNotice Kind = "email_change_notice"
	Digest            Kind = "digest"
)

// Kinds lists every accepted message type.
var Kinds = []Kind{Invitation, PasswordReset, EmailConfirmation, EmailChangeNotice, Digest}

// Message is the whole contract between an installation and the relay.
type Message struct {
	Kind          Kind   `json:"type"`
	To            string `json:"to"`
	Locale        string `json:"locale,omitempty"`
	WorkspaceName string `json:"workspace_name"`
	Data          Data   `json:"data"`
}

// Data carries type-specific fields. Digest counters are numbers only: the
// relay never receives message text, chat names or authors.
type Data struct {
	Link         string     `json:"link,omitempty"`
	SettingsLink string     `json:"settings_link,omitempty"`
	InviterName  string     `json:"inviter_name,omitempty"`
	Role         string     `json:"role,omitempty"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
	Total        int        `json:"total,omitempty"`
	Mentions     int        `json:"mentions,omitempty"`
	Direct       int        `json:"direct,omitempty"`
	Chats        int        `json:"chats,omitempty"`
}

// Delivery outcomes shared by every package that sends mail.
var (
	// ErrNotConfigured: the workspace has no usable transport.
	ErrNotConfigured = errors.New("email delivery is not configured")
	// ErrLimit: the Coma mail daily limit for the recipient or the
	// installation is reached; retrying before the window rolls is useless.
	ErrLimit = errors.New("coma mail limit reached")
	// ErrRejected: the relay refused this letter for good (suppressed
	// recipient, invalid data, revoked installation).
	ErrRejected = errors.New("coma mail rejected the letter")
)

// ErrInvalid marks a message the relay must reject with 400.
var ErrInvalid = errors.New("invalid message")

// ErrInvalidLink marks a link outside the installation's verified address.
var ErrInvalidLink = errors.New("invalid link")

const (
	maxNameRunes = 60
	maxCounter   = 100000
	maxLinkBytes = 2048
)

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{20,512}$`)

// Decode parses a request body strictly: unknown fields are rejected so an
// installation cannot smuggle a subject or HTML past the contract.
func Decode(raw []byte) (Message, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var message Message
	if err := decoder.Decode(&message); err != nil {
		return Message{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if decoder.More() {
		return Message{}, fmt.Errorf("%w: trailing data", ErrInvalid)
	}
	return message, nil
}

// Normalize trims the free-text fields and defaults the locale.
func (m *Message) Normalize() {
	m.To = strings.ToLower(strings.TrimSpace(m.To))
	if m.Locale != "en" {
		m.Locale = "ru"
	}
	m.WorkspaceName = strings.TrimSpace(m.WorkspaceName)
	m.Data.InviterName = strings.TrimSpace(m.Data.InviterName)
}

// Validate checks the message against the contract. base is the
// installation's verified public address; every link must point inside it.
func (m Message) Validate(base *url.URL) error {
	if len(m.To) > 254 || strings.ContainsAny(m.To, "\r\n<>,;\" ") {
		return fmt.Errorf("%w: recipient", ErrInvalid)
	}
	parsed, err := mail.ParseAddress(m.To)
	if err != nil || parsed.Address != m.To || !strings.Contains(m.To, "@") {
		return fmt.Errorf("%w: recipient", ErrInvalid)
	}
	if utf8.RuneCountInString(m.WorkspaceName) > 200 || utf8.RuneCountInString(m.Data.InviterName) > 200 {
		return fmt.Errorf("%w: name too long", ErrInvalid)
	}
	if m.Locale != "ru" && m.Locale != "en" {
		return fmt.Errorf("%w: locale", ErrInvalid)
	}
	data := m.Data
	noCounters := data.Total == 0 && data.Mentions == 0 && data.Direct == 0 && data.Chats == 0
	switch m.Kind {
	case Invitation:
		if data.Role != "member" && data.Role != "admin" {
			return fmt.Errorf("%w: role", ErrInvalid)
		}
		if data.ExpiresAt == nil || data.SettingsLink != "" || !noCounters {
			return fmt.Errorf("%w: invitation fields", ErrInvalid)
		}
		return checkLink(base, data.Link, "/invite/", "")
	case PasswordReset:
		if data.Role != "" || data.InviterName != "" || data.ExpiresAt != nil || data.SettingsLink != "" || !noCounters {
			return fmt.Errorf("%w: password reset fields", ErrInvalid)
		}
		return checkLink(base, data.Link, "/reset-password", "token")
	case EmailConfirmation:
		if data.Role != "" || data.InviterName != "" || data.ExpiresAt != nil || data.SettingsLink != "" || !noCounters {
			return fmt.Errorf("%w: email confirmation fields", ErrInvalid)
		}
		return checkLink(base, data.Link, "/settings/security", "email_token")
	case EmailChangeNotice:
		if data != (Data{}) {
			return fmt.Errorf("%w: email change notice takes no data", ErrInvalid)
		}
		return nil
	case Digest:
		if data.Role != "" || data.InviterName != "" || data.ExpiresAt != nil {
			return fmt.Errorf("%w: digest fields", ErrInvalid)
		}
		for _, value := range []int{data.Total, data.Mentions, data.Direct, data.Chats} {
			if value < 0 || value > maxCounter {
				return fmt.Errorf("%w: digest counter", ErrInvalid)
			}
		}
		if data.Total < 1 || data.Mentions > data.Total || data.Direct > data.Total || data.Chats > data.Total {
			return fmt.Errorf("%w: digest counters", ErrInvalid)
		}
		if err := checkLink(base, data.Link, "/", ""); err != nil {
			return err
		}
		return checkLink(base, data.SettingsLink, "/settings/notifications", "")
	default:
		return fmt.Errorf("%w: unknown type", ErrInvalid)
	}
}

// checkLink accepts only base + path. For "/invite/" the path ends with a
// token; with query set the link has exactly that one query parameter
// holding a token; otherwise the link has no query.
func checkLink(base *url.URL, raw, path, query string) error {
	if base == nil {
		return fmt.Errorf("%w: installation address unknown", ErrInvalidLink)
	}
	if raw == "" || len(raw) > maxLinkBytes {
		return fmt.Errorf("%w: missing or too long", ErrInvalidLink)
	}
	link, err := url.Parse(raw)
	if err != nil || link.User != nil || link.Fragment != "" || link.Opaque != "" || link.RawFragment != "" {
		return fmt.Errorf("%w: malformed", ErrInvalidLink)
	}
	linkHost, linkErr := CanonicalHost(link)
	baseHost, baseErr := CanonicalHost(base)
	if link.Scheme != base.Scheme || linkErr != nil || baseErr != nil || linkHost != baseHost {
		return fmt.Errorf("%w: foreign host", ErrInvalidLink)
	}
	prefix := strings.TrimRight(base.EscapedPath(), "/")
	escaped := link.EscapedPath()
	if !strings.HasPrefix(escaped, prefix) {
		return fmt.Errorf("%w: foreign path", ErrInvalidLink)
	}
	rest := strings.TrimPrefix(escaped, prefix)
	switch {
	case path == "/invite/":
		if !strings.HasPrefix(rest, path) || !tokenPattern.MatchString(strings.TrimPrefix(rest, path)) || link.RawQuery != "" {
			return fmt.Errorf("%w: invitation path", ErrInvalidLink)
		}
		return nil
	case path == "/":
		if (rest != "" && rest != "/") || link.RawQuery != "" {
			return fmt.Errorf("%w: app path", ErrInvalidLink)
		}
		return nil
	default:
		if rest != path {
			return fmt.Errorf("%w: path", ErrInvalidLink)
		}
	}
	if query == "" {
		if link.RawQuery != "" {
			return fmt.Errorf("%w: unexpected query", ErrInvalidLink)
		}
		return nil
	}
	values, err := url.ParseQuery(link.RawQuery)
	if err != nil || len(values) != 1 || len(values[query]) != 1 || !tokenPattern.MatchString(values.Get(query)) {
		return fmt.Errorf("%w: query", ErrInvalidLink)
	}
	return nil
}

// linkLike matches what reads as an address or a contact: schemes, www,
// e-mail, word.word (any letters, so «сайт.рф» and «ПОРТАЛ.ГОСУСЛУГИ» too),
// spelled-out dots and messenger handles. It runs on NFKC text with every
// dot look-alike folded to «.».
var linkLike = regexp.MustCompile(`(?i)(://|www\.|@|[\p{L}\p{N}-]+\s*(\.|\[\.\]|\(\.\)|\[dot\]|\(dot\)|\sdot\s|\sточка\s)\s*[\p{L}]{2,}|https?|ftp:|t\.me|wa\.me|telegram|whatsapp|viber|\btg\b)`)

// dotLike are characters mail clients may render or linkify as a dot.
var dotLike = strings.NewReplacer("\u3002", ".", "\uFF0E", ".", "\uFF61", ".", "\u2024", ".", "\u00B7", ".", "\u2027", ".", "\u2219", ".", "\u0701", ".", "\u0702", ".", "\uFE52", ".", "\u06D4", ".", "\u2E3C", ".")

// contactLike reports a name that carries a phone number: seven digits or
// more in total.
func contactLike(value string) bool {
	digits := 0
	for _, character := range value {
		if unicode.IsDigit(character) {
			digits++
		}
	}
	return digits >= 7
}

// CleanName prepares user-controlled text for a subject, the From display
// name and the body: no control or format characters (bidi overrides
// included), one line, at most 60 characters. A name that looks like a web
// or mail address is replaced with fallback, since the recipient sees it as
// coming from coma-chat.com.
func CleanName(value, fallback string) string {
	var builder strings.Builder
	space := false
	for _, character := range value {
		switch {
		case unicode.IsSpace(character):
			space = true
			continue
		case unicode.IsControl(character), unicode.Is(unicode.Cf, character), unicode.Is(unicode.Co, character),
			unicode.Is(unicode.Cs, character), character == utf8.RuneError,
			character == '<', character == '>', character == '"', character == '«', character == '»', character == '\\':
			continue
		}
		if space && builder.Len() > 0 {
			builder.WriteByte(' ')
		}
		space = false
		builder.WriteRune(character)
	}
	cleaned := norm.NFKC.String(builder.String())
	if utf8.RuneCountInString(cleaned) > maxNameRunes {
		runes := []rune(cleaned)
		cleaned = strings.TrimSpace(string(runes[:maxNameRunes-1])) + "…"
	}
	if cleaned == "" || linkLike.MatchString(dotLike.Replace(cleaned)) || contactLike(cleaned) {
		return fallback
	}
	return cleaned
}
