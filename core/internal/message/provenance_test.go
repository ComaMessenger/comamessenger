package message

import (
	"context"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

// TestAgentMessageProvenanceAndChatRoles checks that an agent message says
// why the agent ran (trigger kind and a builder-set label, never the webhook
// payload), that a document source keeps the exact fragment with a position
// from Core, and that an agent cannot post to a chat it only reads.
func TestAgentMessageProvenanceAndChatRoles(t *testing.T) {
	pool := testdb.New(t)
	service := NewService(pool, 64*1024, 100, nil)
	fixture := seedFixture(t, pool)
	ctx := context.Background()
	agentID, webhookID, triggerID, runID := mustID(t), mustID(t), mustID(t), mustID(t)
	collectionID, documentID, chunkID := mustID(t), mustID(t), mustID(t)
	orgID := fixture.owner.OrgID
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'agent','member','Handover','handover')`, []any{agentID, orgID}},
		{`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes,published_version,read_only_chat_ids) VALUES($1,$2,$3,'builtin',true,ARRAY['messages:write'],1,ARRAY[$4::uuid])`, []any{agentID, orgID, fixture.owner.ActorID, fixture.channelID}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$3,$4,'member'),($2,$3,$4,'member')`, []any{fixture.groupID, fixture.channelID, agentID, orgID}},
		{`INSERT INTO integration_webhooks(id,org_id,name,secret_nonce,secret_ciphertext,secret_hint,created_by,updated_by)
			VALUES($1,$2,'Accounting slots',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'••••',$3,$3)`, []any{webhookID, orgID, fixture.owner.ActorID}},
		{`INSERT INTO agent_triggers(id,org_id,agent_id,type,config,enabled) VALUES($1,$2,$3,'webhook',jsonb_build_object('webhook_id',$4::text,'chat_id',$5::text),true)`, []any{triggerID, orgID, agentID, webhookID, fixture.groupID}},
		{`INSERT INTO agent_runs(id,org_id,agent_id,trigger_id,correlation_id,chat_id,input) VALUES($1,$2,$3,$4,gen_random_uuid(),$5,
			'{"trigger_type":"webhook","payload":{"secret_note":"do not show"}}')`, []any{runID, orgID, agentID, triggerID, fixture.groupID}},
		{`INSERT INTO knowledge_collections(id,org_id,name,created_by,updated_by) VALUES($1,$2,'Rules',$3,$3)`, []any{collectionID, orgID, fixture.owner.ActorID}},
		{`INSERT INTO knowledge_documents(id,org_id,collection_id,kind,title,body,created_by,updated_by) VALUES($1,$2,$3,'page','Handover rules','Pass the hall keys.',$4,$4)`, []any{documentID, orgID, collectionID, fixture.owner.ActorID}},
		{`INSERT INTO knowledge_chunks(id,org_id,collection_id,document_id,position,content) VALUES($1,$2,$3,$4,7,'Pass the hall keys to the next instructor.')`, []any{chunkID, orgID, collectionID, documentID}},
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	agent := identity.User{ActorID: agentID, OrgID: orgID, OrgRole: "member", Status: "active"}
	wrong := 99
	created, _, err := service.CreateForAgentRun(ctx, agent, fixture.groupID, CreateInput{ClientMsgID: mustID(t), Body: "Keys are with Vera.", BodyFormat: "plain",
		Blocks: &Blocks{Version: BlocksVersion, Sources: []Source{{Kind: "document", DocumentID: documentID, ChunkID: chunkID, Position: &wrong}}}}, AgentProvenance{RunID: runID})
	if err != nil {
		t.Fatal(err)
	}
	// The webhook name is configuration, not something the chat should learn.
	if created.AgentProvenance == nil || created.AgentProvenance.Trigger != "webhook" || created.AgentProvenance.TriggerLabel != "" || created.AgentProvenance.RunID != runID {
		t.Fatalf("provenance = %+v", created.AgentProvenance)
	}
	if source := created.Blocks.Sources[0]; source.ChunkID != chunkID || source.Position == nil || *source.Position != 7 {
		t.Fatalf("source = %+v", source)
	}
	page, err := service.List(ctx, fixture.member, fixture.groupID, ListOptions{})
	if err != nil || len(page.Messages) < 1 || page.Messages[len(page.Messages)-1].AgentProvenance == nil || page.Messages[len(page.Messages)-1].AgentProvenance.Trigger != "webhook" {
		t.Fatalf("listed = %+v, err=%v", page.Messages, err)
	}
	// The label is recorded when the message is written: editing the rule
	// later does not rewrite old messages.
	scheduleID, scheduleRun := mustID(t), mustID(t)
	if _, err := pool.Exec(ctx, `INSERT INTO agent_triggers(id,org_id,agent_id,type,config,enabled,timezone,next_run_at) VALUES($1,$2,$3,'schedule','{"chat_id":"`+fixture.groupID+`","hour":9,"minute":0}',true,'Europe/Moscow',now())`, scheduleID, orgID, agentID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO agent_runs(id,org_id,agent_id,trigger_id,correlation_id,chat_id,input) VALUES($1,$2,$3,$4,gen_random_uuid(),$5,'{"trigger_type":"schedule"}')`, scheduleRun, orgID, agentID, scheduleID, fixture.groupID); err != nil {
		t.Fatal(err)
	}
	daily, _, err := service.CreateForAgentRun(ctx, agent, fixture.groupID, CreateInput{ClientMsgID: mustID(t), Body: "Итоги", BodyFormat: "plain"}, AgentProvenance{RunID: scheduleRun})
	if err != nil || daily.AgentProvenance == nil || daily.AgentProvenance.TriggerLabel != "09:00 Europe/Moscow" {
		t.Fatalf("schedule provenance = %+v err=%v", daily.AgentProvenance, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE agent_triggers SET config=jsonb_set(config,'{hour}','18') WHERE id=$1`, scheduleID); err != nil {
		t.Fatal(err)
	}
	reread, err := service.Get(ctx, fixture.member, daily.ID)
	if err != nil || reread.AgentProvenance == nil || reread.AgentProvenance.TriggerLabel != "09:00 Europe/Moscow" {
		t.Fatalf("provenance after the rule changed = %+v err=%v", reread.AgentProvenance, err)
	}
	other := mustID(t)
	if _, _, err := service.CreateForAgentRun(ctx, agent, fixture.groupID, CreateInput{ClientMsgID: mustID(t), Body: "x", BodyFormat: "plain",
		Blocks: &Blocks{Version: BlocksVersion, Sources: []Source{{Kind: "document", DocumentID: documentID, ChunkID: other}}}}, AgentProvenance{RunID: runID}); err == nil {
		t.Fatal("a fragment of another document was accepted")
	}
	if _, _, err := service.CreateForAgentRun(ctx, agent, fixture.channelID, CreateInput{ClientMsgID: mustID(t), Body: "x", BodyFormat: "plain"}, AgentProvenance{RunID: runID}); err != ErrForbidden {
		t.Fatalf("post to a read-only chat error = %v", err)
	}
}
