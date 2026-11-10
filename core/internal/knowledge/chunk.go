package knowledge

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/comamessenger/comamessenger/core/internal/files"
)

const (
	// chunkTarget is the size at which a fragment is closed at the next
	// paragraph boundary; chunkLimit is the hard cap for a single fragment.
	chunkTarget     = 1200
	chunkLimit      = 2000
	maxSectionRunes = 500
	maxChunks       = 5000
)

// Chunk is one searchable fragment of a document.
type Chunk struct {
	Position int
	Section  string
	Content  string
}

// SplitDocument cuts a document into fragments that never cross a section
// boundary. Paragraphs are packed up to chunkTarget runes; a paragraph longer
// than chunkLimit is split on sentence and then word boundaries.
func SplitDocument(document files.ExtractedDocument) []Chunk {
	result := make([]Chunk, 0, 16)
	for _, section := range document.Sections {
		heading := truncateRunes(strings.Join(strings.Fields(section.Heading), " "), maxSectionRunes)
		var builder strings.Builder
		length := 0
		flush := func() {
			if text := strings.TrimSpace(builder.String()); text != "" && len(result) < maxChunks {
				result = append(result, Chunk{Position: len(result), Section: heading, Content: text})
			}
			builder.Reset()
			length = 0
		}
		for _, paragraph := range section.Paragraphs {
			for _, piece := range splitLong(normalizeParagraph(paragraph)) {
				pieceLength := utf8.RuneCountInString(piece)
				if pieceLength == 0 {
					continue
				}
				if length > 0 && length+2+pieceLength > chunkLimit {
					flush()
				}
				if length > 0 {
					builder.WriteString("\n\n")
					length += 2
				}
				builder.WriteString(piece)
				length += pieceLength
				if length >= chunkTarget {
					flush()
				}
			}
		}
		flush()
		// A heading without body text is still worth finding.
		if heading != "" && len(section.Paragraphs) == 0 && len(result) < maxChunks {
			result = append(result, Chunk{Position: len(result), Section: heading, Content: heading})
		}
	}
	return result
}

func normalizeParagraph(value string) string {
	lines := strings.Split(strings.ReplaceAll(value, "\x00", ""), "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if line = strings.Join(strings.Fields(line), " "); line != "" {
			kept = append(kept, line)
		}
	}
	return strings.Join(kept, "\n")
}

func splitLong(paragraph string) []string {
	if utf8.RuneCountInString(paragraph) <= chunkLimit {
		return []string{paragraph}
	}
	result := make([]string, 0, 4)
	runes := []rune(paragraph)
	for len(runes) > chunkLimit {
		cut := lastBoundary(runes[:chunkLimit], func(previous, current rune) bool {
			return (previous == '.' || previous == '!' || previous == '?' || previous == ';' || previous == '\n') && unicode.IsSpace(current)
		})
		if cut < chunkLimit/2 {
			cut = lastBoundary(runes[:chunkLimit], func(_, current rune) bool { return unicode.IsSpace(current) })
		}
		if cut < chunkLimit/2 {
			cut = chunkLimit
		}
		result = append(result, strings.TrimSpace(string(runes[:cut])))
		runes = []rune(strings.TrimSpace(string(runes[cut:])))
	}
	if len(runes) > 0 {
		result = append(result, string(runes))
	}
	return result
}

func lastBoundary(runes []rune, boundary func(previous, current rune) bool) int {
	for index := len(runes) - 1; index > 0; index-- {
		if boundary(runes[index-1], runes[index]) {
			return index
		}
	}
	return 0
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}
