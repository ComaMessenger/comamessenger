package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Spreadsheet documents (CSV, XLSX) of the knowledge base are also stored as
// structured rows so that agents can filter them with query_table without
// re-reading the file. Rows belong to the indexed content version and are
// replaced in the same transaction as the text fragments.

const (
	defaultTableLimit = 50
	maxTableLimit     = 200
	maxTableOffset    = 50_000
	maxTableFilters   = 10
	maxCellRunes      = 2000
	maxColumnRunes    = 120
)

// TableColumns describes one sheet available to an agent.
type TableSheet struct {
	DocumentID    string   `json:"document_id"`
	DocumentTitle string   `json:"document_title"`
	Collection    string   `json:"collection"`
	Sheet         string   `json:"sheet"`
	Columns       []string `json:"columns"`
	RowCount      int      `json:"row_count"`
	Truncated     bool     `json:"truncated"`
}

// TableFilter compares one column with a value. Operators: equals,
// not_equals, contains, starts_with, empty, not_empty, gte, lte. gte and lte
// compare numbers numerically and everything else as text, which orders ISO
// dates and times correctly.
type TableFilter struct {
	Column string `json:"column"`
	Op     string `json:"op"`
	Value  string `json:"value"`
}

// TableQueryInput is a query_table call of one agent run.
type TableQueryInput struct {
	OrgID      string
	AgentID    string
	RunID      string
	DocumentID string
	Sheet      string
	Columns    []string
	Filters    []TableFilter
	Limit      int
	Offset     int
}

// TableRow is a matched row with values keyed by column name.
type TableRow struct {
	Row    int               `json:"row"`
	Values map[string]string `json:"values"`
}

// TableQueryResult is either a catalog of sheets (no document requested), a
// page of rows, or a correctable error the model can act on.
type TableQueryResult struct {
	Tables        *[]TableSheet `json:"tables,omitempty"`
	DocumentID    string        `json:"document_id,omitempty"`
	DocumentTitle string        `json:"document_title,omitempty"`
	Sheet         *string       `json:"sheet,omitempty"`
	Columns       []string      `json:"columns,omitempty"`
	Rows          []TableRow    `json:"rows,omitempty"`
	Matched       int           `json:"matched"`
	HasMore       bool          `json:"has_more"`
	Truncated     bool          `json:"truncated,omitempty"`
	Error         string        `json:"error,omitempty"`
	Sheets        []string      `json:"sheets,omitempty"`
}

// sheetTable normalizes raw rows: the first non-empty row is the header,
// blank and duplicate header cells get stable names, empty rows are skipped.
func sheetTable(rows [][]string) ([]string, [][]string) {
	start := -1
	for index, row := range rows {
		if !blankRow(row) {
			start = index
			break
		}
	}
	if start < 0 {
		return nil, nil
	}
	width := 0
	for _, row := range rows[start:] {
		width = max(width, len(row))
	}
	columns := make([]string, width)
	seen := map[string]int{}
	for index := range columns {
		name := ""
		if index < len(rows[start]) {
			name = clipRunes(strings.Join(strings.Fields(rows[start][index]), " "), maxColumnRunes)
		}
		if name == "" {
			name = "column_" + strconv.Itoa(index+1)
		}
		key := strings.ToLower(name)
		seen[key]++
		if seen[key] > 1 {
			name = name + " (" + strconv.Itoa(seen[key]) + ")"
		}
		columns[index] = name
	}
	data := make([][]string, 0, len(rows)-start-1)
	for _, row := range rows[start+1:] {
		if blankRow(row) {
			continue
		}
		cells := make([]string, width)
		for index := range cells {
			if index < len(row) {
				cells[index] = clipRunes(strings.TrimSpace(row[index]), maxCellRunes)
			}
		}
		data = append(data, cells)
	}
	return columns, data
}

func blankRow(row []string) bool {
	for _, cell := range row {
		if strings.TrimSpace(cell) != "" {
			return false
		}
	}
	return true
}

func clipRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}

