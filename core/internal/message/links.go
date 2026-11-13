package message

import (
	"net"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Links of a message are found in its text only: no request ever leaves the
// server, and no page is fetched or previewed. A link starts with http://,
// https:// or www. at a word boundary and runs to the first space or
// delimiter; trailing punctuation and closing brackets without a pair are
// not part of it. Bare domains («example.com») are not taken: «file.txt» and
// «v1.2» would be links too.

const (
	maxLinksPerMessage = 50
	maxLinkLength      = 2048
	maxLinkLabel       = 300
)

// ExtractedLink is one distinct URL of a message, in order of appearance.
type ExtractedLink struct {
	URL    string
	Domain string
	// Label is the text of a markdown link «[label](url)», if any.
	Label *string
	// Offset counts characters (runes) from the start of the body.
	Offset int
}

// ExtractLinks returns the distinct http(s) links of a message body, at most
// maxLinksPerMessage. Code spans and fenced blocks of markdown are skipped.
//
// The work is linear in the body: callers run it before taking any lock, but
// a body of junk must still cost microseconds, not seconds (TestExtractLinks
// Linear). Each run of characters without a stop («token») is examined in
// full at most once: a candidate whose host looks wrong is dropped after
// reading only its host, and a candidate that gets as far as trimming and
// parsing ends the token whether it turns out to be a link or not.
func ExtractLinks(body, format string) []ExtractedLink {
	if body == "" || !utf8.ValidString(body) {
		return nil
	}
	lower := strings.ToLower(body)
	if !strings.Contains(lower, "http://") && !strings.Contains(lower, "https://") && !strings.Contains(lower, "www.") {
		return nil
	}
	text := []rune(body)
	markdown := format == "markdown"
	scan := text
	if markdown {
		scan = maskMarkdownCode(text)
	}
	// tokenEnd[i]: the first stop at or after i, found in one backward pass.
	tokenEnd := make([]int32, len(scan)+1)
	tokenEnd[len(scan)] = int32(len(scan))
	for index := len(scan) - 1; index >= 0; index-- {
		if linkStop(scan[index]) || (scan[index] == ']' && index+1 < len(scan) && scan[index+1] == '(') {
			tokenEnd[index] = int32(index)
		} else {
			tokenEnd[index] = tokenEnd[index+1]
		}
	}
	result := make([]ExtractedLink, 0, 4)
	seen := make(map[string]struct{})
	for index := 0; index < len(scan) && len(result) < maxLinksPerMessage; {
		prefix := linkPrefix(scan, index)
		if prefix == "" || !linkBoundary(scan, index) {
			index++
			continue
		}
		stop := int(tokenEnd[index])
		hostEnd, ok := hostRun(scan, index+len(prefix), stop)
		if !ok {
			// Only the host was read; the next candidate cannot start
			// inside it (a host character is never a link boundary).
			index = hostEnd
			continue
		}
		end := trimLinkEnd(scan, index, stop, markdown)
		if end <= index+len(prefix) || end-index > maxLinkLength {
			index = stop
			continue
		}
		raw := string(text[index:end])
		address := raw
		if prefix == "www." {
			address = "https://" + raw
		}
		domain, ok := linkDomain(address)
		if !ok || len(address) > maxLinkLength {
			index = stop
			continue
		}
		address = domain.address(address)
		start := index
		index = end
		if _, duplicate := seen[address]; duplicate {
			continue
		}
		seen[address] = struct{}{}
		link := ExtractedLink{URL: address, Domain: domain.display, Offset: start}
		if markdown {
			link.Label = markdownLabel(scan, text, start, end, raw)
		}
		result = append(result, link)
	}
	return result
}

// maxHostLength bounds the host read by hostRun: a DNS name is at most 253
// characters, an IPv4 address with a port far less.
const maxHostLength = 255

// hostRun reads the host of a candidate from `from` (after the scheme or
// «www.») and says whether it may be a link: a non-empty run of letters,
// digits, dots and hyphens ending at the token end, a path, query, fragment,
// port or a character trimLinkEnd would drop. It returns where the run ends.
func hostRun(text []rune, from, stop int) (int, bool) {
	end := from
	for end < stop && end-from <= maxHostLength {
		value := text[end]
		if !unicode.IsLetter(value) && !unicode.IsDigit(value) && value != '-' && value != '.' {
			break
		}
		end++
	}
	if end == from || end-from > maxHostLength {
		return max(end, from+1), false
	}
	if end == stop || strings.ContainsRune("/?#:", text[end]) || trailingRune(text[end]) {
		return end, true
	}
	return end, false
}

func trailingRune(value rune) bool {
	return strings.ContainsRune(".,;:!?…'’*~_)]}", value)
}

// linkPrefix returns the scheme or www. starting at index, if any.
func linkPrefix(text []rune, index int) string {
	for _, prefix := range []string{"https://", "http://", "www."} {
		if hasFoldPrefix(text, index, prefix) {
			return prefix
		}
	}
	return ""
}

func hasFoldPrefix(text []rune, index int, prefix string) bool {
	if index+len(prefix) > len(text) {
		return false
	}
	for offset, want := range []rune(prefix) {
		if unicode.ToLower(text[index+offset]) != want {
			return false
		}
	}
	return true
}

// linkBoundary: a link does not start inside a word, an e-mail address or
// another link («xhttp://», «me@www.x», «//www.x»).
func linkBoundary(text []rune, index int) bool {
	if index == 0 {
		return true
	}
	previous := text[index-1]
	return !(unicode.IsLetter(previous) || unicode.IsDigit(previous) || strings.ContainsRune("_@./-%+=&#~", previous))
}

// linkStop ends a link: spaces, control and format characters (direction
// marks such as U+202E, zero-width spaces, soft hyphens: invisible, they
// would hide what the link really is) and delimiters.
func linkStop(value rune) bool {
	return unicode.IsSpace(value) || unicode.IsControl(value) || unicode.Is(unicode.Cf, value) ||
		strings.ContainsRune("<>\"`«»“”„", value)
}

// trimLinkEnd drops trailing punctuation and unmatched closing brackets:
// «(see https://x.ru/a_(b)).» keeps «https://x.ru/a_(b)». Brackets are
// counted once and the counts follow the trimming, so the cost is linear.
func trimLinkEnd(text []rune, start, end int, markdown bool) int {
	pairs := map[rune]rune{')': '(', ']': '[', '}': '{'}
	count := map[rune]int{}
	for _, value := range text[start:end] {
		switch value {
		case '(', ')', '[', ']', '{', '}':
			count[value]++
		}
	}
	for end > start {
		last := text[end-1]
		if strings.ContainsRune(".,;:!?…'’*~", last) || (markdown && last == '_') {
			end--
			continue
		}
		if open, closing := pairs[last]; closing && count[last] > count[open] {
			count[last]--
			end--
			continue
		}
		break
	}
	return end
}

// markdownLabel returns «label» of «[label](url)» when the link at start..end
// is the target of such a link on one line.
func markdownLabel(scan, text []rune, start, end int, raw string) *string {
	if start < 2 || scan[start-1] != '(' || scan[start-2] != ']' || end >= len(scan) || scan[end] != ')' {
		return nil
	}
	close := start - 2
	depth := 0
	// A label longer than this is cut anyway; looking further back would
	// make many links on one long line quadratic.
	for open := close - 1; open >= 0 && close-open <= 4*maxLinkLabel; open-- {
		switch scan[open] {
		case '\n':
			return nil
		case ']':
			depth++
		case '[':
			if depth > 0 {
				depth--
				continue
			}
			label := strings.Join(strings.Fields(string(text[open+1:close])), " ")
			if label == "" || label == raw {
				return nil
			}
			if runes := []rune(label); len(runes) > maxLinkLabel {
				label = string(runes[:maxLinkLabel-1]) + "…"
			}
			return &label
		}
	}
	return nil
}

// maskMarkdownCode blanks code spans and fenced blocks, keeping offsets.
func maskMarkdownCode(text []rune) []rune {
	scan := make([]rune, len(text))
	copy(scan, text)
	blank := func(from, to int) {
		for index := from; index < to; index++ {
			if scan[index] != '\n' {
				scan[index] = ' '
			}
		}
	}
	lineStart := 0
	fenced := -1
	for lineStart <= len(text) {
		lineEnd := lineStart
		for lineEnd < len(text) && text[lineEnd] != '\n' {
			lineEnd++
		}
		line := strings.TrimSpace(string(text[lineStart:lineEnd]))
		switch {
		case strings.HasPrefix(line, "```") && fenced < 0:
			fenced = lineStart
		case strings.HasPrefix(line, "```"):
			blank(fenced, lineEnd)
			fenced = -1
		case fenced < 0:
			// Inline code: `…` within the line.
			open := -1
			for index := lineStart; index < lineEnd; index++ {
				if text[index] != '`' {
					continue
				}
				if open < 0 {
					open = index
				} else {
					blank(open, index+1)
					open = -1
				}
			}
		}
		lineStart = lineEnd + 1
	}
	if fenced >= 0 {
		blank(fenced, len(text))
	}
	return scan
}

// linkHost is the host of a link: how to show it, and the host to put in
// the URL when the one written there could pass for another (see address).
type linkHost struct {
	display string
	// written and ascii: the host as written in the URL and its ASCII form,
	// set only when the written host is Unicode and must not be shown so.
	written, ascii string
}

// address returns the URL with a deceptive Unicode host replaced by its
// punycode form, as browsers show it.
func (host linkHost) address(address string) string {
	if host.written == "" {
		return address
	}
	return strings.Replace(address, host.written, host.ascii, 1)
}

// linkDomain checks that address is an http(s) URL with a real host name and
// returns the host for display: lower case, without «www.». A domain whose
// letters are all of one script is shown in Unicode, punycode labels decoded
// (xn--e1afmkfd.xn--p1ai → пример.рф); a domain mixing scripts is shown in
// punycode, as browsers do, so «аррӏе.com» in Cyrillic never reads as
// apple.com.
func linkDomain(address string) (linkHost, bool) {
	parsed, err := url.Parse(address)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Opaque != "" {
		return linkHost{}, false
	}
	written := strings.TrimSuffix(parsed.Hostname(), ".")
	host := strings.ToLower(written)
	if host == "" {
		return linkHost{}, false
	}
	if ip := net.ParseIP(host); ip != nil {
		return linkHost{display: host}, true
	}
	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return linkHost{}, false
	}
	unicodeLabels := make([]string, len(labels))
	asciiLabels := make([]string, len(labels))
	for index, label := range labels {
		if label == "" || utf8.RuneCountInString(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return linkHost{}, false
		}
		for _, value := range label {
			if !unicode.IsLetter(value) && !unicode.IsDigit(value) && value != '-' {
				return linkHost{}, false
			}
		}
		unicodeLabels[index], asciiLabels[index] = label, label
		if strings.HasPrefix(label, "xn--") {
			decoded, ok := decodePunycode(label[4:])
			if !ok {
				return linkHost{}, false
			}
			unicodeLabels[index] = decoded
		} else if !isASCII(label) {
			encoded, ok := encodePunycode(label)
			if !ok {
				return linkHost{}, false
			}
			asciiLabels[index] = "xn--" + encoded
		}
	}
	tld := []rune(unicodeLabels[len(unicodeLabels)-1])
	if len(tld) < 2 {
		return linkHost{}, false
	}
	for _, value := range tld {
		if !unicode.IsLetter(value) {
			return linkHost{}, false
		}
	}
	result := linkHost{}
	shown := unicodeLabels
	checked := unicodeLabels
	if checked[0] == "www" {
		// «www.» is not shown, so it does not make пример.рф mixed.
		checked = checked[1:]
	}
	if !singleScript(strings.Join(checked, "")) {
		shown = asciiLabels
		if !isASCII(written) {
			result.written, result.ascii = written, strings.Join(asciiLabels, ".")
		}
	}
	result.display = strings.TrimPrefix(strings.Join(shown, "."), "www.")
	if len(result.display) > 255 || !strings.Contains(result.display, ".") {
		return linkHost{}, false
	}
	return result, true
}

