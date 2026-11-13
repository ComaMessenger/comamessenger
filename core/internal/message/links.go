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
	result := make([]ExtractedLink, 0, 4)
	seen := make(map[string]struct{})
	for index := 0; index < len(scan) && len(result) < maxLinksPerMessage; {
		prefix := linkPrefix(scan, index)
		if prefix == "" || !linkBoundary(scan, index) {
			index++
			continue
		}
		end := index
		for end < len(scan) && !linkStop(scan[end]) && !(scan[end] == ']' && end+1 < len(scan) && scan[end+1] == '(') {
			end++
		}
		end = trimLinkEnd(scan, index, end, markdown)
		skip := index + len(prefix)
		if end <= skip {
			index = skip
			continue
		}
		raw := string(text[index:end])
		next := end
		address := raw
		if prefix == "www." {
			address = "https://" + raw
		}
		domain, ok := linkDomain(address)
		if !ok || len(address) > maxLinkLength {
			index = skip
			continue
		}
		if _, duplicate := seen[address]; duplicate {
			index = next
			continue
		}
		seen[address] = struct{}{}
		link := ExtractedLink{URL: address, Domain: domain, Offset: index}
		if markdown {
			link.Label = markdownLabel(scan, text, index, end, raw)
		}
		result = append(result, link)
		index = next
	}
	return result
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

func linkStop(value rune) bool {
	return unicode.IsSpace(value) || unicode.IsControl(value) || strings.ContainsRune("<>\"`«»“”„\u200b", value)
}

// trimLinkEnd drops trailing punctuation and unmatched closing brackets:
// «(see https://x.ru/a_(b)).» keeps «https://x.ru/a_(b)».
func trimLinkEnd(text []rune, start, end int, markdown bool) int {
	pairs := map[rune]rune{')': '(', ']': '[', '}': '{'}
	for end > start {
		last := text[end-1]
		if strings.ContainsRune(".,;:!?…'’*~", last) || (markdown && last == '_') {
			end--
			continue
		}
		if open, closing := pairs[last]; closing {
			opened, closed := 0, 0
			for _, value := range text[start:end] {
				switch value {
				case open:
					opened++
				case last:
					closed++
				}
			}
			if closed > opened {
				end--
				continue
			}
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
	for open := close - 1; open >= 0; open-- {
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

// linkDomain checks that address is an http(s) URL with a real host name and
// returns the host for display: lower case, without «www.», punycode labels
// turned back into Unicode (xn--e1afmkfd.xn--p1ai → пример.рф).
func linkDomain(address string) (string, bool) {
	parsed, err := url.Parse(address)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Opaque != "" {
		return "", false
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if host == "" {
		return "", false
	}
	if ip := net.ParseIP(host); ip != nil {
		return host, true
	}
	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return "", false
	}
	for index, label := range labels {
		if label == "" || utf8.RuneCountInString(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", false
		}
		for _, value := range label {
			if !unicode.IsLetter(value) && !unicode.IsDigit(value) && value != '-' {
				return "", false
			}
		}
		if strings.HasPrefix(label, "xn--") {
			decoded, ok := decodePunycode(label[4:])
			if !ok {
				return "", false
			}
			labels[index] = decoded
		}
	}
	tld := []rune(labels[len(labels)-1])
	if len(tld) < 2 {
		return "", false
	}
	for _, value := range tld {
		if !unicode.IsLetter(value) {
			return "", false
		}
	}
	domain := strings.TrimPrefix(strings.Join(labels, "."), "www.")
	if len(domain) > 255 || !strings.Contains(domain, ".") {
		return "", false
	}
	return domain, true
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
