package files

import (
	"archive/zip"
	"bytes"
	"errors"
	"testing"
)

func zipArchive(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, content := range entries {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestExtractXLSXUsesSheetsAsSectionsAndHeadersAsLabels(t *testing.T) {
	data := zipArchive(t, map[string]string{
		"xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
			<sheets><sheet name="Слоты" sheetId="1" r:id="rId1"/><sheet name="Пусто" sheetId="2" r:id="rId2"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
		"xl/sharedStrings.xml":       `<sst><si><t>Инструктор</t></si><si><t>Время</t></si><si><r><t>Ива</t></r><r><t>нова</t></r></si></sst>`,
		"xl/worksheets/sheet1.xml": `<worksheet><sheetData>
			<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
			<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>9.5</v></c></row>
			<row r="3"><c r="B3" t="inlineStr"><is><t>11:00</t></is></c></row>
		</sheetData></worksheet>`,
		"xl/worksheets/sheet2.xml": `<worksheet><sheetData/></worksheet>`,
	})
	document, err := ExtractDocument("slots.xlsx", "application/octet-stream", data)
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Sections) != 1 || document.Sections[0].Heading != "Слоты" {
		t.Fatalf("sections = %+v", document.Sections)
	}
	got := document.Sections[0].Paragraphs
	if len(got) != 2 || got[0] != "Инструктор: Иванова; 9.5" || got[1] != "Время: 11:00" {
		t.Fatalf("rows = %#v", got)
	}
	if text := document.Text(); text != "Слоты Инструктор: Иванова; 9.5 Время: 11:00" {
		t.Fatalf("flat text = %q", text)
	}
}

func TestExtractCSVDetectsSemicolonsAndBOM(t *testing.T) {
	document, err := ExtractDocument("slots.csv", "text/csv", []byte("\xef\xbb\xbfИмя;Слот\nИванова;\"09:00; утро\"\n;\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got := document.Sections[0].Paragraphs; len(got) != 1 || got[0] != "Имя: Иванова; Слот: 09:00; утро" {
		t.Fatalf("rows = %#v", got)
	}
	if _, err := ExtractDocument("bad.csv", "text/csv", []byte{0xff, 0xfe}); !errors.Is(err, ErrUnsupportedDocument) {
		t.Fatalf("invalid CSV err = %v", err)
	}
}

func TestExtractDOCXSplitsOnHeadings(t *testing.T) {
	data := zipArchive(t, map[string]string{"word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
		<w:p><w:r><w:t>Вступление.</w:t></w:r></w:p>
		<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Отпуска</w:t></w:r></w:p>
		<w:p><w:r><w:t>Заявление подаётся</w:t></w:r><w:r><w:t xml:space="preserve"> заранее.</w:t></w:r></w:p>
		<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>Смены</w:t></w:r></w:p>
	</w:body></w:document>`})
	document, err := ExtractDocument("rules.docx", "", data)
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Sections) != 3 || document.Sections[0].Heading != "" || document.Sections[1].Heading != "Отпуска" ||
		document.Sections[1].Paragraphs[0] != "Заявление подаётся заранее." || document.Sections[2].Heading != "Смены" {
		t.Fatalf("sections = %+v", document.Sections)
	}
}

func TestParseMarkdownKeepsHeadingPathAndCodeFences(t *testing.T) {
	document := ParseMarkdown("Intro\n\n# A\n\ntext\n\n## B\n\n```\n# not a heading\n```\n\n# C\n### D\nbody")
	headings := make([]string, len(document.Sections))
	for index, section := range document.Sections {
		headings[index] = section.Heading
	}
	want := []string{"", "A", "A › B", "C", "C › D"}
	if len(headings) != len(want) {
		t.Fatalf("headings = %#v", headings)
	}
	for index := range want {
		if headings[index] != want[index] {
			t.Fatalf("headings = %#v, want %#v", headings, want)
		}
	}
	if document.Sections[2].Paragraphs[0] != "```\n# not a heading\n```" {
		t.Fatalf("fenced block = %#v", document.Sections[2].Paragraphs)
	}
}

func TestDocumentKindRecognisesSpreadsheets(t *testing.T) {
	if kind := DocumentKind("table.xlsx", "application/zip"); kind != "xlsx" {
		t.Fatalf("kind = %q", kind)
	}
	if kind := DocumentKind("image.png", "image/png"); kind != "" {
		t.Fatalf("image kind = %q", kind)
	}
}
