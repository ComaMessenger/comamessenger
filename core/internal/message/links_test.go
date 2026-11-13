package message

import (
	"strings"
	"testing"
)

func TestExtractLinks(t *testing.T) {
	type want struct {
		url, domain, label string
		offset             int
	}
	cases := []struct {
		name   string
		body   string
		format string
		want   []want
	}{
		{"plain https", "see https://example.com/a?b=1#c now", "plain",
			[]want{{"https://example.com/a?b=1#c", "example.com", "", 4}}},
		{"http and upper case scheme", "HTTP://Example.COM:8080/Path", "plain",
			[]want{{"HTTP://Example.COM:8080/Path", "example.com", "", 0}}},
		{"www without scheme gets https", "go to www.github.com/x.", "plain",
			[]want{{"https://www.github.com/x", "github.com", "", 6}}},
		{"cyrillic domain and path", "Сайт: https://пример.рф/путь/страница, и всё", "plain",
			[]want{{"https://пример.рф/путь/страница", "пример.рф", "", 6}}},
		{"punycode shown as unicode", "https://xn--e1afmkfd.xn--p1ai/", "plain",
			[]want{{"https://xn--e1afmkfd.xn--p1ai/", "пример.рф", "", 0}}},
		{"cyrillic www", "www.кто.рф", "plain",
			[]want{{"https://www.кто.рф", "кто.рф", "", 0}}},
		{"trailing punctuation", "Look: https://a.io/x... Or https://b.io/y?! And https://c.io/z…", "plain",
			[]want{{"https://a.io/x", "a.io", "", 6}, {"https://b.io/y", "b.io", "", 27}, {"https://c.io/z", "c.io", "", 48}}},
		{"brackets around and inside", "(see https://en.wikipedia.org/wiki/Go_(language)) [https://x.ru/a]", "plain",
			[]want{{"https://en.wikipedia.org/wiki/Go_(language)", "en.wikipedia.org", "", 5}, {"https://x.ru/a", "x.ru", "", 51}}},
		{"quotes and guillemets", `«https://ya.ru» "https://b.ru" 'https://c.ru'`, "plain",
			[]want{{"https://ya.ru", "ya.ru", "", 1}, {"https://b.ru", "b.ru", "", 17}, {"https://c.ru", "c.ru", "", 32}}},
		{"markdown link has a label", "Read [the docs](https://docs.example.com/start) today", "markdown",
			[]want{{"https://docs.example.com/start", "docs.example.com", "the docs", 16}}},
		{"markdown link label equal to url", "[https://a.ru](https://a.ru)", "markdown",
			[]want{{"https://a.ru", "a.ru", "", 1}}},
		{"markdown autolink and emphasis", "<https://a.ru/x> and **https://b.ru**", "markdown",
			[]want{{"https://a.ru/x", "a.ru", "", 1}, {"https://b.ru", "b.ru", "", 23}}},
		{"markdown code is skipped", "`https://code.ru` and\n```\nhttps://fence.ru\n```\nhttps://real.ru", "markdown",
			[]want{{"https://real.ru", "real.ru", "", 47}}},
		{"code spans count in plain text", "`https://code.ru`", "plain",
			[]want{{"https://code.ru", "code.ru", "", 1}}},
		{"duplicates collapse", "https://a.ru and again https://a.ru", "plain",
			[]want{{"https://a.ru", "a.ru", "", 0}}},
		{"ip address and port", "http://192.168.1.10:8080/status", "plain",
			[]want{{"http://192.168.1.10:8080/status", "192.168.1.10", "", 0}}},
		{"not links", "file.txt v1.2 mailto:a@b.ru ftp://x.ru http:// https://localhost:3000 https://a.b1 xhttps://a.ru me@www.a.ru http://-bad-.ru", "plain", nil},
		{"adjacent links separated by space only", "https://a.ru https://b.ru", "plain",
			[]want{{"https://a.ru", "a.ru", "", 0}, {"https://b.ru", "b.ru", "", 13}}},
		{"query with cyrillic and percent", "https://yandex.ru/search/?text=кот%20Борис&lr=213", "plain",
			[]want{{"https://yandex.ru/search/?text=кот%20Борис&lr=213", "yandex.ru", "", 0}}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got := ExtractLinks(test.body, test.format)
			if len(got) != len(test.want) {
				t.Fatalf("ExtractLinks(%q) = %+v, want %d links", test.body, got, len(test.want))
			}
			for index, link := range got {
				expected := test.want[index]
				label := ""
				if link.Label != nil {
					label = *link.Label
				}
				if link.URL != expected.url || link.Domain != expected.domain || label != expected.label || link.Offset != expected.offset {
					t.Errorf("link %d = {%q %q %q %d}, want %+v", index, link.URL, link.Domain, label, link.Offset, expected)
				}
				// The offset points at the link in the body, in characters.
				if !strings.HasPrefix(strings.ToLower(string([]rune(test.body)[link.Offset:])), strings.ToLower(strings.TrimPrefix(link.URL, "https://"))) &&
					!strings.HasPrefix(strings.ToLower(string([]rune(test.body)[link.Offset:])), strings.ToLower(link.URL)) {
					t.Errorf("offset %d of %q does not point at the link", link.Offset, link.URL)
				}
			}
		})
	}
}

func TestExtractLinksLimits(t *testing.T) {
	var body strings.Builder
	for index := 0; index < maxLinksPerMessage+10; index++ {
		body.WriteString("https://a")
		body.WriteString(strings.Repeat("b", index))
		body.WriteString(".ru ")
	}
	if got := ExtractLinks(body.String(), "plain"); len(got) != maxLinksPerMessage {
		t.Fatalf("links = %d, want %d", len(got), maxLinksPerMessage)
	}
	long := "https://a.ru/" + strings.Repeat("x", maxLinkLength)
	if got := ExtractLinks(long, "plain"); len(got) != 0 {
		t.Fatalf("over-long link extracted: %d", len(got))
	}
	if got := ExtractLinks("just text without links", "plain"); got != nil {
		t.Fatalf("plain text gave %+v", got)
	}
	if got := ExtractLinks("\xff https://a.ru", "plain"); got != nil {
		t.Fatalf("invalid UTF-8 gave %+v", got)
	}
}

func TestDecodePunycode(t *testing.T) {
	for encoded, want := range map[string]string{"e1afmkfd": "пример", "p1ai": "рф", "mnchen-3ya": "münchen", "d1acufc": "домен"} {
		if got, ok := decodePunycode(encoded); !ok || got != want {
			t.Errorf("decodePunycode(%q) = %q, %v; want %q", encoded, got, ok, want)
		}
	}
	for _, bad := range []string{"", "!!", "-"} {
		if got, ok := decodePunycode(bad); ok {
			t.Errorf("decodePunycode(%q) = %q, want failure", bad, got)
		}
	}
}
