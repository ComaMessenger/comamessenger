package message

import (
	"strings"
	"testing"
	"time"
	"unicode"
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

// pathologicalBodies are the review's worst cases: 64 KB of almost-links
// that a quadratic parser took seconds on, under the organization lock.
func pathologicalBodies(scale int) map[string]string {
	return map[string]string{
		"www.x!":            strings.Repeat("www.x!", 10900*scale/4),
		"https://x(":        strings.Repeat("https://x(", 6500*scale/4),
		"*http://-":         strings.Repeat("*http://-", 7300*scale/4),
		"closing brackets":  "https://a.ru/" + strings.Repeat(")", 65000*scale/4),
		"long link token":   "https://a.ru/" + strings.Repeat("a", 65000*scale/4),
		"many short links":  strings.Repeat("https://a.ru/x ", 4300*scale/4),
		"markdown brackets": strings.Repeat("]](https://a.ru)", 4000*scale/4),
	}
}

func TestExtractLinksLinear(t *testing.T) {
	for name, body := range pathologicalBodies(4) {
		for _, format := range []string{"plain", "markdown"} {
			started := time.Now()
			ExtractLinks(body, format)
			t.Logf("%s (%s, %d bytes): %v", name, format, len(body), time.Since(started))
			// Milliseconds in fact; the bound leaves room for a slow CI.
			if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
				t.Errorf("%s (%s, %d bytes) took %v", name, format, len(body), elapsed)
			}
		}
	}
	// The closing brackets do not belong to the link.
	if got := ExtractLinks("https://a.ru/"+strings.Repeat(")", 65000), "plain"); len(got) != 1 || got[0].URL != "https://a.ru/" {
		t.Fatalf("closing brackets: %+v", got)
	}
}

// TestExtractLinksScalesLinearly fails if parsing turns quadratic again: four
// times the body may cost about four times as long, never sixteen.
func TestExtractLinksScalesLinearly(t *testing.T) {
	if testing.Short() {
		t.Skip("timing")
	}
	small, large := pathologicalBodies(1), pathologicalBodies(4)
	for name := range small {
		// The best of several runs: a pause of the collector or the CI
		// machine only ever makes a run slower.
		cost := func(body string) float64 {
			best := time.Duration(0)
			for attempt := 0; attempt < 7; attempt++ {
				started := time.Now()
				for range 4 {
					ExtractLinks(body, "markdown")
				}
				if elapsed := time.Since(started); best == 0 || elapsed < best {
					best = elapsed
				}
			}
			return float64(best)
		}
		ratio := cost(large[name]) / cost(small[name])
		t.Logf("%s: ×%.1f for ×4 input", name, ratio)
		if ratio > 9 {
			t.Errorf("%s: 4× the body costs %.1f× the time: parsing is no longer linear", name, ratio)
		}
	}
}

func BenchmarkExtractLinksPathological(b *testing.B) {
	for name, body := range pathologicalBodies(4) {
		b.Run(name, func(b *testing.B) {
			b.SetBytes(int64(len(body)))
			for range b.N {
				ExtractLinks(body, "markdown")
			}
		})
	}
}

func TestExtractLinksHomographs(t *testing.T) {
	cases := []struct{ body, url, domain string }{
		// Cyrillic «аррӏе» before a Latin TLD reads as apple.com: punycode.
		{"https://xn--80ak6aa92e.com/login", "https://xn--80ak6aa92e.com/login", "xn--80ak6aa92e.com"},
		{"https://аррӏе.com/login", "https://xn--80ak6aa92e.com/login", "xn--80ak6aa92e.com"},
		// Latin and Cyrillic mixed inside one label.
		{"https://pаypal.com", "https://xn--pypal-4ve.com", "xn--pypal-4ve.com"},
		// One script throughout: Unicode, as written.
		{"https://xn--e1afmkfd.xn--p1ai", "https://xn--e1afmkfd.xn--p1ai", "пример.рф"},
		{"https://пример.рф", "https://пример.рф", "пример.рф"},
		{"www.кто.рф", "https://www.кто.рф", "кто.рф"},
		{"https://xn--mnchen-3ya.de", "https://xn--mnchen-3ya.de", "münchen.de"},
		{"https://例え.テスト", "https://例え.テスト", "例え.テスト"},
		// National domains under a Latin zone: one script per label, shown.
		{"https://пример.com", "https://пример.com", "пример.com"},
		{"https://xn--e1afmkfd.com", "https://xn--e1afmkfd.com", "пример.com"},
		{"https://中文.com", "https://中文.com", "中文.com"},
		{"https://例え.jp", "https://例え.jp", "例え.jp"},
		{"https://ελλάδα.gr", "https://ελλάδα.gr", "ελλάδα.gr"},
		{"https://a1-b2.рф", "https://a1-b2.рф", "a1-b2.рф"},
		{"https://мой-сайт2.org/x", "https://мой-сайт2.org/x", "мой-сайт2.org"},
		// Only Latin twins under a Latin zone: punycode.
		{"https://сохо.net", "https://xn--n1aahr.net", "xn--n1aahr.net"},
		{"https://οκτ.com", "https://xn--vxajq.com", "xn--vxajq.com"},
		{"https://www.аррӏе.com", "https://www.xn--80ak6aa92e.com", "xn--80ak6aa92e.com"},
		// Two scripts in one label, whatever the zone.
		{"https://münchenпример.de", "https://xn--mnchen-3ya917d0a4b5amd.de", "xn--mnchen-3ya917d0a4b5amd.de"},
	}
	for _, test := range cases {
		got := ExtractLinks(test.body, "plain")
		if len(got) != 1 || got[0].URL != test.url || got[0].Domain != test.domain {
			t.Errorf("ExtractLinks(%q) = %+v, want %s shown as %s", test.body, got, test.url, test.domain)
		}
	}
}

func TestExtractLinksStopAtInvisibleCharacters(t *testing.T) {
	for _, mark := range []rune{0x202E, 0x202D, 0x2066, 0x200B, 0x200E, 0x00AD, 0xFEFF, 0x2060} {
		body := "https://good.example/" + string(mark) + "gpj.exe"
		got := ExtractLinks(body, "plain")
		if len(got) != 1 || got[0].URL != "https://good.example/" {
			t.Errorf("U+%04X: %+v, want the link to end before it", mark, got)
		}
		for _, link := range got {
			for _, value := range link.URL {
				if unicode.Is(unicode.Cf, value) {
					t.Errorf("U+%04X left in %q", mark, link.URL)
				}
			}
		}
	}
}

func TestPunycodeRoundTrip(t *testing.T) {
	for _, label := range []string{"пример", "рф", "münchen", "аррӏе", "pаypal", "例え", "テスト", "домен-1"} {
		encoded, ok := encodePunycode(label)
		if !ok {
			t.Fatalf("encodePunycode(%q) failed", label)
		}
		decoded, ok := decodePunycode(encoded)
		if !ok || decoded != label {
			t.Errorf("%q → %q → %q", label, encoded, decoded)
		}
	}
	if encoded, _ := encodePunycode("аррӏе"); encoded != "80ak6aa92e" {
		t.Errorf("encodePunycode(аррӏе) = %q", encoded)
	}
}
