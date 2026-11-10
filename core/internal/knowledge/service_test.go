package knowledge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/agentconfig"
	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// fixture is a fictional rehabilitation centre plus an unrelated second
// organization used to prove isolation.
type fixture struct {
	pool                     *pgxpool.Pool
	files                    *files.Service
	service                  *Service
	orgID, otherOrgID        string
	owner, member, librarian identity.User
	outsider, otherOwner     identity.User
	chatID, agentID, otherID string
}

func newFixture(t *testing.T, resolver ConnectionResolver, embedder Embedder) fixture {
	t.Helper()
	pool := testdb.New(t)
	f := fixture{pool: pool, orgID: uuid.NewString(), otherOrgID: uuid.NewString(), chatID: uuid.NewString(), agentID: uuid.NewString(), otherID: uuid.NewString()}
	ownerID, memberID, librarianID, outsiderID, otherOwnerID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	statements := []struct {
		sql  string
		args []any
	}{
		// Deployments hold one organization; the test database drops that
		// guard so the org_id filters can be proven as a second line of defence.
		{`ALTER TABLE organizations DROP CONSTRAINT organizations_singleton_key`, nil},
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Rehab','rehab'),($2,'Other','other')`, []any{f.orgID, f.otherOrgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES
			($1,$6,'user','owner','Owner','owner'),($2,$6,'user','member','Member','member'),
			($3,$6,'user','member','Librarian','librarian'),($4,$6,'user','member','Outsider','outsider'),
			($5,$7,'user','owner','Other owner','other_owner')`, []any{ownerID, memberID, librarianID, outsiderID, otherOwnerID, f.orgID, f.otherOrgID}},
		{`INSERT INTO actor_permissions(org_id,actor_id,permission,granted_by) VALUES($1,$2,'knowledge.manage',$3)`, []any{f.orgID, librarianID, ownerID}},
		{`INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($1,$2,'group','private','Instructors',$3)`, []any{f.chatID, f.orgID, ownerID}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'owner'),($1,$4,$3,'member')`, []any{f.chatID, ownerID, f.orgID, memberID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$3,'agent','member','Reference','reference'),($2,$3,'agent','member','Unbound','unbound')`, []any{f.agentID, f.otherID, f.orgID}},
		{`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes) VALUES($1,$3,$4,'builtin',true,ARRAY['knowledge:read','runtime:execute']),($2,$3,$4,'builtin',true,ARRAY['knowledge:read','runtime:execute'])`, []any{f.agentID, f.otherID, f.orgID, ownerID}},
	}
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	for _, statement := range statements {
		if _, err := tx.Exec(t.Context(), statement.sql, statement.args...); err != nil {
			t.Fatalf("seed: %v\n%s", err, statement.sql)
		}
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	f.owner = identity.User{ActorID: ownerID, OrgID: f.orgID, OrgRole: "owner", Permissions: permission.Effective("owner", nil)}
	f.member = identity.User{ActorID: memberID, OrgID: f.orgID, OrgRole: "member", Permissions: permission.Effective("member", nil)}
	f.librarian = identity.User{ActorID: librarianID, OrgID: f.orgID, OrgRole: "member", Permissions: permission.Effective("member", []permission.Code{permission.KnowledgeManage})}
	f.outsider = identity.User{ActorID: outsiderID, OrgID: f.orgID, OrgRole: "member", Permissions: permission.Effective("member", nil)}
	f.otherOwner = identity.User{ActorID: otherOwnerID, OrgID: f.otherOrgID, OrgRole: "owner", Permissions: permission.Effective("owner", nil)}
	store, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	f.files, err = files.NewService(pool, store, "", 16<<20, 8<<20, 4<<20, time.Hour, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	f.service = NewService(pool, f.files, resolver, embedder)
	if _, err := NewIndexingClient(pool, f.service, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f fixture) upload(t *testing.T, user identity.User, name, mime string, body []byte) string {
	t.Helper()
	upload, err := f.files.CreateUpload(t.Context(), user, files.CreateUploadInput{Name: name, MIME: mime, Size: int64(len(body))})
	if err != nil {
		t.Fatal(err)
	}
	file, err := f.files.PutContent(t.Context(), user, upload.ID, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	return file.ID
}

// index runs the queued job synchronously; the River client is not started.
func (f fixture) index(t *testing.T, document Document) {
	t.Helper()
	var jobs int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM river_job WHERE kind='knowledge.index' AND args->>'document_id'=$1`, document.ID).Scan(&jobs); err != nil || jobs < 1 {
		t.Fatalf("knowledge.index jobs = %d, err = %v", jobs, err)
	}
	if err := f.service.IndexDocument(t.Context(), document.ID, document.ContentVersion); err != nil {
		t.Fatal(err)
	}
}