func isASCII(value string) bool {
	for index := 0; index < len(value); index++ {
		if value[index] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

// singleScript says whether every letter belongs to one script. Digits and
// hyphens belong to none; ASCII letters are Latin; Han, Hiragana and
// Katakana together are one (Japanese writes them side by side).
func singleScript(value string) bool {
	seen := ""
	for _, letter := range value {
		if !unicode.IsLetter(letter) {
			continue
		}
		script := scriptOf(letter)
		if seen == "" {
			seen = script
		} else if script != seen {
			return false
		}
	}
	return true
}

var knownScripts = []struct {
	name  string
	table *unicode.RangeTable
}{
	{"Latin", unicode.Latin}, {"Cyrillic", unicode.Cyrillic}, {"Greek", unicode.Greek},
	{"CJK", unicode.Han}, {"CJK", unicode.Hiragana}, {"CJK", unicode.Katakana},
	{"Hangul", unicode.Hangul}, {"Arabic", unicode.Arabic}, {"Hebrew", unicode.Hebrew},
	{"Armenian", unicode.Armenian}, {"Georgian", unicode.Georgian}, {"Thai", unicode.Thai},
	{"Devanagari", unicode.Devanagari},
}

func scriptOf(letter rune) string {
	if letter < utf8.RuneSelf {
		return "Latin"
	}
	for _, script := range knownScripts {
		if unicode.Is(script.table, letter) {
			return script.name
		}
	}
	for name, table := range unicode.Scripts {
		if unicode.Is(table, letter) {
			return name
		}
	}
	return "Unknown"
}

// encodePunycode encodes one lower-case label (RFC 3492), without «xn--».
func encodePunycode(input string) (string, bool) {
	const (
		base, tMin, tMax, skew, damp = 36, 1, 26, 38, 700
		initialBias, initialN        = 72, 128
	)
	runes := []rune(input)
	var output []byte
	for _, value := range runes {
		if value < 0x80 {
			output = append(output, byte(value))
		}
	}
	basic := len(output)
	handled := basic
	if basic > 0 {
		output = append(output, '-')
	}
	digit := func(value int) byte {
		if value < 26 {
			return byte('a' + value)
		}
		return byte('0' + value - 26)
	}
	adapt := func(delta, points int, first bool) int {
		if first {
			delta /= damp
		} else {
			delta /= 2
		}
		delta += delta / points
		k := 0
		for delta > ((base-tMin)*tMax)/2 {
			delta /= base - tMin
			k += base
		}
		return k + (base-tMin+1)*delta/(delta+skew)
	}
	n, delta, bias := initialN, 0, initialBias
	for handled < len(runes) {
		next := int(unicode.MaxRune) + 1
		for _, value := range runes {
			if int(value) >= n && int(value) < next {
				next = int(value)
			}
		}
		delta += (next - n) * (handled + 1)
		if delta > 1<<30 {
			return "", false
		}
		n = next
		for _, value := range runes {
			if int(value) < n {
				delta++
			}
			if int(value) != n {
				continue
			}
			q := delta
			for k := base; ; k += base {
				t := k - bias
				if t < tMin {
					t = tMin
				} else if t > tMax {
					t = tMax
				}
				if q < t {
					break
				}
				output = append(output, digit(t+(q-t)%(base-t)))
				q = (q - t) / (base - t)
			}
			output = append(output, digit(q))
			bias = adapt(delta, handled+1, handled == basic)
			delta = 0
			handled++
		}
		delta++
		n++
	}
	return string(output), true
}

// decodePunycode decodes one label without its «xn--» prefix (RFC 3492).
func decodePunycode(input string) (string, bool) {
	const (
		base, tMin, tMax, skew, damp = 36, 1, 26, 38, 700
		initialBias, initialN        = 72, 128
	)
	output := []rune{}
	basic := strings.LastIndexByte(input, '-')
	if basic > 0 {
		for _, value := range input[:basic] {
			if value >= 0x80 {
				return "", false
			}
			output = append(output, value)
		}
		input = input[basic+1:]
	} else if basic == 0 {
		input = input[1:]
	}
	n, bias, i := initialN, initialBias, 0
	adapt := func(delta, points int, first bool) int {
		if first {
			delta /= damp
		} else {
			delta /= 2
		}
		delta += delta / points
		k := 0
		for delta > ((base-tMin)*tMax)/2 {
			delta /= base - tMin
			k += base
		}
		return k + (base-tMin+1)*delta/(delta+skew)
	}
	for position := 0; position < len(input); {
		oldI, w := i, 1
		for k := base; ; k += base {
			if position >= len(input) {
				return "", false
			}
			value := input[position]
			position++
			var digit int
			switch {
			case value >= '0' && value <= '9':
				digit = int(value-'0') + 26
			case value >= 'a' && value <= 'z':
				digit = int(value - 'a')
			case value >= 'A' && value <= 'Z':
				digit = int(value - 'A')
			default:
				return "", false
			}
			i += digit * w
			if i > 1<<30 {
				return "", false
			}
			t := k - bias
			if t < tMin {
				t = tMin
			} else if t > tMax {
				t = tMax
			}
			if digit < t {
				break
			}
			w *= base - t
		}
		bias = adapt(i-oldI, len(output)+1, oldI == 0)
		n += i / (len(output) + 1)
		i %= len(output) + 1
		if n > unicode.MaxRune || len(output) > 63 {
			return "", false
		}
		output = append(output[:i], append([]rune{rune(n)}, output[i:]...)...)
		i++
	}
	if len(output) == 0 {
		return "", false
	}
	return string(output), true
}
