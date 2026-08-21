package search

import (
	"errors"
	"sync"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

const (
	searchOrgID      = "00000000-0000-7000-8000-000000000101"
	searchOwnerID    = "00000000-0000-7000-8000-000000000102"
	searchMemberID   = "00000000-0000-7000-8000-000000000103"
	searchOutsiderID = "00000000-0000-7000-8000-000000000104"
	searchChatID     = "00000000-0000-7000-8000-000000000105"
	searchMessageRU  = "00000000-0000-7000-8000-000000000106"
	searchMessageEN  = "00000000-0000-7000-8000-000000000107"
	searchFileID     = "00000000-0000-7000-8000-000000000108"
)

func TestSearchRussianEnglishFilesPermissionsAndCursor(t *testing.T) {
	pool := testdb.New(t)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Search', 'search')`, searchOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO actors (id, org_id, type, org_role, display_name, handle) VALUES
		($1,$4,'user','owner','Owner','owner'),
		($2,$4,'user','member','Member','member'),
		($3,$4,'user','member','Outsider','outsider')`, searchOwnerID, searchMemberID, searchOutsiderID, searchOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO chats (id,org_id,kind,visibility,name,created_by) VALUES ($1,$2,'group','private','Private',$3)`, searchChatID, searchOrgID, searchOwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES
		($1,$2,$4,'owner'),($1,$3,$4,'member')`, searchChatID, searchOwnerID, searchMemberID, searchOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO messages(id,org_id,chat_id,actor_id,client_msg_id,create_fingerprint,body,created_seq) VALUES
		($1,$3,$4,$5,'00000000-0000-7000-8000-000000000111',decode(repeat('00',32),'hex'),'Обсуждаем важные сообщения архитектуры',1),
		($2,$3,$4,$5,'00000000-0000-7000-8000-000000000112',decode(repeat('01',32),'hex'),'Workers are running reliable searches',2)`,
		searchMessageRU, searchMessageEN, searchOrgID, searchChatID, searchOwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO files(id,org_id,uploader_id,storage_driver,storage_key,name,mime,size,status,processing_status,extracted_text,ready_at)
		VALUES($1,$2,$3,'local','objects/search/document','architecture.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,'ready','ready','Документ про надёжные сообщения и reliable searchable design',now())`, searchFileID, searchOrgID, searchOwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO message_files(message_id,file_id,org_id,ordinal) VALUES($1,$2,$3,0)`, searchMessageEN, searchFileID, searchOrgID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool)
	member := identity.User{ActorID: searchMemberID, OrgID: searchOrgID}
	russian, err := service.Search(t.Context(), member, Input{Query: "сообщение", Type: "all", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(russian.Results) != 2 {
		t.Fatalf("Russian results = %#v", russian.Results)
	}
	english, err := service.Search(t.Context(), member, Input{Query: "reliable", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(english.Results) != 1 || english.NextCursor == nil {
		t.Fatalf("first cursor page = %#v", english)
	}
	next, err := service.Search(t.Context(), member, Input{Query: "reliable", Limit: 1, Cursor: *english.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Results) != 1 || next.Results[0].MessageID == english.Results[0].MessageID && next.Results[0].Kind == english.Results[0].Kind {
		t.Fatalf("second cursor page = %#v", next)
	}
	outsider := identity.User{ActorID: searchOutsiderID, OrgID: searchOrgID}
	hidden, err := service.Search(t.Context(), outsider, Input{Query: "сообщение", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hidden.Results) != 0 {
		t.Fatalf("private results disclosed to outsider: %#v", hidden.Results)
	}
	if _, err := service.Search(t.Context(), member, Input{Query: "reliable", Limit: 1, Cursor: *english.NextCursor, Type: "file"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cursor reuse with changed filters error = %v", err)
	}
	embeddings := NewEmbeddingWriter(pool)
	if err := embeddings.Upsert(t.Context(), searchMessageEN, "test-provider", "test-model", []float32{0.25, -0.5, 1}); err != nil {
		t.Fatal(err)
	}
	var dimensions int
	var vector string
	if err := pool.QueryRow(t.Context(), `SELECT dimensions, embedding::text FROM message_embeddings WHERE message_id=$1`, searchMessageEN).Scan(&dimensions, &vector); err != nil {
		t.Fatal(err)
	}
	if dimensions != 3 || vector != "[0.25,-0.5,1]" {
		t.Fatalf("stored embedding dimensions=%d vector=%q", dimensions, vector)
	}
	if err := embeddings.Delete(t.Context(), searchMessageEN, "test-provider", "test-model"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE messages SET body='removed term' WHERE id=$1`, searchMessageEN); err != nil {
		t.Fatal(err)
	}
	afterEdit, err := service.Search(t.Context(), member, Input{Query: "running", Type: "message", Limit: 10})
	if err != nil || len(afterEdit.Results) != 0 {
		t.Fatalf("stale index after edit = %#v, err=%v", afterEdit.Results, err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE messages SET deleted_at=now() WHERE id=$1`, searchMessageRU); err != nil {
		t.Fatal(err)
	}
	afterDelete, err := service.Search(t.Context(), member, Input{Query: "архитектура", Limit: 10})
	if err != nil || len(afterDelete.Results) != 0 {
		t.Fatalf("deleted message result = %#v, err=%v", afterDelete.Results, err)
	}
}

func TestSearchLoadAtTargetVolume(t *testing.T) {
	pool := testdb.New(t)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Search load', 'search-load')`, searchOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO actors (id,org_id,type,org_role,display_name,handle) VALUES ($1,$2,'user','owner','Load owner','load-owner')`, searchOwnerID, searchOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO chats (id,org_id,kind,visibility,name,created_by) VALUES ($1,$2,'group','private','Load chat',$3)`, searchChatID, searchOrgID, searchOwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'owner')`, searchChatID, searchOwnerID, searchOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO messages(id,org_id,chat_id,actor_id,client_msg_id,create_fingerprint,body,created_seq)
		SELECT md5('load-message-' || value)::uuid, $1, $2, $3,
		       md5('load-client-' || value)::uuid, decode(repeat('00',32),'hex'),
		       'capacitytoken searchable message ' || value, value
		FROM generate_series(1, 10000) AS generated(value)`, searchOrgID, searchChatID, searchOwnerID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool)
	user := identity.User{ActorID: searchOwnerID, OrgID: searchOrgID}
	const workers = 8
	const queriesPerWorker = 10
	errorsFound := make(chan error, workers)
	var wait sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for query := 0; query < queriesPerWorker; query++ {
				page, err := service.Search(t.Context(), user, Input{Query: "capacitytoken", ChatID: searchChatID, Limit: 100})
				if err != nil {
					errorsFound <- err
					return
				}
				if len(page.Results) != 100 || page.NextCursor == nil {
					errorsFound <- errors.New("load search returned an incomplete page")
					return
				}
			}
		}()
	}
	wait.Wait()
	close(errorsFound)
	for err := range errorsFound {
		t.Fatal(err)
	}
}
