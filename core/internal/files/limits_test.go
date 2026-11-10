package files

import (
	"bytes"
	"compress/zlib"
	"fmt"
	"runtime"
	"strings"
	"testing"
)

// allocatedDuring reports the bytes allocated while run executes.
func allocatedDuring(run func()) uint64 {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	run()
	runtime.ReadMemStats(&after)
	return after.TotalAlloc - before.TotalAlloc
}

func workbook(sheetCount int, sharedString string, columns, rows int) map[string]string {
	var relations, sheets strings.Builder
	for index := 1; index <= sheetCount; index++ {
		// Every name points at the same worksheet part.
		fmt.Fprintf(&relations, `<Relationship Id="r%d" Target="worksheets/sheet1.xml"/>`, index)
		fmt.Fprintf(&sheets, `<sheet name="S%d" r:id="r%d"/>`, index, index)
	}
	var sheet strings.Builder
	sheet.WriteString(`<worksheet><sheetData>`)
	for row := 0; row < rows; row++ {
		sheet.WriteString(`<row>`)
		for column := 0; column < columns; column++ {
			sheet.WriteString(`<c t="s"><v>0</v></c>`)
		}
		sheet.WriteString(`</row>`)
	}
	sheet.WriteString(`</sheetData></worksheet>`)
	return map[string]string{
		"xl/workbook.xml":            `<workbook xmlns:r="r"><sheets>` + sheets.String() + `</sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships>` + relations.String() + `</Relationships>`,
		"xl/sharedStrings.xml":       `<sst><si><t>` + sharedString + `</t></si></sst>`,
		"xl/worksheets/sheet1.xml":   sheet.String(),
	}
}

// A few kilobytes of XLSX used to expand into gigabytes: every cell referenced
// one long shared string, and the header was repeated in front of every cell.
func TestXLSXSharedStringAmplificationIsBounded(t *testing.T) {
	data := zipArchive(t, workbook(1, strings.Repeat("A", 10_000), 200, 500))
	if len(data) > 64<<10 {
		t.Fatalf("fixture should stay small, got %d bytes", len(data))
	}
	var text string
	allocated := allocatedDuring(func() {
		document, err := ExtractDocument("bomb.xlsx", "", data)
		if err != nil {
			t.Fatal(err)
		}
		text = document.Text()
	})
	if allocated > 256<<20 {
		t.Fatalf("extraction allocated %d MiB", allocated>>20)
	}
	if len(text) > 2*maxTableTextBytes {
		t.Fatalf("extracted text is %d bytes", len(text))
	}
	sheets, err := ExtractSheets("bomb.xlsx", "", data)
	if err != nil {
		t.Fatal(err)
	}
	cells := 0
	for _, sheet := range sheets {
		for _, row := range sheet.Rows {
			for _, cell := range row {
				cells += len(cell)
			}
		}
		if !sheet.Truncated {
			t.Fatal("a workbook cut by the cell budget must be marked truncated")
		}
	}
	if cells > maxWorkbookCellBytes+maxSheetCellBytes*maxSheetColumns {
		t.Fatalf("rows keep %d cell bytes", cells)
	}
}

func TestXLSXSheetListedManyTimesIsReadOnce(t *testing.T) {
	data := zipArchive(t, workbook(40, "value", 3, 2))
	sheets, err := ExtractSheets("aliases.xlsx", "", data)
	if err != nil {
		t.Fatal(err)
	}
	if len(sheets) != 1 {
		t.Fatalf("one worksheet part was read %d times", len(sheets))
	}
}

func TestTableRowsBoundHeaderAndCellLength(t *testing.T) {
	long := strings.Repeat("я", 5_000)
	rows := tableRows([][]string{{long}, {long}})
	if len(rows) != 1 {
		t.Fatalf("rows = %d", len(rows))
	}
	if len(rows[0]) > maxTableHeaderBytes+maxSheetCellBytes+2 {
		t.Fatalf("row is %d bytes", len(rows[0]))
	}
	if !strings.HasSuffix(rows[0], "я") || strings.ContainsRune(rows[0], '�') {
		t.Fatal("truncation split a rune")
	}
}

// Thousands of highly compressible streams used to be inflated and kept in
// memory together before any text was read.
func TestPDFStreamsShareOneInflateBudget(t *testing.T) {
	var stream bytes.Buffer
	writer := zlib.NewWriter(&stream)
	if _, err := writer.Write(bytes.Repeat([]byte(" "), 19<<20)); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	var pdf bytes.Buffer
	pdf.WriteString("%PDF-1.4\n(visible text) Tj\n")
	for index := 0; index < 60; index++ {
		pdf.WriteString("<< /Filter /FlateDecode >>\nstream\n")
		pdf.Write(stream.Bytes())
		pdf.WriteString("\nendstream\n")
	}
	if pdf.Len() > 4<<20 {
		t.Fatalf("fixture should stay small, got %d bytes", pdf.Len())
	}
	var text string
	allocated := allocatedDuring(func() { text = extractPDFText(pdf.Bytes()) })
	if !strings.Contains(text, "visible text") {
		t.Fatalf("text = %q", text)
	}
	// 60 streams would inflate to more than 1 GiB without the shared budget.
	if allocated > 400<<20 {
		t.Fatalf("extraction allocated %d MiB", allocated>>20)
	}
}
