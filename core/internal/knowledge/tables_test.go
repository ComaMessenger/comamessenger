package knowledge

import (
	"errors"
	"strings"
	"testing"
)

// slotsCSV is a fictional slot schedule of a rehabilitation centre.
const slotsCSV = "Дата;Начало;Конец;Зал;Инструктор;Статус\n" +
	"2026-11-12;09:00;10:00;Зал 1;Иванова;занят\n" +
	"2026-11-12;10:00;11:00;Зал 1;;свободен\n" +
	"2026-11-12;11:00;12:00;Зал 2;Петров;занят\n" +
	"2026-11-13;09:00;10:00;Зал 1;;свободен\n" +
	"\n"

func TestQueryTableSeesOnlyBoundSpreadsheetsAndRespectsLimits(t *testing.T) {
	f := newFixture(t, nil, nil)
	bound, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Расписание"})
	if err != nil {
		t.Fatal(err)
	}
	hidden, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Бухгалтерия"})
	if err != nil {
		t.Fatal(err)
	}
	slots, err := f.service.CreateDocument(t.Context(), f.owner, bound.ID, CreateDocumentInput{Kind: "file", FileID: f.upload(t, f.owner, "slots.csv", "text/csv", []byte(slotsCSV)), Title: "Слоты"})
	if err != nil {
		t.Fatal(err)
	}
	f.index(t, slots)
	payroll, err := f.service.CreateDocument(t.Context(), f.owner, hidden.ID, CreateDocumentInput{Kind: "file", FileID: f.upload(t, f.owner, "payroll.csv", "text/csv", []byte("Сотрудник,Сумма\nИванова,1000\n")), Title: "Выплаты"})
	if err != nil {
		t.Fatal(err)
	}
	f.index(t, payroll)
	if _, err := f.pool.Exec(t.Context(), `UPDATE agents SET knowledge_collection_ids=ARRAY[$1::uuid],allowed_scopes=ARRAY['runtime:execute','tables:read'] WHERE actor_id=$2`, bound.ID, f.agentID); err != nil {
		t.Fatal(err)
	}
	runID, _ := f.startRun(t, f.agentID, map[string]any{})

	catalog, err := f.service.QueryTableForAgent(t.Context(), TableQueryInput{OrgID: f.orgID, AgentID: f.agentID, RunID: runID})
	if err != nil {
		t.Fatal(err)
	}
	if catalog.Tables == nil || len(*catalog.Tables) != 1 || (*catalog.Tables)[0].DocumentID != slots.ID || (*catalog.Tables)[0].RowCount != 4 ||
		strings.Join((*catalog.Tables)[0].Columns, ",") != "Дата,Начало,Конец,Зал,Инструктор,Статус" {
		t.Fatalf("catalog = %+v", catalog)
	}
	// A document from an unbound collection is reported as missing.
	foreign, err := f.service.QueryTableForAgent(t.Context(), TableQueryInput{OrgID: f.orgID, AgentID: f.agentID, RunID: runID, DocumentID: payroll.ID})
	if err != nil || foreign.Error != "table_not_found" || len(foreign.Rows) != 0 {
		t.Fatalf("foreign table = %+v, err=%v", foreign, err)
	}
	free, err := f.service.QueryTableForAgent(t.Context(), TableQueryInput{OrgID: f.orgID, AgentID: f.agentID, RunID: runID, DocumentID: slots.ID,
		Filters: []TableFilter{{Column: "статус", Op: "equals", Value: "Свободен"}, {Column: "Дата", Op: "lte", Value: "2026-11-12"}},
		Columns: []string{"Начало", "Зал"}})
	if err != nil {
		t.Fatal(err)
	}
	if free.Matched != 1 || len(free.Rows) != 1 || free.Rows[0].Row != 2 || free.Rows[0].Values["Начало"] != "10:00" || free.Rows[0].Values["Зал"] != "Зал 1" ||
		len(free.Rows[0].Values) != 2 || free.HasMore {
		t.Fatalf("free slots = %+v", free)
	}
	page, err := f.service.QueryTableForAgent(t.Context(), TableQueryInput{OrgID: f.orgID, AgentID: f.agentID, RunID: runID, DocumentID: slots.ID, Limit: 2})
	if err != nil || len(page.Rows) != 2 || !page.HasMore || page.Matched != 4 {
		t.Fatalf("limited page = %+v, err=%v", page, err)
	}
	empty, err := f.service.QueryTableForAgent(t.Context(), TableQueryInput{OrgID: f.orgID, AgentID: f.agentID, RunID: runID, DocumentID: slots.ID,
		Filters: []TableFilter{{Column: "Инструктор", Op: "empty"}}})
	if err != nil || empty.Matched != 2 {
		t.Fatalf("empty instructor rows = %+v, err=%v", empty, err)
	}
	unknown, err := f.service.QueryTableForAgent(t.Context(), TableQueryInput{OrgID: f.orgID, AgentID: f.agentID, RunID: runID, DocumentID: slots.ID,
		Filters: []TableFilter{{Column: "Нет такого", Op: "equals", Value: "x"}}})
	if err != nil || unknown.Error != "unknown_column" || len(unknown.Columns) != 6 {
		t.Fatalf("unknown column = %+v, err=%v", unknown, err)
	}
	for _, input := range []TableQueryInput{{Limit: 201}, {Offset: -1}, {Filters: []TableFilter{{Column: "Дата", Op: "regex", Value: "."}}}} {
		input.OrgID, input.AgentID, input.RunID, input.DocumentID = f.orgID, f.agentID, runID, slots.ID
		if _, err := f.service.QueryTableForAgent(t.Context(), input); !errors.Is(err, ErrInvalid) {
			t.Fatalf("out of range input %+v error = %v", input, err)
		}
	}
	// Another agent without the binding sees nothing.
	otherRun, _ := f.startRun(t, f.otherID, map[string]any{})
	other, err := f.service.QueryTableForAgent(t.Context(), TableQueryInput{OrgID: f.orgID, AgentID: f.otherID, RunID: otherRun})
	if err != nil || other.Tables == nil || len(*other.Tables) != 0 {
		t.Fatalf("unbound agent catalog = %+v, err=%v", other, err)
	}
	// A dry run uses the draft's collections from its snapshot.
	draftRun, _ := f.startRun(t, f.otherID, map[string]any{"knowledge_collection_ids": []string{bound.ID}})
	draft, err := f.service.QueryTableForAgent(t.Context(), TableQueryInput{OrgID: f.orgID, AgentID: f.otherID, RunID: draftRun})
	if err != nil || draft.Tables == nil || len(*draft.Tables) != 1 {
		t.Fatalf("draft catalog = %+v, err=%v", draft, err)
	}
	// Deleting the document removes its rows.
	if err := f.service.DeleteDocument(t.Context(), f.owner, slots.ID); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM knowledge_table_rows`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("rows left after delete = %d, err=%v", rows, err)
	}
}

func TestQueryTableBackfillsDocumentsIndexedBeforeTables(t *testing.T) {
	f := newFixture(t, nil, nil)
	collection, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Расписание"})
	if err != nil {
		t.Fatal(err)
	}
	slots, err := f.service.CreateDocument(t.Context(), f.owner, collection.ID, CreateDocumentInput{Kind: "file", FileID: f.upload(t, f.owner, "slots.csv", "text/csv", []byte(slotsCSV)), Title: "Слоты"})
	if err != nil {
		t.Fatal(err)
	}
	f.index(t, slots)
	// Simulate a document indexed by a Core release without tables.
	if _, err := f.pool.Exec(t.Context(), `DELETE FROM knowledge_tables; UPDATE knowledge_documents SET tables_version=NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE agents SET knowledge_collection_ids=ARRAY[$1::uuid] WHERE actor_id=$2`, collection.ID, f.agentID); err != nil {
		t.Fatal(err)
	}
	runID, _ := f.startRun(t, f.agentID, map[string]any{})
	result, err := f.service.QueryTableForAgent(t.Context(), TableQueryInput{OrgID: f.orgID, AgentID: f.agentID, RunID: runID, DocumentID: slots.ID})
	if err != nil || len(result.Rows) != 4 {
		t.Fatalf("backfilled rows = %+v, err=%v", result, err)
	}
}

func TestSheetTableNamesBlankAndDuplicateColumns(t *testing.T) {
	columns, rows := sheetTable([][]string{{"", ""}, {"Имя", "", "имя"}, {"А", "Б", "В", "Г"}, {" ", ""}})
	if strings.Join(columns, "|") != "Имя|column_2|имя (2)|column_4" || len(rows) != 1 || rows[0][3] != "Г" {
		t.Fatalf("columns = %#v rows = %#v", columns, rows)
	}
}
