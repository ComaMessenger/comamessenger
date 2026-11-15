package orgstructure

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/google/uuid"
)

func TestDepartmentChat(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	anna, boris, vera, gleb := f.staff[0], f.staff[1], f.staff[2], f.staff[3]
	root := f.department("Реабилитация", nil, primary(anna.ActorID))
	hall := f.department("Зал ЛФК", &root.ID, primary(boris.ActorID), additional(vera.ActorID))
	f.exec(`INSERT INTO department_members(org_id,department_id,actor_id,is_primary) VALUES($1,$2,$3,true)`, f.orgID, hall.ID, f.formerID)
	current := mustDepartment(t, f, root.ID)
	if _, err := f.service.UpdateDepartment(ctx, f.hr, root.ID, UpdateDepartmentInput{LeadActorID: OptionalID{Set: true, Value: &anna.ActorID}, ExpectedVersion: current.Version}); err != nil {
		t.Fatal(err)
	}

	// A regular member who is not the lead cannot.
	_, err := f.service.CreateDepartmentChat(ctx, gleb, root.ID)
	wantErr(t, err, ErrForbidden)
	_, err = f.service.CreateDepartmentChat(ctx, gleb, uuid.NewString())
	wantErr(t, err, ErrDepartmentNotFound)

	// The org manager creates it: the manager owns it, the lead administers
	// it, the members are the active people of the department and below.
	before := f.orgVersion()
	created, err := f.service.CreateDepartmentChat(ctx, f.hr, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	if created.Version != before+1 || created.Chat.Kind != "group" || created.Chat.Visibility != "private" || created.Chat.DisplayName != "Реабилитация" {
		t.Fatalf("created = %+v", created)
	}
	if created.Department.ChatID == nil || *created.Department.ChatID != created.Chat.ID {
		t.Fatalf("department = %+v", created.Department)
	}
	roles := chatRoles(t, f, created.Chat.ID)
	want := map[string]string{f.hr.ActorID: "owner", anna.ActorID: "admin", boris.ActorID: "member", vera.ActorID: "member"}
	if len(roles) != len(want) {
		t.Fatalf("roles = %v", roles)
	}
	for actorID, role := range want {
		if roles[actorID] != role {
			t.Fatalf("roles = %v, want %v", roles, want)
		}
	}
	_, err = f.service.CreateDepartmentChat(ctx, anna, root.ID)
	wantErr(t, err, ErrChatExists)

	// Missing people: gleb joins the department, boris leaves the chat.
	if _, err := f.service.SetDepartmentMember(ctx, f.hr, hall.ID, gleb.ActorID, SetDepartmentMemberInput{Primary: true}); err != nil {
		t.Fatal(err)
	}
	if err := f.chats.RemoveMember(ctx, boris, created.Chat.ID, boris.ActorID); err != nil {
		t.Fatal(err)
	}
	// The lead administers the chat and may see who is missing.
	missing, err := f.service.DepartmentChatMissing(ctx, anna, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, actor := range missing.Actors {
		ids = append(ids, actor.ID)
		if actor.PrimaryDepartmentID == nil || *actor.PrimaryDepartmentID != hall.ID {
			t.Fatalf("missing actor without department: %+v", actor)
		}
	}
	slices.Sort(ids)
	wantMissing := []string{boris.ActorID, gleb.ActorID}
	slices.Sort(wantMissing)
	if !slices.Equal(ids, wantMissing) {
		t.Fatalf("missing = %v, want %v", ids, wantMissing)
	}
	// An org manager outside the chat (the owner) cannot: they cannot add
	// members there, and the answer must not expose the chat.
	_, err = f.service.DepartmentChatMissing(ctx, f.owner, root.ID)
	wantErr(t, err, ErrForbidden)
	_, err = f.service.AddDepartmentChatMissing(ctx, f.owner, root.ID)
	wantErr(t, err, ErrForbidden)
	// A department without a chat: 404.
	_, err = f.service.DepartmentChatMissing(ctx, f.hr, hall.ID)
	wantErr(t, err, ErrDepartmentNotFound)

	added, err := f.service.AddDepartmentChatMissing(ctx, anna, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	if added.Added != 2 {
		t.Fatalf("added = %d", added.Added)
	}
	roles = chatRoles(t, f, created.Chat.ID)
	if roles[boris.ActorID] != "member" || roles[gleb.ActorID] != "member" || roles[f.formerID] != "" {
		t.Fatalf("roles after add = %v", roles)
	}
	var joined int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM events WHERE org_id=$1 AND chat_id=$2 AND type='member.joined'`, f.orgID, created.Chat.ID).Scan(&joined); err != nil {
		t.Fatal(err)
	}
	if joined != 2 {
		t.Fatalf("member.joined events = %d", joined)
	}
	again, err := f.service.AddDepartmentChatMissing(ctx, anna, root.ID)
	if err != nil || again.Added != 0 {
		t.Fatalf("second add = %+v, %v", again, err)
	}

	// Unlink keeps the chat; then linking needs a managed group.
	if err := f.service.UnlinkDepartmentChat(ctx, anna, root.ID); err != nil {
		t.Fatal(err)
	}
	if department := mustDepartment(t, f, root.ID); department.HasChat {
		t.Fatalf("still linked: %+v", department)
	}
	otherGroup, err := f.chats.Create(ctx, gleb, chatInput("Чужая", []string{anna.ActorID}))
	if err != nil {
		t.Fatal(err)
	}
	direct, err := f.chats.Create(ctx, anna, chatCreateInput{Kind: "direct", MemberIDs: []string{gleb.ActorID}})
	if err != nil {
		t.Fatal(err)
	}
	for name, chatID := range map[string]string{"not a manager": otherGroup.ID, "direct": direct.ID, "unknown": uuid.NewString()} {
		_, err := f.service.LinkDepartmentChat(ctx, anna, root.ID, LinkDepartmentChatInput{ChatID: chatID})
		if !errors.Is(err, ErrChatInvalid) {
			t.Fatalf("%s: error = %v", name, err)
		}
	}
	linked, err := f.service.LinkDepartmentChat(ctx, anna, root.ID, LinkDepartmentChatInput{ChatID: created.Chat.ID})
	if err != nil {
		t.Fatal(err)
	}
	if linked.Department.ChatID == nil || *linked.Department.ChatID != created.Chat.ID {
		t.Fatalf("linked = %+v", linked)
	}
	// The same chat for another department is refused.
	_, err = f.service.LinkDepartmentChat(ctx, f.hr, hall.ID, LinkDepartmentChatInput{ChatID: created.Chat.ID})
	if !errors.Is(err, ErrChatExists) && !errors.Is(err, ErrChatInvalid) {
		t.Fatalf("second link error = %v", err)
	}
	if err := f.chats.Archive(ctx, f.hr, created.Chat.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.service.UnlinkDepartmentChat(ctx, anna, root.ID); err != nil {
		t.Fatal(err)
	}
	_, err = f.service.LinkDepartmentChat(ctx, f.hr, root.ID, LinkDepartmentChatInput{ChatID: created.Chat.ID})
	wantErr(t, err, ErrChatInvalid)
	// Deleting the department keeps the chat.
	if err := f.service.DeleteDepartment(ctx, f.hr, root.ID, "none"); err != nil {
		t.Fatal(err)
	}
	var exists bool
	if err := f.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM chats WHERE id=$1)`, created.Chat.ID).Scan(&exists); err != nil || !exists {
		t.Fatalf("chat removed with the department: %v", err)
	}
}

func chatRoles(t *testing.T, f *fixture, chatID string) map[string]string {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), `SELECT actor_id, role FROM chat_members WHERE chat_id=$1`, chatID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	result := map[string]string{}
	for rows.Next() {
		var actorID, role string
		if err := rows.Scan(&actorID, &role); err != nil {
			t.Fatal(err)
		}
		result[actorID] = role
	}
	return result
}