const policyMarkdown = `# Правила центра

Общие положения для инструкторов и врачей.

## Отпуска

Заявление на отпуск подаётся администратору за две недели.
Замену на слоты подбирает старший инструктор.

## Смены

Инструктор передаёт дела следующему по слоту через чат «Передача».
`

func TestDocumentIsSearchableAfterUploadAndIsolatedBetweenOrganizations(t *testing.T) {
	f := newFixture(t, nil, nil)
	collection, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Регламенты", Description: "Правила центра"})
	if err != nil {
		t.Fatal(err)
	}
	fileID := f.upload(t, f.owner, "rules.md", "text/markdown", []byte(policyMarkdown))
	document, err := f.service.CreateDocument(t.Context(), f.owner, collection.ID, CreateDocumentInput{Kind: "file", FileID: fileID})
	if err != nil {
		t.Fatal(err)
	}
	if document.Status != "pending" || document.Title != "rules.md" || document.FileName == nil {
		t.Fatalf("created document = %+v", document)
	}
	f.index(t, document)
	indexed, err := f.service.GetDocument(t.Context(), f.member, document.ID)
	if err != nil || indexed.Status != "ready" || indexed.ChunkCount != 3 || indexed.EmbeddingStatus != "none" || indexed.IndexedAt == nil {
		t.Fatalf("indexed document = %+v, err = %v", indexed, err)
	}

	result, err := f.service.Search(t.Context(), f.member, SearchInput{Query: "заявление на отпуск"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Fragments) == 0 || result.Semantic {
		t.Fatalf("search result = %+v", result)
	}
	top := result.Fragments[0]
	if top.DocumentID != document.ID || top.DocumentTitle != "rules.md" || top.Section != "Правила центра › Отпуска" || top.Position != 1 ||
		!strings.Contains(top.Content, "за две недели") || top.CollectionName != "Регламенты" || top.Match != "text" {
		t.Fatalf("top fragment = %+v", top)
	}

	// The second organization sees neither the collection nor its fragments.
	other, err := f.service.Search(t.Context(), f.otherOwner, SearchInput{Query: "отпуск"})
	if err != nil || len(other.Fragments) != 0 {
		t.Fatalf("other organization search = %+v, err = %v", other, err)
	}
	if _, err := f.service.Search(t.Context(), f.otherOwner, SearchInput{Query: "отпуск", CollectionIDs: []string{collection.ID}}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("explicit foreign collection search err = %v", err)
	}
	if _, err := f.service.GetCollection(t.Context(), f.otherOwner, collection.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign collection get err = %v", err)
	}
	if _, err := f.service.GetDocument(t.Context(), f.otherOwner, document.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign document get err = %v", err)
	}
	if err := f.service.DeleteDocument(t.Context(), f.otherOwner, document.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign document delete err = %v", err)
	}
	foreignCollection, err := f.service.CreateCollection(t.Context(), f.otherOwner, CreateCollectionInput{Name: "Чужая"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.CreateDocument(t.Context(), f.otherOwner, foreignCollection.ID, CreateDocumentInput{Kind: "file", FileID: fileID}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("attaching a foreign file err = %v", err)
	}
}

func TestMemberWithoutPermissionCannotUpload(t *testing.T) {
	f := newFixture(t, nil, nil)
	collection, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Регламенты"})
	if err != nil {
		t.Fatal(err)
	}
	fileID := f.upload(t, f.member, "notes.txt", "text/plain", []byte("Заметки участника"))
	if _, err := f.service.CreateDocument(t.Context(), f.member, collection.ID, CreateDocumentInput{Kind: "file", FileID: fileID}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member upload err = %v", err)
	}
	if _, err := f.service.CreateDocument(t.Context(), f.member, collection.ID, CreateDocumentInput{Kind: "page", Title: "Страница", Body: "Текст"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member page err = %v", err)
	}
	if _, err := f.service.CreateCollection(t.Context(), f.member, CreateCollectionInput{Name: "Своя"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member collection err = %v", err)
	}
	if err := f.service.DeleteCollection(t.Context(), f.member, collection.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member delete err = %v", err)
	}
	var documents int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM knowledge_documents`).Scan(&documents); err != nil || documents != 0 {
		t.Fatalf("documents after forbidden uploads = %d, err = %v", documents, err)
	}

	// A member granted knowledge.manage may upload, but only files they own.
	if _, err := f.service.CreateDocument(t.Context(), f.librarian, collection.ID, CreateDocumentInput{Kind: "file", FileID: fileID}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("librarian attaching someone else's upload err = %v", err)
	}
	ownFile := f.upload(t, f.librarian, "schedule.csv", "text/csv", []byte("Инструктор;Слот\nИванова;09:00\nПетров;11:00\n"))
	document, err := f.service.CreateDocument(t.Context(), f.librarian, collection.ID, CreateDocumentInput{Kind: "file", FileID: ownFile, Title: "Слоты"})
	if err != nil {
		t.Fatal(err)
	}
	f.index(t, document)
	result, err := f.service.Search(t.Context(), f.member, SearchInput{Query: "Петров"})
	if err != nil || len(result.Fragments) != 1 || !strings.Contains(result.Fragments[0].Content, "Инструктор: Петров; Слот: 11:00") {
		t.Fatalf("CSV search = %+v, err = %v", result, err)
	}
}

func TestChatRestrictedCollectionIsVisibleOnlyToChatMembers(t *testing.T) {
	f := newFixture(t, nil, nil)
	if _, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Инструкторам", Access: "chats"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("chat access without chats err = %v", err)
	}
	collection, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Инструкторам", Access: "chats", ChatIDs: []string{f.chatID}})
	if err != nil {
		t.Fatal(err)
	}
	document, err := f.service.CreateDocument(t.Context(), f.owner, collection.ID, CreateDocumentInput{Kind: "page", Title: "Разминка", Body: "# Разминка\n\nРазминка перед занятием длится десять минут."})
	if err != nil {
		t.Fatal(err)
	}
	f.index(t, document)
	inChat, err := f.service.Search(t.Context(), f.member, SearchInput{Query: "разминка"})
	if err != nil || len(inChat.Fragments) != 1 {
		t.Fatalf("chat member search = %+v, err = %v", inChat, err)
	}
	outside, err := f.service.Search(t.Context(), f.outsider, SearchInput{Query: "разминка"})
	if err != nil || len(outside.Fragments) != 0 {
		t.Fatalf("outsider search = %+v, err = %v", outside, err)
	}
	if _, err := f.service.ListDocuments(t.Context(), f.outsider, collection.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider list err = %v", err)
	}
	listed, err := f.service.ListCollections(t.Context(), f.outsider)
	if err != nil || len(listed) != 0 {
		t.Fatalf("outsider collections = %+v, err = %v", listed, err)
	}
}

func (f fixture) startRun(t *testing.T, agentID string, config map[string]any) (string, string) {
	t.Helper()
	runID, callID := uuid.NewString(), uuid.NewString()
	encoded, _ := json.Marshal(config)
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO agent_runs(id,org_id,agent_id,chat_id,correlation_id,status,lease_token,lease_expires_at,started_at,timeout_at,agent_config)
		VALUES($1,$2,$3,$4,$5,'running',$6,now()+interval '1 minute',now(),now()+interval '5 minutes',$7)`,
		runID, f.orgID, agentID, f.chatID, uuid.NewString(), uuid.NewString(), encoded); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO agent_tool_calls(id,org_id,agent_id,run_id,correlation_id,tool_name,mode,required_scope) VALUES($1,$2,$3,$4,$5,'search_knowledge','read','knowledge:read')`,
		callID, f.orgID, agentID, runID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	return runID, callID
}

func TestAgentSeesOnlyBoundCollectionsAndDeletionRemovesFragments(t *testing.T) {
	f := newFixture(t, nil, nil)
	bound, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Регламенты"})
	if err != nil {
		t.Fatal(err)
	}
	unbound, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Бухгалтерия"})
	if err != nil {
		t.Fatal(err)
	}
	policy, err := f.service.CreateDocument(t.Context(), f.owner, bound.ID, CreateDocumentInput{Kind: "page", Title: "Правила", Body: policyMarkdown})
	if err != nil {
		t.Fatal(err)
	}
	f.index(t, policy)
	payroll, err := f.service.CreateDocument(t.Context(), f.owner, unbound.ID, CreateDocumentInput{Kind: "page", Title: "Выплаты", Body: "Отпускные начисляются за три дня до отпуска."})
	if err != nil {
		t.Fatal(err)
	}
	f.index(t, payroll)
	if _, err := f.pool.Exec(t.Context(), `UPDATE agents SET knowledge_collection_ids=ARRAY[$1::uuid] WHERE actor_id=$2`, bound.ID, f.agentID); err != nil {
		t.Fatal(err)
	}

	// An agent without bindings sees nothing, even though both collections
	// are open to every member of the organization.
	runID, callID := f.startRun(t, f.otherID, map[string]any{})
	result, err := f.service.SearchForAgent(t.Context(), AgentSearchInput{OrgID: f.orgID, AgentID: f.otherID, RunID: runID, ToolCallID: callID, Query: "отпуск"})
	if err != nil || len(result.Fragments) != 0 {
		t.Fatalf("unbound agent search = %+v, err = %v", result, err)
	}

	// The bound agent sees its collection only; the run snapshot wins over
	// the live binding, so a draft under test uses its own set.
	runID, callID = f.startRun(t, f.agentID, map[string]any{})
	result, err = f.service.SearchForAgent(t.Context(), AgentSearchInput{OrgID: f.orgID, AgentID: f.agentID, RunID: runID, ToolCallID: callID, Query: "отпуск"})
	if err != nil || len(result.Fragments) == 0 {
		t.Fatalf("bound agent search = %+v, err = %v", result, err)
	}
	for _, fragment := range result.Fragments {
		if fragment.CollectionID != bound.ID {
			t.Fatalf("agent received a fragment from an unbound collection: %+v", fragment)
		}
	}
	draftRun, draftCall := f.startRun(t, f.agentID, map[string]any{"knowledge_collection_ids": []string{unbound.ID}})
	draft, err := f.service.SearchForAgent(t.Context(), AgentSearchInput{OrgID: f.orgID, AgentID: f.agentID, RunID: draftRun, ToolCallID: draftCall, Query: "отпуск"})
	if err != nil || len(draft.Fragments) != 1 || draft.Fragments[0].DocumentID != payroll.ID {
		t.Fatalf("draft snapshot search = %+v, err = %v", draft, err)
	}

	issued, err := f.service.RunFragments(t.Context(), f.orgID, runID)
	if err != nil || len(issued) != len(result.Fragments) || issued[0].ToolCallID != callID || issued[0].Rank != 1 || !issued[0].Available || issued[0].DocumentTitle != "Правила" {
		t.Fatalf("issued fragments = %+v, err = %v", issued, err)
	}

	if err := f.service.DeleteDocument(t.Context(), f.member, policy.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member delete err = %v", err)
	}
	if err := f.service.DeleteDocument(t.Context(), f.owner, policy.ID); err != nil {
		t.Fatal(err)
	}
	var chunks int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM knowledge_chunks WHERE document_id=$1`, policy.ID).Scan(&chunks); err != nil || chunks != 0 {
		t.Fatalf("chunks after delete = %d, err = %v", chunks, err)
	}
	after, err := f.service.Search(t.Context(), f.owner, SearchInput{Query: "заявление", CollectionIDs: []string{bound.ID}})
	if err != nil || len(after.Fragments) != 0 {
		t.Fatalf("search after delete = %+v, err = %v", after, err)
	}
	issued, err = f.service.RunFragments(t.Context(), f.orgID, runID)
	if err != nil || len(issued) == 0 || issued[0].Available {
		t.Fatalf("audit trail after delete = %+v, err = %v", issued, err)
	}

	// Deleting a collection unbinds it from agents.
	if err := f.service.DeleteCollection(t.Context(), f.owner, bound.ID); err != nil {
		t.Fatal(err)
	}
	var remaining []string
	if err := f.pool.QueryRow(t.Context(), `SELECT knowledge_collection_ids::text[] FROM agents WHERE actor_id=$1`, f.agentID).Scan(&remaining); err != nil || len(remaining) != 0 {
		t.Fatalf("agent bindings after collection delete = %v, err = %v", remaining, err)
	}
}

func TestPageEditReindexesAndFailedExtractionIsReported(t *testing.T) {
	f := newFixture(t, nil, nil)
	collection, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Памятки"})
	if err != nil {
		t.Fatal(err)
	}
	page, err := f.service.CreateDocument(t.Context(), f.owner, collection.ID, CreateDocumentInput{Kind: "page", Title: "Памятка", Body: "Пропуск выдаёт охрана."})
	if err != nil {
		t.Fatal(err)
	}
	f.index(t, page)
	body := "Пропуск выдаёт администратор на ресепшене."
	updated, err := f.service.UpdateDocument(t.Context(), f.owner, page.ID, UpdateDocumentInput{Body: &body})
	if err != nil || updated.ContentVersion != 2 || updated.Status != "pending" || updated.Body == nil || *updated.Body != body {
		t.Fatalf("updated page = %+v, err = %v", updated, err)
	}
	// A stale job for version 1 must not overwrite the newer content.
	if err := f.service.IndexDocument(t.Context(), page.ID, 1); err != nil {
		t.Fatal(err)
	}
	f.index(t, updated)
	result, err := f.service.Search(t.Context(), f.owner, SearchInput{Query: "ресепшене"})
	if err != nil || len(result.Fragments) != 1 {
		t.Fatalf("search after edit = %+v, err = %v", result, err)
	}
	if stale, _ := f.service.Search(t.Context(), f.owner, SearchInput{Query: "охрана"}); len(stale.Fragments) != 0 {
		t.Fatalf("stale fragments remain: %+v", stale)
	}

	scan := f.upload(t, f.owner, "scan.pdf", "application/pdf", []byte("%PDF-1.4\n%%EOF\n"))
	document, err := f.service.CreateDocument(t.Context(), f.owner, collection.ID, CreateDocumentInput{Kind: "file", FileID: scan})
	if err != nil {
		t.Fatal(err)
	}
	f.index(t, document)
	failed, err := f.service.GetDocument(t.Context(), f.owner, document.ID)
	if err != nil || failed.Status != "failed" || failed.ErrorCode != "no_text_extracted" {
		t.Fatalf("scanned PDF document = %+v, err = %v", failed, err)
	}
}

// keywordEmbedder places texts on axes by topic so that an English query can
// find Russian text, which full-text search alone cannot do.
type fakeResolver struct{ endpoint string }

func (resolver fakeResolver) EmbeddingConnection(_ context.Context, _, connectionID string) (agentconfig.EmbeddingConnection, error) {
	return agentconfig.EmbeddingConnection{ID: connectionID, Provider: "openai-compatible", EndpointURL: resolver.endpoint, Model: "test-embed", APIKey: "test-key"}, nil
}

func keywordVector(text string) []float32 {
	text = strings.ToLower(text)
	topics := [][]string{{"отпуск", "vacation", "leave"}, {"смен", "передаёт", "handover"}, {"пропуск", "badge"}}
	vector := make([]float32, len(topics)+1)
	vector[len(topics)] = 0.05
	for index, words := range topics {
		for _, word := range words {
			if strings.Contains(text, word) {
				vector[index] = 1
			}
		}
	}
	return vector
}

func TestEmbeddingsAddSemanticMatches(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/v1/embeddings" || r.Header.Get("Authorization") != "Bearer test-key" {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		var payload struct {
			Model string   `json:"model"`
			Input []string `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.Model != "test-embed" {
			http.Error(w, "bad payload", http.StatusBadRequest)
			return
		}
		data := make([]map[string]any, len(payload.Input))
		for index, input := range payload.Input {
			data[index] = map[string]any{"index": index, "embedding": keywordVector(input)}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
	}))
	defer server.Close()
	f := newFixture(t, fakeResolver{endpoint: server.URL + "/v1"}, NewHTTPEmbedder())
	connectionID := uuid.NewString()
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO agent_llm_connections(id,org_id,name,provider,endpoint_url,nonce,ciphertext,key_hint,created_by,updated_by,embedding_model,embedding_data_sharing_approved)
		VALUES($1,$2,'Local','openai-compatible',$3,$4,$5,'••••',$6,$6,'test-embed',true)`, connectionID, f.orgID, server.URL+"/v1", make([]byte, 12), make([]byte, 16), f.owner.ActorID); err != nil {
		t.Fatal(err)
	}
	collection, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Регламенты", EmbeddingConnectionID: &connectionID})
	if err != nil {
		t.Fatal(err)
	}
	document, err := f.service.CreateDocument(t.Context(), f.owner, collection.ID, CreateDocumentInput{Kind: "page", Title: "Правила", Body: policyMarkdown})
	if err != nil {
		t.Fatal(err)
	}
	f.index(t, document)
	var embedJobs int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM river_job WHERE kind='knowledge.embed' AND args->>'document_id'=$1`, document.ID).Scan(&embedJobs); err != nil || embedJobs != 1 {
		t.Fatalf("embed jobs = %d, err = %v", embedJobs, err)
	}
	if err := f.service.EmbedDocument(t.Context(), document.ID, 1); err != nil {
		t.Fatal(err)
	}
	embedded, err := f.service.GetDocument(t.Context(), f.owner, document.ID)
	if err != nil || embedded.EmbeddingStatus != "ready" {
		t.Fatalf("embedded document = %+v, err = %v", embedded, err)
	}
	var vectors int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM knowledge_chunks WHERE document_id=$1 AND embedding IS NOT NULL AND embedding_dimensions=4`, document.ID).Scan(&vectors); err != nil || vectors != 3 {
		t.Fatalf("embedded chunks = %d, err = %v", vectors, err)
	}

	// "vacation" never occurs in the Russian text, so only vectors find it.
	result, err := f.service.Search(t.Context(), f.member, SearchInput{Query: "vacation request"})
	if err != nil || !result.Semantic || len(result.Fragments) == 0 || result.Fragments[0].Section != "Правила центра › Отпуска" || result.Fragments[0].Match != "semantic" {
		t.Fatalf("semantic search = %+v, err = %v", result, err)
	}
	hybrid, err := f.service.Search(t.Context(), f.member, SearchInput{Query: "отпуск"})
	if err != nil || len(hybrid.Fragments) == 0 || hybrid.Fragments[0].Match != "hybrid" {
		t.Fatalf("hybrid search = %+v, err = %v", hybrid, err)
	}

	// Removing the connection drops vectors and returns to word search.
	if _, err := f.service.UpdateCollection(t.Context(), f.owner, collection.ID, UpdateCollectionInput{EmbeddingConnectionID: OptionalID{Set: true}}); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM knowledge_chunks WHERE document_id=$1 AND embedding IS NOT NULL`, document.ID).Scan(&vectors); err != nil || vectors != 0 {
		t.Fatalf("vectors after unlinking = %d, err = %v", vectors, err)
	}
	plain, err := f.service.Search(t.Context(), f.member, SearchInput{Query: "vacation request"})
	if err != nil || plain.Semantic || len(plain.Fragments) != 0 {
		t.Fatalf("search without embeddings = %+v, err = %v", plain, err)
	}
}

func TestSourceFileFollowsCollectionReadAccess(t *testing.T) {
	f := newFixture(t, nil, nil)
	shared, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Инструкторам", Access: "chats", ChatIDs: []string{f.chatID}})
	if err != nil {
		t.Fatal(err)
	}
	open, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Всем"})
	if err != nil {
		t.Fatal(err)
	}
	// The librarian uploads; nobody else is the uploader or shares a chat
	// message with the file, so only collection access can open it.
	restrictedFile := f.upload(t, f.librarian, "warmup.md", "text/markdown", []byte("# Разминка\n\nДесять минут перед занятием."))
	restricted, err := f.service.CreateDocument(t.Context(), f.librarian, shared.ID, CreateDocumentInput{Kind: "file", FileID: restrictedFile})
	if err != nil {
		t.Fatal(err)
	}
	openFile := f.upload(t, f.librarian, "badge.txt", "text/plain", []byte("Пропуск выдаёт администратор."))
	public, err := f.service.CreateDocument(t.Context(), f.librarian, open.ID, CreateDocumentInput{Kind: "file", FileID: openFile})
	if err != nil {
		t.Fatal(err)
	}
	page, err := f.service.CreateDocument(t.Context(), f.librarian, open.ID, CreateDocumentInput{Kind: "page", Title: "Памятка", Body: "Текст памятки"})
	if err != nil {
		t.Fatal(err)
	}
	read := func(user identity.User, documentID string) (string, error) {
		download, err := f.service.DocumentSource(t.Context(), user, documentID)
		if err != nil {
			return "", err
		}
		if download.Reader == nil {
			t.Fatalf("local storage must stream the source")
		}
		defer download.Reader.Close()
		data, err := io.ReadAll(download.Reader)
		return string(data), err
	}
	// The file layer alone would refuse these readers.
	if _, err := f.files.Download(t.Context(), f.member, restrictedFile); !errors.Is(err, files.ErrNotFound) {
		t.Fatalf("plain file download by a reader err = %v", err)
	}
	for _, reader := range []identity.User{f.member, f.owner, f.librarian} {
		if body, err := read(reader, restricted.ID); err != nil || !strings.Contains(body, "Десять минут") {
			t.Fatalf("restricted source for %s = %q, err = %v", reader.ActorID, body, err)
		}
	}
	if _, err := read(f.outsider, restricted.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider restricted source err = %v", err)
	}
	if body, err := read(f.outsider, public.ID); err != nil || body != "Пропуск выдаёт администратор." {
		t.Fatalf("organization-wide source = %q, err = %v", body, err)
	}
	if _, err := read(f.otherOwner, public.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign organization source err = %v", err)
	}
	if _, err := read(f.member, page.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("page source err = %v", err)
	}

	// Removing the chat from the collection revokes the member's access.
	if _, err := f.service.UpdateCollection(t.Context(), f.owner, shared.ID, UpdateCollectionInput{Access: ptr("organization")}); err != nil {
		t.Fatal(err)
	}
	if _, err := read(f.outsider, restricted.ID); err != nil {
		t.Fatalf("source after opening the collection err = %v", err)
	}
	other := uuid.NewString()
	tx, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($1,$2,'group','private','Doctors',$3)`, other, f.orgID, f.owner.ActorID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'owner')`, other, f.owner.ActorID, f.orgID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.UpdateCollection(t.Context(), f.owner, shared.ID, UpdateCollectionInput{Access: ptr("chats"), ChatIDs: &[]string{other}}); err != nil {
		t.Fatal(err)
	}
	if _, err := read(f.member, restricted.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("source after unsharing the chat err = %v", err)
	}
}

func TestDocumentFragmentsAndEmbeddingOptions(t *testing.T) {
	f := newFixture(t, nil, nil)
	ready, pending := uuid.NewString(), uuid.NewString()
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO agent_llm_connections(id,org_id,name,provider,endpoint_url,nonce,ciphertext,key_hint,created_by,updated_by,embedding_model,embedding_data_sharing_approved)
		VALUES($1,$3,'Approved','openai-compatible','https://llm.example.test/v1',$4,$5,'••••',$6,$6,'embed-small',true),
		      ($2,$3,'Not approved','openai','',$4,$5,'••••',$6,$6,'text-embedding-3-small',false)`,
		ready, pending, f.orgID, make([]byte, 12), make([]byte, 16), f.owner.ActorID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.EmbeddingConnections(t.Context(), f.member); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member embedding options err = %v", err)
	}
	options, err := f.service.EmbeddingConnections(t.Context(), f.librarian)
	if err != nil || len(options) != 2 || options[0].ID != ready || !options[0].Available || options[1].Available || options[1].DataSharingApproved {
		t.Fatalf("embedding options = %+v, err = %v", options, err)
	}
	semantic, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Смысл", EmbeddingConnectionID: &ready})
	if err != nil || !semantic.SemanticSearch {
		t.Fatalf("semantic collection = %+v, err = %v", semantic, err)
	}
	words, err := f.service.CreateCollection(t.Context(), f.owner, CreateCollectionInput{Name: "Слова", EmbeddingConnectionID: &pending})
	if err != nil || words.SemanticSearch {
		t.Fatalf("unapproved collection = %+v, err = %v", words, err)
	}
	// Readers learn the search mode without seeing the connection.
	visible, err := f.service.GetCollection(t.Context(), f.member, semantic.ID)
	if err != nil || !visible.SemanticSearch || visible.EmbeddingConnectionID != nil {
		t.Fatalf("reader view = %+v, err = %v", visible, err)
	}

	page, err := f.service.CreateDocument(t.Context(), f.owner, words.ID, CreateDocumentInput{Kind: "page", Title: "Правила", Body: policyMarkdown})
	if err != nil {
		t.Fatal(err)
	}
	f.index(t, page)
	fragments, err := f.service.DocumentFragments(t.Context(), f.member, page.ID)
	if err != nil || fragments.Truncated || len(fragments.Fragments) != 3 || fragments.Fragments[1].Section != "Правила центра › Отпуска" || fragments.Fragments[1].Position != 1 {
		t.Fatalf("fragments = %+v, err = %v", fragments, err)
	}
	if _, err := f.service.DocumentFragments(t.Context(), f.otherOwner, page.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign fragments err = %v", err)
	}
}

func ptr(value string) *string { return &value }
