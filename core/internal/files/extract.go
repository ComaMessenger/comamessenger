package files

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// ErrUnsupportedDocument marks content the structured extractor cannot read.
var ErrUnsupportedDocument = errors.New("unsupported document format")

const (
	maxSheetRows    = 50_000
	maxSheetColumns = 200
)

// DocumentSection is a heading with the paragraphs that follow it. Spreadsheet
// rows become paragraphs and sheets become sections.
type DocumentSection struct {
	Heading    string
	Paragraphs []string
}

// ExtractedDocument keeps the structure that flat file search text discards,
// so the knowledge base can cut fragments on section boundaries.
type ExtractedDocument struct {
	Sections []DocumentSection
}

// Text flattens the document into one whitespace-normalized string.
func (document ExtractedDocument) Text() string {
	var builder strings.Builder
	for _, section := range document.Sections {
		if section.Heading != "" {
			builder.WriteString(section.Heading)
			builder.WriteByte('\n')
		}
		for _, paragraph := range section.Paragraphs {
			builder.WriteString(paragraph)
			builder.WriteByte('\n')
		}
	}
	return normalizeExtractedText(builder.String())
}

// DocumentKind classifies a file for extraction by MIME type and extension.
func DocumentKind(name, mimeType string) string {
	extension := filepathExtension(name)
	mimeType = strings.ToLower(strings.TrimSpace(mimeType))
	switch {
	case extension == ".csv" || mimeType == "text/csv":
		return "csv"
	case extension == ".md" || extension == ".markdown" || mimeType == "text/markdown":
		return "markdown"
	case extension == ".xlsx" || mimeType == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
		return "xlsx"
	case extension == ".docx" || mimeType == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		return "docx"
	case extension == ".pdf" || mimeType == "application/pdf":
		return "pdf"
	case strings.HasPrefix(mimeType, "text/") || extension == ".txt":
		return "text"
	default:
		return ""
	}
}

// ExtractDocument reads text/*, Markdown, CSV, XLSX, DOCX and PDF content.
func ExtractDocument(name, mimeType string, data []byte) (ExtractedDocument, error) {
	switch DocumentKind(name, mimeType) {
	case "markdown":
		if !utf8.Valid(data) {
			return ExtractedDocument{}, fmt.Errorf("%w: Markdown is not UTF-8", ErrUnsupportedDocument)
		}
		return ParseMarkdown(string(data)), nil
	case "text":
		if !utf8.Valid(data) {
			return ExtractedDocument{}, fmt.Errorf("%w: text is not UTF-8", ErrUnsupportedDocument)
		}
		return ExtractedDocument{Sections: []DocumentSection{{Paragraphs: splitParagraphs(string(data))}}}, nil
	case "csv":
		return extractCSV(data)
	case "xlsx":
		return extractXLSX(data)
	case "docx":
		return extractDOCX(data)
	case "pdf":
		text := normalizeExtractedText(extractPDFText(data))
		if text == "" {
			return ExtractedDocument{}, nil
		}
		return ExtractedDocument{Sections: []DocumentSection{{Paragraphs: []string{text}}}}, nil
	default:
		return ExtractedDocument{}, ErrUnsupportedDocument
	}
}

// ParseMarkdown splits Markdown into sections on ATX headings. The section
// heading carries the path of enclosing headings, e.g. "Rules › Holidays".
func ParseMarkdown(value string) ExtractedDocument {
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\x00", "")
	var sections []DocumentSection
	var headings []string
	current := DocumentSection{}
	var paragraph []string
	inFence := false
	flushParagraph := func() {
		if text := strings.TrimSpace(strings.Join(paragraph, "\n")); text != "" {
			current.Paragraphs = append(current.Paragraphs, text)
		}
		paragraph = paragraph[:0]
	}
	flushSection := func() {
		flushParagraph()
		if current.Heading != "" || len(current.Paragraphs) > 0 {
			sections = append(sections, current)
		}
	}
	for _, line := range strings.Split(value, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = !inFence
			paragraph = append(paragraph, line)
			continue
		}
		if !inFence {
			if level, heading := markdownHeading(trimmed); level > 0 {
				flushSection()
				if level > len(headings)+1 {
					level = len(headings) + 1
				}
				headings = append(headings[:level-1], heading)
				current = DocumentSection{Heading: strings.Join(headings, " › ")}
				continue
			}
			if trimmed == "" {
				flushParagraph()
				continue
			}
		}
		paragraph = append(paragraph, line)
	}
	flushSection()
	return ExtractedDocument{Sections: sections}
}

