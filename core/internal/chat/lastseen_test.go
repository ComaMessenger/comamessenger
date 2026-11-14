package chat

import (
	"context"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/lastseen"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

func TestLastSeenIsSharedOnlyWithinCommonChats(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	orgID, alice, bob, carol, moderatorID, agentID := chatTestID(t), chatTestID(t), chatTestID(t), chatTestID(t), chatTestID(t), chatTestID(t)
	directID, groupID := chatTestID(t), chatTestID(t)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	setup := func(query string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	setup(`INSERT INTO organizations(id,name,slug) VALUES($1,'Seen','seen')`, orgID)
	setup(`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES
		($1,$6,'user','owner','Alice','alice'),($2,$6,'user','member','Bob','bob'),($3,$6,'user','member','Carol','carol'),
		($4,$6,'user','admin','Moderator','moderator'),($5,$6,'agent','member','Helper','helper')`, alice, bob, carol, moderatorID, agentID, orgID)
	setup(`INSERT INTO users(actor_id,org_id,email,password_hash,last_seen_at) VALUES
		($1,$5,'a@seen.test','x',now()-interval '5 minutes'),($2,$5,'b@seen.test','x',now()-interval '5 minutes'),
		($3,$5,'c@seen.test','x',now()-interval '10 days'),($4,$5,'m@seen.test','x',now())`, alice, bob, carol, moderatorID, orgID)
	setup(`INSERT INTO actor_permissions(org_id,actor_id,permission,granted_by) VALUES($1,$2,'chats.moderate',$3)`, orgID, moderatorID, alice)
	setup(`INSERT INTO chats(id,org_id,kind,visibility,name,direct_pair_key,created_by) VALUES
		($1,$3,'direct','private',NULL,$4,$5),($2,$3,'group','private','Team',NULL,$5)`, directID, groupID, orgID, alice+":"+bob, alice)
	setup(`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES
		($1,$3,$2,'member'),($1,$4,$2,'member'),($5,$3,$2,'owner'),($5,$6,$2,'member'),($5,$7,$2,'member')`, directID, orgID, alice, bob, groupID, carol, agentID)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool)
	asAlice := identity.User{ActorID: alice, OrgID: orgID, OrgRole: "owner", Status: "active"}

	var direct Chat
	direct, err = service.Get(ctx, asAlice, directID)
	if err != nil || direct.DirectPeer == nil || direct.DirectPeer.LastSeenAt == nil || direct.DirectPeer.LastSeenApprox != nil {
		t.Fatalf("direct peer last seen = %+v, %v", direct.DirectPeer, err)
	}
	chats, err := service.List(ctx, asAlice)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range chats {
		if item.ID == directID && (item.DirectPeer == nil || item.DirectPeer.LastSeenAt == nil) {
			t.Fatalf("listed direct peer lacks last seen: %+v", item.DirectPeer)
		}
	}

	members, err := service.ListMembers(ctx, asAlice, groupID)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range members {
		switch member.ActorID {
		case carol:
			if member.LastSeenAt == nil {
				t.Fatal("group member lacks last seen")
			}
		case agentID:
			if member.LastSeenAt != nil || member.LastSeenApprox != nil {
				t.Fatal("agent got a last seen")
			}
		}
	}

	// An agent in the chat shares it, so it sees the same as a person.
	asAgent := identity.User{ActorID: agentID, OrgID: orgID, OrgRole: "member", Status: "active"}
	members, err = service.ListMembers(ctx, asAgent, groupID)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range members {
		if member.ActorID == carol && member.LastSeenAt == nil {
			t.Fatal("agent in the chat lacks last seen")
		}
	}

	// A moderator looking into a chat they are not in shares no chat.
	moderator := identity.User{ActorID: moderatorID, OrgID: orgID, OrgRole: "admin", Status: "active", Permissions: []permission.Code{permission.ChatsModerate}}
	members, err = service.ListMembers(ctx, moderator, groupID)
	if err != nil || len(members) == 0 {
		t.Fatalf("moderator ListMembers() = %+v, %v", members, err)
	}
	for _, member := range members {
		if member.LastSeenAt != nil || member.LastSeenApprox != nil {
			t.Fatalf("moderator outside the chat sees last seen of %s", member.ActorID)
		}
	}

	// "Nobody" leaves only an approximate time, both ways.
	exec(`UPDATE users SET preferences=preferences||'{"last_seen_visibility":"nobody"}' WHERE actor_id=$1`, bob)
	direct, _ = service.Get(ctx, asAlice, directID)
	if direct.DirectPeer.LastSeenAt != nil || direct.DirectPeer.LastSeenApprox == nil || *direct.DirectPeer.LastSeenApprox != lastseen.Recently {
		t.Fatalf("hidden peer = %+v", direct.DirectPeer)
	}
	exec(`UPDATE users SET preferences=preferences-'last_seen_visibility' WHERE actor_id=$1`, bob)
	exec(`UPDATE users SET preferences=preferences||'{"last_seen_visibility":"nobody"}' WHERE actor_id=$1`, alice)
	direct, _ = service.Get(ctx, asAlice, directID)
	if direct.DirectPeer.LastSeenAt != nil || direct.DirectPeer.LastSeenApprox == nil {
		t.Fatalf("viewer hiding their own time still sees the exact one: %+v", direct.DirectPeer)
	}
	members, _ = service.ListMembers(ctx, asAlice, groupID)
	for _, member := range members {
		if member.ActorID == carol && (member.LastSeenApprox == nil || *member.LastSeenApprox != lastseen.WithinMonth) {
			t.Fatalf("carol approx = %v", member.LastSeenApprox)
		}
	}
}
