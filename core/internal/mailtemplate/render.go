package mailtemplate

import (
	"fmt"
	"html/template"
	"net/url"
	"strings"
	"time"
)

// Rendered is a ready letter.
type Rendered struct {
	Subject  string
	Text     string
	HTML     string
	Preview  string
	FromName string
}

type texts struct {
	fallbackWorkspace, fallbackInviter, via, footer, linkHost string
}

var localized = map[string]texts{
	"ru": {fallbackWorkspace: "Coma", fallbackInviter: "Коллега", via: "через Coma", footer: "Письмо отправила почта Coma по запросу пространства «%s». Ящик не принимает ответы.", linkHost: "Ссылка ведёт на сайт %s"},
	"en": {fallbackWorkspace: "Coma", fallbackInviter: "A colleague", via: "via Coma", footer: "Sent by Coma mail on behalf of the «%s» workspace. Replies to this address are not read.", linkHost: "The link opens %s"},
}

var monthsRU = [...]string{"января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"}

func formatDate(value time.Time, locale string) string {
	value = value.UTC()
	if locale == "en" {
		return value.Format("January 2, 2006")
	}
	return fmt.Sprintf("%d %s %d года", value.Day(), monthsRU[value.Month()-1], value.Year())
}

// plural picks the Russian form for n: one (1, 21), few (2–4, 22–24), many.
func plural(n int, one, few, many string) string {
	n %= 100
	if n >= 11 && n <= 14 {
		return many
	}
	switch n % 10 {
	case 1:
		return one
	case 2, 3, 4:
		return few
	}
	return many
}

func englishPlural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// block is one paragraph of a letter; Link turns it into "label: url" in
// text and a button in HTML.
type block struct {
	Text      string
	Lines     []string
	LinkLabel string
	Link      string
	// LinkHost names the site a button leads to; HTML shows it instead of
	// the raw address, so a crafted path cannot read as part of the letter.
	LinkHost string
	Muted    bool
}