func markdownHeading(line string) (int, string) {
	level := 0
	for level < len(line) && level < 7 && line[level] == '#' {
		level++
	}
	if level == 0 || level > 6 || level >= len(line) || line[level] != ' ' {
		return 0, ""
	}
	heading := strings.TrimSpace(strings.TrimRight(strings.TrimSpace(line[level:]), "#"))
	if heading == "" {
		return 0, ""
	}
	return level, heading
}

func splitParagraphs(value string) []string {
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\x00", "")
	parts := strings.Split(value, "\n\n")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			result = append(result, part)
		}
	}
	return result
}

// tableRows renders rows as "Header: value; Header: value" so every fragment
// stays readable without the header row it was cut from.
func tableRows(rows [][]string) []string {
	if len(rows) == 0 {
		return nil
	}
	header := rows[0]
	usableHeader := false
	for _, cell := range header {
		if strings.TrimSpace(cell) != "" {
			usableHeader = true
			break
		}
	}
	start := 1
	if !usableHeader || len(rows) == 1 {
		header, start = nil, 0
	}
	result := make([]string, 0, len(rows))
	for _, row := range rows[start:] {
		cells := make([]string, 0, len(row))
		for index, cell := range row {
			cell = strings.Join(strings.Fields(cell), " ")
			if cell == "" {
				continue
			}
			if index < len(header) && strings.TrimSpace(header[index]) != "" {
				cell = strings.Join(strings.Fields(header[index]), " ") + ": " + cell
			}
			cells = append(cells, cell)
		}
		if len(cells) > 0 {
			result = append(result, strings.Join(cells, "; "))
		}
	}
	return result
}

func extractCSV(data []byte) (ExtractedDocument, error) {
	rows, err := readCSVRows(data)
	if err != nil {
		return ExtractedDocument{}, err
	}
	return ExtractedDocument{Sections: []DocumentSection{{Paragraphs: tableRows(rows)}}}, nil
}

func readCSVRows(data []byte) ([][]string, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("%w: CSV is not UTF-8", ErrUnsupportedDocument)
	}
	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	reader.ReuseRecord = false
	if firstLine, _, _ := strings.Cut(string(data), "\n"); strings.Count(firstLine, ";") > strings.Count(firstLine, ",") {
		reader.Comma = ';'
	}
	rows := make([][]string, 0, 64)
	for len(rows) < maxSheetRows {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrUnsupportedDocument, err)
		}
		if len(record) > maxSheetColumns {
			record = record[:maxSheetColumns]
		}
		rows = append(rows, record)
	}
	return rows, nil
}

type officeArchive struct {
	files map[string]*zip.File
}

func openOfficeArchive(data []byte, kind string) (officeArchive, error) {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(archive.File) > maxArchiveEntries {
		return officeArchive{}, fmt.Errorf("%w: invalid or oversized %s archive", ErrUnsupportedDocument, kind)
	}
	var unpacked uint64
	files := make(map[string]*zip.File, len(archive.File))
	for _, file := range archive.File {
		unpacked += file.UncompressedSize64
		if unpacked > maxArchiveUnpacked {
			return officeArchive{}, fmt.Errorf("%w: %s unpacked size limit exceeded", ErrUnsupportedDocument, kind)
		}
		files[file.Name] = file
	}
	return officeArchive{files: files}, nil
}

func (archive officeArchive) decoder(name string) (*xml.Decoder, io.Closer, error) {
	file, ok := archive.files[name]
	if !ok {
		return nil, nil, fmt.Errorf("%w: %s is missing", ErrUnsupportedDocument, name)
	}
	reader, err := file.Open()
	if err != nil {
		return nil, nil, err
	}
	return xml.NewDecoder(io.LimitReader(reader, maxArchiveUnpacked+1)), reader, nil
}

