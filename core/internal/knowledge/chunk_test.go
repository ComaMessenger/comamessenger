package knowledge

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/comamessenger/comamessenger/core/internal/files"
)

func TestSplitDocumentRespectsSectionsAndLimits(t *testing.T) {
	sentence := "Инструктор отмечается в чате до начала слота. "
	long := strings.Repeat(sentence, 120)
	document := files.ExtractedDocument{Sections: []files.DocumentSection{
		{Heading: "Введение", Paragraphs: []string{"Коротко.", "Ещё абзац."}},
		{Heading: "Порядок", Paragraphs: []string{long}},
		{Heading: "Пустой раздел"},
	}}
	chunks := SplitDocument(document)
	if len(chunks) < 4 {
		t.Fatalf("chunks = %d", len(chunks))
	}
	if chunks[0].Section != "Введение" || chunks[0].Content != "Коротко.\n\nЕщё абзац." || chunks[0].Position != 0 {
		t.Fatalf("first chunk = %+v", chunks[0])
	}
	for index, chunk := range chunks {
		if chunk.Position != index {
			t.Fatalf("chunk %d has position %d", index, chunk.Position)
		}
		if length := utf8.RuneCountInString(chunk.Content); length < 1 || length > chunkLimit {
			t.Fatalf("chunk %d length %d", index, length)
		}
		if chunk.Section == "Порядок" && !strings.HasSuffix(chunk.Content, ".") {
			t.Fatalf("long paragraph was not cut on a sentence boundary: %q", chunk.Content[len(chunk.Content)-20:])
		}
	}
	last := chunks[len(chunks)-1]
	if last.Section != "Пустой раздел" || last.Content != "Пустой раздел" {
		t.Fatalf("heading-only section = %+v", last)
	}
	if SplitDocument(files.ExtractedDocument{}) == nil {
		t.Fatal("empty document must yield an empty slice")
	}
}