// Render builds the letter. The message must be normalized and validated.
func Render(m Message) Rendered {
	locale := m.Locale
	if locale != "en" {
		locale = "ru"
	}
	words := localized[locale]
	workspace := CleanName(m.WorkspaceName, words.fallbackWorkspace)
	var subject, preview string
	var blocks []block
	en := locale == "en"
	switch m.Kind {
	case Invitation:
		inviter := CleanName(m.Data.InviterName, "")
		role := map[string]string{"member": "участник", "admin": "администратор"}[m.Data.Role]
		if en {
			role = map[string]string{"member": "a member", "admin": "an administrator"}[m.Data.Role]
		}
		expires := ""
		if m.Data.ExpiresAt != nil {
			expires = formatDate(*m.Data.ExpiresAt, locale)
		}
		if en {
			subject = fmt.Sprintf("Invitation to the «%s» workspace", workspace)
			who := words.fallbackInviter
			if inviter != "" {
				subject = fmt.Sprintf("%s invites you to the «%s» workspace", inviter, workspace)
				who = inviter
			}
			preview = "Accept the invitation before " + expires
			blocks = []block{
				{Text: "Hello!"},
				{Text: fmt.Sprintf("%s invites you to the «%s» workspace in the Coma messenger. You will join as %s.", who, workspace, role)},
				{LinkLabel: "Accept the invitation", Link: m.Data.Link},
				{Text: fmt.Sprintf("The link works once and expires on %s. If you did not expect this invitation, delete this email.", expires), Muted: true},
			}
		} else {
			subject = fmt.Sprintf("Приглашение в пространство «%s»", workspace)
			who := words.fallbackInviter
			if inviter != "" {
				subject = fmt.Sprintf("%s приглашает вас в пространство «%s»", inviter, workspace)
				who = inviter
			}
			preview = "Приглашение действует до " + expires
			blocks = []block{
				{Text: "Здравствуйте!"},
				{Text: fmt.Sprintf("%s приглашает вас в пространство «%s» в мессенджере Coma. Вы войдёте как %s.", who, workspace, role)},
				{LinkLabel: "Принять приглашение", Link: m.Data.Link},
				{Text: fmt.Sprintf("Ссылка одноразовая и действует до %s. Если вы не ждали приглашения, удалите письмо.", expires), Muted: true},
			}
		}
	case PasswordReset:
		if en {
			subject = fmt.Sprintf("Password reset in the «%s» workspace", workspace)
			preview = "The link is valid for 1 hour"
			blocks = []block{
				{Text: fmt.Sprintf("A password reset was requested for your account in the «%s» workspace.", workspace)},
				{LinkLabel: "Set a new password", Link: m.Data.Link},
				{Text: "The link is valid for 1 hour. If you did not request a reset, do nothing: your current password keeps working.", Muted: true},
			}
		} else {
			subject = fmt.Sprintf("Сброс пароля в пространстве «%s»", workspace)
			preview = "Ссылка действует 1 час"
			blocks = []block{
				{Text: fmt.Sprintf("Для вашей учётной записи в пространстве «%s» запросили сброс пароля.", workspace)},
				{LinkLabel: "Задать новый пароль", Link: m.Data.Link},
				{Text: "Ссылка действует 1 час. Если сброс запрашивали не вы, ничего не делайте: текущий пароль продолжит работать.", Muted: true},
			}
		}
	case EmailConfirmation:
		if en {
			subject = fmt.Sprintf("Confirm your new email in the «%s» workspace", workspace)
			preview = "The link is valid for 1 hour"
			blocks = []block{
				{Text: fmt.Sprintf("This address was entered as the new sign-in email for the «%s» workspace.", workspace)},
				{LinkLabel: "Confirm the address", Link: m.Data.Link},
				{Text: "The link is valid for 1 hour. If you did not change your email, do not open the link: your sign-in email stays the same.", Muted: true},
			}
		} else {
			subject = fmt.Sprintf("Подтвердите новую почту в пространстве «%s»", workspace)
			preview = "Ссылка действует 1 час"
			blocks = []block{
				{Text: fmt.Sprintf("Этот адрес указали как новую почту для входа в пространство «%s».", workspace)},
				{LinkLabel: "Подтвердить адрес", Link: m.Data.Link},
				{Text: "Ссылка действует 1 час. Если почту меняли не вы, не открывайте ссылку: почта для входа останется прежней.", Muted: true},
			}
		}
	case EmailChangeNotice:
		if en {
			subject = fmt.Sprintf("Email change in the «%s» workspace", workspace)
			preview = "Not you? Change your password"
			blocks = []block{
				{Text: fmt.Sprintf("A change of the email for your account in the «%s» workspace to another address was requested.", workspace)},
				{Text: "If it was you, open the link from the email sent to the new address. Without confirmation the change is cancelled in 1 hour."},
				{Text: "If it was not you, change your password and end other sessions: «Settings → Security»."},
			}
		} else {
			subject = fmt.Sprintf("Смена почты в пространстве «%s»", workspace)
			preview = "Если это не вы, смените пароль"
			blocks = []block{
				{Text: fmt.Sprintf("Для вашей учётной записи в пространстве «%s» запросили смену почты на другой адрес.", workspace)},
				{Text: "Если это вы, откройте ссылку из письма на новом адресе. Без подтверждения смена отменится через 1 час."},
				{Text: "Если не вы, смените пароль и завершите чужие сеансы: «Настройки → Безопасность»."},
			}
		}
	case Digest:
		d := m.Data
		if en {
			subject = fmt.Sprintf("%d new %s in the «%s» workspace", d.Total, englishPlural(d.Total, "notification", "notifications"), workspace)
			lines := []string{fmt.Sprintf("%d %s in %d %s", d.Total, englishPlural(d.Total, "notification", "notifications"), d.Chats, englishPlural(d.Chats, "chat", "chats"))}
			if d.Mentions > 0 {
				lines = append(lines, fmt.Sprintf("%d %s of you", d.Mentions, englishPlural(d.Mentions, "mention", "mentions")))
			}
			if d.Direct > 0 {
				lines = append(lines, fmt.Sprintf("%d in direct messages", d.Direct))
			}
			preview = lines[0]
			blocks = []block{
				{Text: fmt.Sprintf("While you were away, in the «%s» workspace:", workspace), Lines: lines},
				{LinkLabel: "Open Coma", Link: d.Link},
				{Text: "This email holds counters only, no message text."},
				{LinkLabel: "How often to send these emails", Link: d.SettingsLink, Muted: true},
			}
		} else {
			subject = fmt.Sprintf("%d %s %s в пространстве «%s»", d.Total, plural(d.Total, "новое", "новых", "новых"), plural(d.Total, "уведомление", "уведомления", "уведомлений"), workspace)
			lines := []string{fmt.Sprintf("%d %s в %d %s", d.Total, plural(d.Total, "уведомление", "уведомления", "уведомлений"), d.Chats, plural(d.Chats, "чате", "чатах", "чатах"))}
			if d.Mentions > 0 {
				lines = append(lines, fmt.Sprintf("%d %s вас", d.Mentions, plural(d.Mentions, "упоминание", "упоминания", "упоминаний")))
			}
			if d.Direct > 0 {
				lines = append(lines, fmt.Sprintf("%d %s в личных чатах", d.Direct, plural(d.Direct, "сообщение", "сообщения", "сообщений")))
			}
			preview = lines[0]
			blocks = []block{
				{Text: fmt.Sprintf("Пока вас не было, в пространстве «%s»:", workspace), Lines: lines},
				{LinkLabel: "Открыть Coma", Link: d.Link},
				{Text: "В письме только счётчики, без текста сообщений."},
				{LinkLabel: "Как часто присылать письма", Link: d.SettingsLink, Muted: true},
			}
		}
	}
	for index := range blocks {
		if blocks[index].Link == "" || blocks[index].Muted {
			continue
		}
		if link, err := url.Parse(blocks[index].Link); err == nil {
			if host, err := CanonicalHost(link); err == nil {
				blocks[index].LinkHost = fmt.Sprintf(words.linkHost, host)
			}
		}
	}
	footer := fmt.Sprintf(words.footer, workspace)
	return Rendered{
		Subject:  subject,
		Text:     renderText(blocks, footer),
		HTML:     renderHTML(subject, preview, blocks, footer),
		Preview:  preview,
		FromName: workspace + " " + words.via,
	}
}