func extractDOCX(data []byte) (ExtractedDocument, error) {
	archive, err := openOfficeArchive(data, "DOCX")
	if err != nil {
		return ExtractedDocument{}, err
	}
	decoder, closer, err := archive.decoder("word/document.xml")
	if err != nil {
		return ExtractedDocument{}, err
	}
	defer closer.Close()
	var sections []DocumentSection
	current := DocumentSection{}
	var paragraph strings.Builder
	headingLevel := 0
	inParagraph := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return ExtractedDocument{}, fmt.Errorf("%w: %v", ErrUnsupportedDocument, err)
		}
		switch element := token.(type) {
		case xml.StartElement:
			switch element.Name.Local {
			case "p":
				inParagraph, headingLevel = true, 0
				paragraph.Reset()
			case "pStyle":
				headingLevel = max(headingLevel, docxHeadingLevel(xmlAttribute(element, "val")))
			case "outlineLvl":
				if level, err := strconv.Atoi(xmlAttribute(element, "val")); err == nil && level >= 0 && level < 9 {
					headingLevel = max(headingLevel, level+1)
				}
			case "t":
				var text string
				if err := decoder.DecodeElement(&text, &element); err != nil {
					return ExtractedDocument{}, fmt.Errorf("%w: %v", ErrUnsupportedDocument, err)
				}
				paragraph.WriteString(text)
			case "tab":
				paragraph.WriteByte('\t')
			case "br", "cr":
				paragraph.WriteByte('\n')
			}
		case xml.EndElement:
			if element.Name.Local != "p" || !inParagraph {
				continue
			}
			inParagraph = false
			text := strings.TrimSpace(paragraph.String())
			if text == "" {
				continue
			}
			if headingLevel > 0 {
				if current.Heading != "" || len(current.Paragraphs) > 0 {
					sections = append(sections, current)
				}
				current = DocumentSection{Heading: strings.Join(strings.Fields(text), " ")}
				continue
			}
			current.Paragraphs = append(current.Paragraphs, text)
		}
	}
	if current.Heading != "" || len(current.Paragraphs) > 0 {
		sections = append(sections, current)
	}
	return ExtractedDocument{Sections: sections}, nil
}

func docxHeadingLevel(style string) int {
	style = strings.ToLower(strings.ReplaceAll(style, " ", ""))
	if style == "title" {
		return 1
	}
	for _, prefix := range []string{"heading", "заголовок"} {
		if rest, ok := strings.CutPrefix(style, prefix); ok {
			if level, err := strconv.Atoi(rest); err == nil && level > 0 && level < 10 {
				return level
			}
		}
	}
	return 0
}

func xmlAttribute(element xml.StartElement, local string) string {
	for _, attribute := range element.Attr {
		if attribute.Name.Local == local {
			return attribute.Value
		}
	}
	return ""
}

func extractXLSX(data []byte) (ExtractedDocument, error) {
	sheets, err := readXLSXSheets(data)
	if err != nil {
		return ExtractedDocument{}, err
	}
	result := ExtractedDocument{}
	for _, sheet := range sheets {
		if paragraphs := tableRows(sheet.Rows); len(paragraphs) > 0 {
			result.Sections = append(result.Sections, DocumentSection{Heading: sheet.Sheet, Paragraphs: paragraphs})
		}
	}
	return result, nil
}

// SheetRows is one worksheet (or a whole CSV file) as raw cell rows.
type SheetRows struct {
	Sheet string
	Rows  [][]string
	// Truncated is set when the row limit cut the sheet.
	Truncated bool
}

// ExtractSheets returns spreadsheet rows for CSV and XLSX files. Date and time
// cells of XLSX workbooks are rendered as ISO 8601 text.
func ExtractSheets(name, mimeType string, data []byte) ([]SheetRows, error) {
	switch DocumentKind(name, mimeType) {
	case "csv":
		rows, err := readCSVRows(data)
		if err != nil {
			return nil, err
		}
		return []SheetRows{{Rows: rows, Truncated: len(rows) >= maxSheetRows}}, nil
	case "xlsx":
		return readXLSXSheets(data)
	default:
		return nil, ErrUnsupportedDocument
	}
}

func readXLSXSheets(data []byte) ([]SheetRows, error) {
	archive, err := openOfficeArchive(data, "XLSX")
	if err != nil {
		return nil, err
	}
	shared, err := xlsxSharedStrings(archive)
	if err != nil {
		return nil, err
	}
	sheets, err := xlsxSheets(archive)
	if err != nil {
		return nil, err
	}
	styles := xlsxDateStyles(archive)
	styles.date1904 = xlsxDate1904(archive)
	result := make([]SheetRows, 0, len(sheets))
	for _, sheet := range sheets {
		rows, err := xlsxRows(archive, sheet.path, shared, styles)
		if err != nil {
			return nil, err
		}
		result = append(result, SheetRows{Sheet: sheet.name, Rows: rows, Truncated: len(rows) >= maxSheetRows})
	}
	return result, nil
}

// xlsxStyles marks cell style indexes whose number format is a date or time.
type xlsxStyles struct {
	dates    map[int]bool
	date1904 bool
}