// storeTables replaces the structured rows of a document version inside the
// indexing transaction.
func storeTables(ctx context.Context, tx pgx.Tx, orgID, collectionID, documentID string, version int, sheets []files.SheetRows) error {
	if _, err := tx.Exec(ctx, `DELETE FROM knowledge_tables WHERE org_id=$1 AND document_id=$2`, orgID, documentID); err != nil {
		return fmt.Errorf("replace knowledge tables: %w", err)
	}
	for index, sheet := range sheets {
		columns, rows := sheetTable(sheet.Rows)
		if len(columns) == 0 {
			continue
		}
		tableID, err := id.New()
		if err != nil {
			return err
		}
		encodedColumns, _ := json.Marshal(columns)
		if _, err := tx.Exec(ctx, `INSERT INTO knowledge_tables(id,org_id,collection_id,document_id,sheet_index,sheet,columns,row_count,truncated)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, tableID, orgID, collectionID, documentID, index, clipRunes(sheet.Sheet, 255), encodedColumns, len(rows), sheet.Truncated); err != nil {
			return fmt.Errorf("insert knowledge table: %w", err)
		}
		for start := 0; start < len(rows); start += 1000 {
			end := min(start+1000, len(rows))
			numbers := make([]int32, 0, end-start)
			cells := make([]string, 0, end-start)
			for offset, row := range rows[start:end] {
				encoded, _ := json.Marshal(row)
				numbers = append(numbers, int32(start+offset+1))
				cells = append(cells, string(encoded))
			}
			if _, err := tx.Exec(ctx, `INSERT INTO knowledge_table_rows(org_id,table_id,row_number,cells)
				SELECT $1,$2,item.number,item.cells::jsonb FROM unnest($3::integer[],$4::text[]) AS item(number,cells)`, orgID, tableID, numbers, cells); err != nil {
				return fmt.Errorf("insert knowledge table rows: %w", err)
			}
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE knowledge_documents SET tables_version=$3 WHERE org_id=$1 AND id=$2`, orgID, documentID, version); err != nil {
		return fmt.Errorf("mark knowledge tables: %w", err)
	}
	return nil
}

// spreadsheetSheets extracts rows when the file is a spreadsheet; other
// formats have no tables.
func spreadsheetSheets(source files.SourceFile) ([]files.SheetRows, error) {
	kind := files.DocumentKind(source.Name, source.MIME)
	if kind != "csv" && kind != "xlsx" {
		return nil, nil
	}
	return files.ExtractSheets(source.Name, source.MIME, source.Data)
}

// ensureTables backfills rows for ready spreadsheet documents indexed before
// tables existed (or by an older Core). It is idempotent and version-checked.
func (s *Service) ensureTables(ctx context.Context, orgID string, collectionIDs []string) error {
	rows, err := s.pool.Query(ctx, `SELECT document.id::text,document.collection_id::text,document.file_id::text,document.content_version
		FROM knowledge_documents document JOIN files file ON file.org_id=document.org_id AND file.id=document.file_id
		WHERE document.org_id=$1 AND document.collection_id=ANY($2::uuid[]) AND document.kind='file' AND document.status='ready'
		  AND document.tables_version IS DISTINCT FROM document.content_version
		  AND (lower(file.name) LIKE '%.csv' OR lower(file.name) LIKE '%.xlsx' OR file.mime IN ('text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
		LIMIT 20`, orgID, collectionIDs)
	if err != nil {
		return fmt.Errorf("find spreadsheets to backfill: %w", err)
	}
	type pending struct {
		documentID, collectionID, fileID string
		version                          int
	}
	var documents []pending
	for rows.Next() {
		var item pending
		if err := rows.Scan(&item.documentID, &item.collectionID, &item.fileID, &item.version); err != nil {
			rows.Close()
			return err
		}
		documents = append(documents, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, document := range documents {
		if s.files == nil {
			return errors.New("knowledge file reader is not configured")
		}
		source, err := s.files.ReadSource(ctx, orgID, document.fileID)
		if err != nil {
			continue
		}
		sheets, err := spreadsheetSheets(source)
		if err != nil {
			sheets = nil
		}
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		var current int
		err = tx.QueryRow(ctx, `SELECT content_version FROM knowledge_documents WHERE org_id=$1 AND id=$2 FOR UPDATE`, orgID, document.documentID).Scan(&current)
		if err == nil && current == document.version {
			err = storeTables(ctx, tx, orgID, document.collectionID, document.documentID, document.version, sheets)
			if err == nil {
				err = tx.Commit(ctx)
			}
		}
		_ = tx.Rollback(ctx)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	return nil
}

// agentCollections resolves the collections bound to the agent version the
// run executes, restricted to collections shared with the run's chat.
func (s *Service) agentCollections(ctx context.Context, orgID, runID, agentID string) ([]collectionScope, error) {
	rows, err := s.pool.Query(ctx, `SELECT collection.id::text,collection.embedding_connection_id::text
		FROM agent_runs run
		JOIN agents agent ON agent.org_id=run.org_id AND agent.actor_id=run.agent_id
		JOIN knowledge_collections collection ON collection.org_id=run.org_id AND collection.id=ANY(
			CASE WHEN run.agent_config ? 'knowledge_collection_ids'
			THEN ARRAY(SELECT jsonb_array_elements_text(run.agent_config->'knowledge_collection_ids'))::uuid[]
			ELSE agent.knowledge_collection_ids END)
		WHERE run.org_id=$1 AND run.id=$2 AND run.agent_id=$3
		  AND (collection.access='organization' OR EXISTS(
			SELECT 1 FROM knowledge_collection_chats shared
			WHERE shared.org_id=collection.org_id AND shared.collection_id=collection.id AND shared.chat_id=run.chat_id))`,
		orgID, runID, agentID)
	if err != nil {
		return nil, fmt.Errorf("resolve agent knowledge collections: %w", err)
	}
	return scanScopes(rows)
}

// QueryTableForAgent lists the spreadsheets of the agent's bound collections
// or returns filtered rows of one sheet. Documents outside those collections
// are reported as not found, exactly like documents that do not exist.
func (s *Service) QueryTableForAgent(ctx context.Context, input TableQueryInput) (TableQueryResult, error) {
	if uuid.Validate(input.RunID) != nil || uuid.Validate(input.AgentID) != nil {
		return TableQueryResult{}, fmt.Errorf("%w: run is required", ErrInvalid)
	}
	if input.DocumentID != "" && uuid.Validate(input.DocumentID) != nil {
		return TableQueryResult{Error: "table_not_found"}, nil
	}
	if input.Limit == 0 {
		input.Limit = defaultTableLimit
	}
	if input.Limit < 1 || input.Limit > maxTableLimit || input.Offset < 0 || input.Offset > maxTableOffset || len(input.Filters) > maxTableFilters || len(input.Columns) > 50 {
		return TableQueryResult{}, fmt.Errorf("%w: limit, offset, filters or columns out of range", ErrInvalid)
	}
	scopes, err := s.agentCollections(ctx, input.OrgID, input.RunID, input.AgentID)
	if err != nil {
		return TableQueryResult{}, err
	}
	collectionIDs := make([]string, len(scopes))
	for index, scope := range scopes {
		collectionIDs[index] = scope.id
	}
	if len(collectionIDs) == 0 {
		if input.DocumentID != "" {
			return TableQueryResult{Error: "table_not_found"}, nil
		}
		return TableQueryResult{Tables: &[]TableSheet{}}, nil
	}
	if err := s.ensureTables(ctx, input.OrgID, collectionIDs); err != nil {
		return TableQueryResult{}, err
	}
	sheets, err := s.visibleSheets(ctx, input.OrgID, collectionIDs, input.DocumentID)
	if err != nil {
		return TableQueryResult{}, err
	}
	if input.DocumentID == "" {
		return TableQueryResult{Tables: &sheets}, nil
	}
	if len(sheets) == 0 {
		return TableQueryResult{Error: "table_not_found"}, nil
	}
	selected := -1
	names := make([]string, len(sheets))
	for index, sheet := range sheets {
		names[index] = sheet.Sheet
		if strings.EqualFold(strings.TrimSpace(sheet.Sheet), strings.TrimSpace(input.Sheet)) {
			selected = index
		}
	}
	if selected < 0 {
		if input.Sheet != "" || len(sheets) > 1 {
			return TableQueryResult{DocumentID: input.DocumentID, Error: "sheet_required", Sheets: names}, nil
		}
		selected = 0
	}
	return s.queryRows(ctx, input, sheets[selected])
}

func (s *Service) visibleSheets(ctx context.Context, orgID string, collectionIDs []string, documentID string) ([]TableSheet, error) {
	query := `SELECT document.id::text,document.title,collection.name,item.sheet,item.columns,item.row_count,item.truncated
		FROM knowledge_tables item
		JOIN knowledge_documents document ON document.org_id=item.org_id AND document.id=item.document_id
		JOIN knowledge_collections collection ON collection.org_id=item.org_id AND collection.id=item.collection_id
		WHERE item.org_id=$1 AND item.collection_id=ANY($2::uuid[]) AND document.status='ready'
		  AND document.tables_version=document.content_version`
	args := []any{orgID, collectionIDs}
	if documentID != "" {
		query += ` AND item.document_id=$3`
		args = append(args, documentID)
	}
	rows, err := s.pool.Query(ctx, query+` ORDER BY lower(collection.name),lower(document.title),document.id,item.sheet_index LIMIT 200`, args...)
	if err != nil {
		return nil, fmt.Errorf("list knowledge tables: %w", err)
	}
	defer rows.Close()
	result := make([]TableSheet, 0)
	for rows.Next() {
		var sheet TableSheet
		var columns []byte
		if err := rows.Scan(&sheet.DocumentID, &sheet.DocumentTitle, &sheet.Collection, &sheet.Sheet, &columns, &sheet.RowCount, &sheet.Truncated); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(columns, &sheet.Columns); err != nil {
			return nil, err
		}
		result = append(result, sheet)
	}
	return result, rows.Err()
}

func (s *Service) queryRows(ctx context.Context, input TableQueryInput, sheet TableSheet) (TableQueryResult, error) {
	result := TableQueryResult{DocumentID: sheet.DocumentID, DocumentTitle: sheet.DocumentTitle, Sheet: &sheet.Sheet, Truncated: sheet.Truncated}
	index := make(map[string]int, len(sheet.Columns))
	for position, column := range sheet.Columns {
		index[strings.ToLower(column)] = position
	}
	lookup := func(name string) (int, bool) {
		position, ok := index[strings.ToLower(strings.TrimSpace(name))]
		return position, ok
	}
	selected := make([]int, 0, len(sheet.Columns))
	if len(input.Columns) == 0 {
		for position := range sheet.Columns {
			selected = append(selected, position)
		}
	} else {
		for _, name := range input.Columns {
			position, ok := lookup(name)
			if !ok {
				result.Error, result.Columns = "unknown_column", sheet.Columns
				return result, nil
			}
			selected = append(selected, position)
		}
	}
	conditions := make([]string, 0, len(input.Filters))
	args := []any{input.OrgID, sheet.DocumentID, sheet.Sheet}
	for _, filter := range input.Filters {
		position, ok := lookup(filter.Column)
		if !ok {
			result.Error, result.Columns = "unknown_column", sheet.Columns
			return result, nil
		}
		if utf8.RuneCountInString(filter.Value) > 500 {
			return TableQueryResult{}, fmt.Errorf("%w: filter value is too long", ErrInvalid)
		}
		cell := fmt.Sprintf("btrim(COALESCE(row.cells->>%d,''))", position)
		value := strings.TrimSpace(filter.Value)
		args = append(args, value)
		parameter := "$" + strconv.Itoa(len(args))
		switch filter.Op {
		case "", "equals":
			conditions = append(conditions, "lower("+cell+")=lower("+parameter+")")
		case "not_equals":
			conditions = append(conditions, "lower("+cell+")<>lower("+parameter+")")
		case "contains":
			conditions = append(conditions, "strpos(lower("+cell+"),lower("+parameter+"))>0")
		case "starts_with":
			conditions = append(conditions, "starts_with(lower("+cell+"),lower("+parameter+"))")
		case "empty":
			conditions = append(conditions, cell+"='' AND "+parameter+"::text IS NOT NULL")
		case "not_empty":
			conditions = append(conditions, cell+"<>'' AND "+parameter+"::text IS NOT NULL")
		case "gte", "lte":
			operator := ">="
			if filter.Op == "lte" {
				operator = "<="
			}
			if _, err := strconv.ParseFloat(value, 64); err == nil {
				conditions = append(conditions, "("+cell+" ~ '^-?[0-9]+([.,][0-9]+)?$' AND replace("+cell+",',','.')::numeric"+operator+parameter+"::numeric)")
			} else {
				conditions = append(conditions, "("+cell+"<>'' AND "+cell+operator+parameter+" COLLATE \"C\")")
			}
		default:
			return TableQueryResult{}, fmt.Errorf("%w: unknown filter operator %q", ErrInvalid, filter.Op)
		}
	}
	where := ""
	if len(conditions) > 0 {
		where = " AND " + strings.Join(conditions, " AND ")
	}
	args = append(args, input.Limit+1, input.Offset)
	query := `SELECT row.row_number,row.cells,count(*) OVER()
		FROM knowledge_table_rows row
		JOIN knowledge_tables item ON item.org_id=row.org_id AND item.id=row.table_id
		WHERE item.org_id=$1 AND item.document_id=$2 AND item.sheet=$3` + where + `
		ORDER BY row.row_number LIMIT $` + strconv.Itoa(len(args)-1) + ` OFFSET $` + strconv.Itoa(len(args))
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return TableQueryResult{}, fmt.Errorf("query knowledge table: %w", err)
	}
	defer rows.Close()
	result.Columns = make([]string, len(selected))
	for position, column := range selected {
		result.Columns[position] = sheet.Columns[column]
	}
	result.Rows = make([]TableRow, 0, input.Limit)
	for rows.Next() {
		var number, total int
		var encoded []byte
		if err := rows.Scan(&number, &encoded, &total); err != nil {
			return TableQueryResult{}, err
		}
		result.Matched = total
		if len(result.Rows) == input.Limit {
			result.HasMore = true
			continue
		}
		var cells []string
		if err := json.Unmarshal(encoded, &cells); err != nil {
			return TableQueryResult{}, err
		}
		values := make(map[string]string, len(selected))
		for _, column := range selected {
			if column < len(cells) {
				values[sheet.Columns[column]] = cells[column]
			}
		}
		result.Rows = append(result.Rows, TableRow{Row: number, Values: values})
	}
	if err := rows.Err(); err != nil {
		return TableQueryResult{}, err
	}
	if !result.HasMore {
		result.HasMore = input.Offset+len(result.Rows) < result.Matched
	}
	return result, nil
}
