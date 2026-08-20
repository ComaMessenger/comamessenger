package chat

import (
	"context"
	"errors"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

func TestWorkspaceChatModeratorManagesNonOwnedChats(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	orgID := chatTestID(t)
	workspaceOwnerID := chatTestID(t)
	chatOwnerID := chatTestID(t)
	moderatorID := chatTestID(t)
	adminID := chatTestID(t)
	targetID := chatTestID(t)
	groupID := chatTestID(t)
	directID := chatTestID(t)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO organizations(id,name,slug) VALUES($1,'Moderation','moderation')`, orgID); err != nil {
		t.Fatal(err)
	}
	actors := []struct {
		id, role, handle string
	}{
		{workspaceOwnerID, "owner", "workspace-owner"},
		{chatOwnerID, "member", "chat-owner"},
		{moderatorID, "admin", "moderator"},
		{adminID, "admin", "plain-admin"},
		{targetID, "member", "target-member"},
	}
	for _, actor := range actors {
		if _, err := tx.Exec(ctx, `
			INSERT INTO actors(id,org_id,type,org_role,display_name,handle)
			VALUES($1,$2,'user',$3,$4,$5)`, actor.id, orgID, actor.role, actor.handle, actor.handle); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO actor_permissions(org_id,actor_id,permission,granted_by)
		VALUES($1,$2,'chats.moderate',$3)`, orgID, moderatorID, workspaceOwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO chats(id,org_id,kind,visibility,name,direct_pair_key,created_by)
		VALUES($1,$2,'group','private','Private group',NULL,$3),
		      ($4,$2,'direct','private',NULL,$5,$3)`,
		groupID, orgID, chatOwnerID, directID, chatOwnerID+":"+targetID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO chat_members(chat_id,actor_id,org_id,role)
		VALUES($1,$2,$3,'owner'),($4,$2,$3,'member'),($4,$5,$3,'member')`,
		groupID, chatOwnerID, orgID, directID, targetID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool)
	moderator := identity.User{
		ActorID: moderatorID, OrgID: orgID, OrgRole: "admin", Status: "active",
		Permissions: []permission.Code{permission.ChatsModerate},
	}
	plainAdmin := identity.User{ActorID: adminID, OrgID: orgID, OrgRole: "admin", Status: "active", Permissions: []permission.Code{}}

	if _, err := service.ListMembers(ctx, plainAdmin, groupID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("plain admin ListMembers() error = %v, want ErrNotFound", err)
	}
	if err := service.Archive(ctx, plainAdmin, groupID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("plain admin Archive() error = %v, want ErrNotFound", err)
	}
	members, err := service.ListMembers(ctx, moderator, groupID)
	if err != nil || len(members) != 1 || members[0].ActorID != chatOwnerID {
		t.Fatalf("moderator ListMembers() = %+v, %v", members, err)
	}
	if _, err := service.AddMember(ctx, moderator, groupID, MemberInput{ActorID: targetID, Role: "owner"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator AddMember(owner) error = %v, want ErrForbidden", err)
	}
	added, err := service.AddMember(ctx, moderator, groupID, MemberInput{ActorID: targetID, Role: "member"})
	if err != nil || added.Role != "member" {
		t.Fatalf("moderator AddMember() = %+v, %v", added, err)
	}
	updated, err := service.UpdateMember(ctx, moderator, groupID, targetID, UpdateMemberInput{Role: "admin"})
	if err != nil || updated.Role != "admin" {
		t.Fatalf("moderator UpdateMember() = %+v, %v", updated, err)
	}
	if _, err := service.UpdateMember(ctx, moderator, groupID, chatOwnerID, UpdateMemberInput{Role: "member"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator UpdateMember(chat owner) error = %v, want ErrForbidden", err)
	}
	if err := service.RemoveMember(ctx, moderator, groupID, chatOwnerID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator RemoveMember(chat owner) error = %v, want ErrForbidden", err)
	}
	if err := service.RemoveMember(ctx, moderator, groupID, targetID); err != nil {
		t.Fatalf("moderator RemoveMember() error = %v", err)
	}
	if err := service.Archive(ctx, moderator, directID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("moderator Archive(direct) error = %v, want ErrNotFound", err)
	}
	if err := service.Archive(ctx, moderator, groupID); err != nil {
		t.Fatalf("moderator Archive(group) error = %v", err)
	}
	var auditCount int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM audit_log
		WHERE org_id=$1 AND actor_id=$2
		  AND action IN ('chat.member.add','chat.member.update','chat.member.remove','chat.archive')`,
		orgID, moderatorID).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 4 {
		t.Fatalf("moderation audit event count = %d, want 4", auditCount)
	}
}

func chatTestID(t *testing.T) string {
	t.Helper()
	value, err := id.New()
	if err != nil {
		t.Fatal(err)
	}
	return value
}
