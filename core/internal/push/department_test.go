package push

import (
	"context"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/google/uuid"
)

// @department notifies, in a chat set to «mentions only», exactly the
// people of the department who are in the chat: not the author, not a
// member of the chat outside the department, and nobody outside the chat.
func TestDepartmentMentionPushRecipients(t *testing.T) {
	w := newFailurePushWorld(t)
	ctx := context.Background()
	outsiderID, outsiderSession, outsiderSub := uuid.NewString(), uuid.NewString(), uuid.NewString()
	hallID := uuid.NewString()
	w.exec(t, `INSERT INTO actors(id,org_id,type,org_role,display_name,handle,timezone) VALUES ($2,$1,'user','member','Outsider','outsider','UTC')`, w.orgID, outsiderID)
	w.exec(t, `INSERT INTO users(actor_id,org_id,email,password_hash,preferences) VALUES ($2,$1,'outsider@example.test','hash','{"push_preview":true}')`, w.orgID, outsiderID)
	w.exec(t, `INSERT INTO sessions(id,org_id,actor_id,family_id,refresh_hash,expires_at) VALUES($3,$1,$2,$3,decode(repeat('03',32),'hex'),now()+interval '1 day')`, w.orgID, outsiderID, outsiderSession)
	w.exec(t, `INSERT INTO web_push_subscriptions(id,org_id,actor_id,session_id,endpoint,p256dh,auth) VALUES($4,$1,$2,$3,'https://push.example.test/x','0123456789abcdef','0123456789abcdef')`, w.orgID, outsiderID, outsiderSession, outsiderSub)
	w.exec(t, `INSERT INTO departments (org_id, id, name) VALUES ($1, $2, 'Зал ЛФК')`, w.orgID, hallID)
	// The author of the push world is the person in the department and in
	// the chat; «other» writes and is in the department too.
	w.exec(t, `INSERT INTO department_members (org_id, department_id, actor_id, is_primary) VALUES ($1,$2,$3,true),($1,$2,$4,true),($1,$2,$5,true)`,
		w.orgID, hallID, w.author.User.ActorID, outsiderID, w.other.User.ActorID)
	w.exec(t, `UPDATE chat_members SET notify_level='mentions' WHERE chat_id=$1`, w.chatID)

	messages := message.NewService(w.pool, 1024, 100, nil)
	send := func() message.Message {
		t.Helper()
		created, _, err := messages.Create(ctx, w.other.User, w.chatID, message.CreateInput{
			ClientMsgID: uuid.NewString(), Body: "@[Зал ЛФК](" + hallID + ") планёрка", BodyFormat: "plain", MentionedDepartmentIDs: []string{hallID},
		})
		if err != nil {
			t.Fatal(err)
		}
		return created
	}
	created := send()
	w.materialize(t)
	web, mobile := w.deliveries(t, created.CreatedSeq)
	if len(web) != 1 || web[0] != w.authorSub || len(mobile) != 1 || mobile[0] != w.authorDev {
		t.Fatalf("department push: web=%v mobile=%v, want only %s / %s", web, mobile, w.authorSub, w.authorDev)
	}
	if n := w.count(t, `SELECT count(*) FROM notification_deliveries WHERE subscription_id=$1`, outsiderSub); n != 0 {
		t.Fatal("a member of the department outside the chat got a push")
	}

	// Out of the department: a «mentions only» member gets nothing.
	w.exec(t, `DELETE FROM department_members WHERE department_id=$1 AND actor_id=$2`, hallID, w.author.User.ActorID)
	created = send()
	w.materialize(t)
	if web, mobile := w.deliveries(t, created.CreatedSeq); len(web) != 0 || len(mobile) != 0 {
		t.Fatalf("push after leaving the department: web=%v mobile=%v", web, mobile)
	}
}