func renderText(blocks []block, footer string) string {
	var builder strings.Builder
	for _, item := range blocks {
		if item.Text != "" {
			builder.WriteString(item.Text)
			builder.WriteString("\n")
		}
		for _, line := range item.Lines {
			builder.WriteString("• ")
			builder.WriteString(line)
			builder.WriteString("\n")
		}
		if item.Link != "" {
			builder.WriteString(item.LinkLabel)
			builder.WriteString(": ")
			builder.WriteString(item.Link)
			builder.WriteString("\n")
		}
		builder.WriteString("\n")
	}
	builder.WriteString("--\n")
	builder.WriteString(footer)
	builder.WriteString("\n")
	return builder.String()
}

var page = template.Must(template.New("letter").Parse(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{.Subject}}</title></head>
<body style="margin:0;padding:0;background:#f3f5f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1d2433">
<div style="display:none;max-height:0;overflow:hidden">{{.Preview}}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px">
<tr><td style="padding:24px 28px 0 28px;font-size:20px;font-weight:700;color:#174586">Coma</td></tr>
<tr><td style="padding:16px 28px 8px 28px;font-size:15px;line-height:1.55">
{{range .Blocks}}{{if .Link}}{{if .Muted}}<p style="margin:0 0 16px 0;font-size:13px;color:#5b6475"><a href="{{.Link}}" style="color:#174586">{{.LinkLabel}}</a></p>{{else}}<p style="margin:8px 0 20px 0"><a href="{{.Link}}" style="display:inline-block;background:#174586;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">{{.LinkLabel}}</a></p>
{{if .LinkHost}}<p style="margin:0 0 16px 0;font-size:12px;color:#5b6475">{{.LinkHost}}</p>{{end}}{{end}}{{else}}<p style="margin:0 0 16px 0{{if .Muted}};font-size:13px;color:#5b6475{{end}}">{{.Text}}</p>{{if .Lines}}<ul style="margin:-8px 0 16px 0;padding-left:20px">{{range .Lines}}<li>{{.}}</li>{{end}}</ul>{{end}}{{end}}{{end}}
</td></tr>
<tr><td style="padding:12px 28px 24px 28px;border-top:1px solid #e6e9ef;font-size:12px;color:#7a8394">{{.Footer}}</td></tr>
</table></td></tr></table></body></html>`))

func renderHTML(subject, preview string, blocks []block, footer string) string {
	var builder strings.Builder
	if err := page.Execute(&builder, map[string]any{"Subject": subject, "Preview": preview, "Blocks": blocks, "Footer": footer}); err != nil {
		return ""
	}
	return builder.String()
}