func xlsxDateStyles(archive officeArchive) xlsxStyles {
	result := xlsxStyles{dates: map[int]bool{}}
	decoder, closer, err := archive.decoder("xl/styles.xml")
	if err != nil {
		return result
	}
	defer closer.Close()
	custom := map[int]bool{}
	inCellXfs := false
	index := 0
	for {
		token, err := decoder.Token()
		if err != nil {
			return result
		}
		switch element := token.(type) {
		case xml.StartElement:
			switch element.Name.Local {
			case "numFmt":
				formatID, err := strconv.Atoi(xmlAttribute(element, "numFmtId"))
				if err == nil {
					custom[formatID] = dateFormatCode(xmlAttribute(element, "formatCode"))
				}
			case "cellXfs":
				inCellXfs = true
			case "xf":
				if !inCellXfs {
					continue
				}
				formatID, err := strconv.Atoi(xmlAttribute(element, "numFmtId"))
				if err == nil && (builtinDateFormat(formatID) || custom[formatID]) {
					result.dates[index] = true
				}
				index++
			}
		case xml.EndElement:
			if element.Name.Local == "cellXfs" {
				inCellXfs = false
			}
		}
	}
}

func xlsxDate1904(archive officeArchive) bool {
	decoder, closer, err := archive.decoder("xl/workbook.xml")
	if err != nil {
		return false
	}
	defer closer.Close()
	for {
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		if element, ok := token.(xml.StartElement); ok && element.Name.Local == "workbookPr" {
			value := strings.ToLower(xmlAttribute(element, "date1904"))
			return value == "1" || value == "true"
		}
	}
}

func builtinDateFormat(id int) bool {
	return (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)
}

// dateFormatCode recognizes custom date formats by their tokens, ignoring
// quoted literals, escaped characters and bracketed colors or locales.
func dateFormatCode(code string) bool {
	var builder strings.Builder
	quoted, bracket := false, false
	for index := 0; index < len(code); index++ {
		character := code[index]
		switch {
		case quoted:
			quoted = character != '"'
		case bracket:
			bracket = character != ']'
		case character == '"':
			quoted = true
		case character == '[':
			bracket = true
		case character == '\\':
			index++
		default:
			builder.WriteByte(character)
		}
	}
	plain := strings.ToLower(builder.String())
	return strings.ContainsAny(plain, "ydh") || (strings.Contains(plain, "m") && strings.Contains(plain, "s"))
}

// excelSerialText renders an Excel serial date as ISO 8601 date, time or
// date-time text.
func excelSerialText(value string, date1904 bool) string {
	serial, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil || serial < 0 || serial > 2958465 {
		return value
	}
	days := int(serial)
	seconds := int((serial-float64(days))*86400 + 0.5)
	if seconds >= 86400 {
		days, seconds = days+1, seconds-86400
	}
	clock := fmt.Sprintf("%02d:%02d", seconds/3600, seconds%3600/60)
	if seconds%60 != 0 {
		clock += fmt.Sprintf(":%02d", seconds%60)
	}
	if days == 0 && !date1904 {
		return clock
	}
	base := time.Date(1899, time.December, 30, 0, 0, 0, 0, time.UTC)
	if date1904 {
		base = time.Date(1904, time.January, 1, 0, 0, 0, 0, time.UTC)
	}
	date := base.AddDate(0, 0, days).Format("2006-01-02")
	if seconds == 0 {
		return date
	}
	return date + " " + clock
}

func xlsxSharedStrings(archive officeArchive) ([]string, error) {
	if _, ok := archive.files["xl/sharedStrings.xml"]; !ok {
		return nil, nil
	}
	decoder, closer, err := archive.decoder("xl/sharedStrings.xml")
	if err != nil {
		return nil, err
	}
	defer closer.Close()
	var result []string
	var current strings.Builder
	inItem, inPhonetic := false, false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return result, nil
		}
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrUnsupportedDocument, err)
		}
		switch element := token.(type) {
		case xml.StartElement:
			switch element.Name.Local {
			case "si":
				inItem = true
				current.Reset()
			case "rPh":
				inPhonetic = true
			case "t":
				var text string
				if err := decoder.DecodeElement(&text, &element); err != nil {
					return nil, fmt.Errorf("%w: %v", ErrUnsupportedDocument, err)
				}
				if inItem && !inPhonetic {
					current.WriteString(text)
				}
			}
		case xml.EndElement:
			switch element.Name.Local {
			case "rPh":
				inPhonetic = false
			case "si":
				inItem = false
				result = append(result, current.String())
				if len(result) > maxSheetRows*maxSheetColumns {
					return nil, fmt.Errorf("%w: too many shared strings", ErrUnsupportedDocument)
				}
			}
		}
	}
}

type xlsxSheet struct{ name, path string }

func xlsxSheets(archive officeArchive) ([]xlsxSheet, error) {
	targets := map[string]string{}
	if decoder, closer, err := archive.decoder("xl/_rels/workbook.xml.rels"); err == nil {
		for {
			token, err := decoder.Token()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				closer.Close()
				return nil, fmt.Errorf("%w: %v", ErrUnsupportedDocument, err)
			}
			if element, ok := token.(xml.StartElement); ok && element.Name.Local == "Relationship" {
				target := xmlAttribute(element, "Target")
				if strings.HasPrefix(target, "/") {
					target = strings.TrimPrefix(target, "/")
				} else {
					target = path.Clean("xl/" + target)
				}
				targets[xmlAttribute(element, "Id")] = target
			}
		}
		closer.Close()
	}
	decoder, closer, err := archive.decoder("xl/workbook.xml")
	if err != nil {
		return nil, err
	}
	defer closer.Close()
	var result []xlsxSheet
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return result, nil
		}
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrUnsupportedDocument, err)
		}
		element, ok := token.(xml.StartElement)
		if !ok || element.Name.Local != "sheet" {
			continue
		}
		sheetPath := targets[xmlAttribute(element, "id")]
		if sheetPath == "" {
			sheetPath = "xl/worksheets/sheet" + strconv.Itoa(len(result)+1) + ".xml"
		}
		if _, exists := archive.files[sheetPath]; exists {
			result = append(result, xlsxSheet{name: strings.TrimSpace(xmlAttribute(element, "name")), path: sheetPath})
		}
	}
}

func xlsxRows(archive officeArchive, sheetPath string, shared []string, styles xlsxStyles) ([][]string, error) {
	decoder, closer, err := archive.decoder(sheetPath)
	if err != nil {
		return nil, err
	}
	defer closer.Close()
	var rows [][]string
	var row []string
	cellType, cellRef, cellValue := "", "", ""
	cellStyle := -1
	inCell := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return rows, nil
		}
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrUnsupportedDocument, err)
		}
		switch element := token.(type) {
		case xml.StartElement:
			switch element.Name.Local {
			case "row":
				row = row[:0:0]
			case "c":
				inCell = true
				cellType, cellRef, cellValue = xmlAttribute(element, "t"), xmlAttribute(element, "r"), ""
				cellStyle = -1
				if style, err := strconv.Atoi(xmlAttribute(element, "s")); err == nil {
					cellStyle = style
				}
			case "v", "t":
				if !inCell {
					continue
				}
				var text string
				if err := decoder.DecodeElement(&text, &element); err != nil {
					return nil, fmt.Errorf("%w: %v", ErrUnsupportedDocument, err)
				}
				cellValue += text
			}
		case xml.EndElement:
			switch element.Name.Local {
			case "c":
				inCell = false
				column := xlsxColumn(cellRef, len(row))
				if column >= maxSheetColumns {
					continue
				}
				value := cellValue
				switch cellType {
				case "s":
					index, err := strconv.Atoi(strings.TrimSpace(cellValue))
					if err != nil || index < 0 || index >= len(shared) {
						value = ""
					} else {
						value = shared[index]
					}
				case "b":
					value = map[string]string{"1": "TRUE", "0": "FALSE"}[strings.TrimSpace(cellValue)]
				case "", "n":
					if styles.dates[cellStyle] {
						value = excelSerialText(cellValue, styles.date1904)
					}
				}
				for len(row) < column {
					row = append(row, "")
				}
				row = append(row, value)
			case "row":
				rows = append(rows, row)
				if len(rows) >= maxSheetRows {
					return rows, nil
				}
			}
		}
	}
}

// xlsxColumn converts the letters of a cell reference ("C7") to a zero-based
// column, falling back to the next position when the reference is absent.
func xlsxColumn(reference string, fallback int) int {
	column := 0
	letters := 0
	for _, character := range reference {
		if character < 'A' || character > 'Z' {
			break
		}
		column = column*26 + int(character-'A'+1)
		letters++
		if letters > 3 {
			return fallback
		}
	}
	if letters == 0 {
		return fallback
	}
	return column - 1
}
