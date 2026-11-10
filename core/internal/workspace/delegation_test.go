package workspace

import (
	"errors"
	"slices"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
)

// delegationFixture is a fictional workspace with an owner, a members
// administrator, an administrator without members.manage, a second
// administrator and a regular member.
type delegationFixture struct {
	service                          *Service
	owner, admin, auditor, colleague identity.User
	memberID                         string
}

func newDelegationFixture(t *testing.T) delegationFixture {
	t.Helper()
	pool := testdb.New(t)
	orgID := uuid.NewString()
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}
	ownerID, adminID, auditorID, colleagueID, memberID := ids[0], ids[1], ids[2], ids[3], ids[4]
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Rehab','rehab')`, []any{orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES
			($1,$6,'user','owner','Owner','owner'),($2,$6,'user','admin','Admin','admin'),
			($3,$6,'user','admin','Auditor','auditor'),($4,$6,'user','admin','Colleague','colleague'),
			($5,$6,'user','member','Instructor','instructor')`, []any{ownerID, adminID, auditorID, colleagueID, memberID, orgID}},
		{`INSERT INTO users(actor_id,org_id,email,password_hash) VALUES
			($1,$6,'owner@example.test','hash'),($2,$6,'admin@example.test','hash'),($3,$6,'auditor@example.test','hash'),
			($4,$6,'colleague@example.test','hash'),($5,$6,'instructor@example.test','hash')`, []any{ownerID, adminID, auditorID, colleagueID, memberID, orgID}},
		{`INSERT INTO actor_permissions(org_id,actor_id,permission,granted_by) VALUES
			($1,$2,'members.manage',$5),($1,$2,'knowledge.manage',$5),
			($1,$3,'knowledge.manage',$5),($1,$3,'audit.read',$5),
			($1,$4,'members.manage',$5)`, []any{orgID, adminID, auditorID, colleagueID, ownerID}},
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
	service, err := NewService(NewRepository(pool), "test-secret-with-enough-entropy", nil)
	if err != nil {
		t.Fatal(err)
	}
	user := func(actorID, role string, granted ...permission.Code) identity.User {
		return identity.User{ActorID: actorID, OrgID: orgID, OrgRole: role, Permissions: permission.Effective(role, granted)}
	}
	return delegationFixture{
		service:   service,
		owner:     user(ownerID, "owner"),
		admin:     user(adminID, "admin", permission.MembersManage, permission.KnowledgeManage),
		auditor:   user(auditorID, "admin", permission.KnowledgeManage, permission.AuditRead),
		colleague: user(colleagueID, "admin", permission.MembersManage),
		memberID:  memberID,
	}
}

func codes(values ...permission.Code) *[]permission.Code { return &values }

func TestAdministratorDelegatesKnowledgePermissionToMembers(t *testing.T) {
	f := newDelegationFixture(t)

	granted, err := f.service.UpdateMember(t.Context(), f.admin, f.memberID, UpdateMemberInput{Permissions: codes(permission.KnowledgeManage)})
	if err != nil {
		t.Fatal(err)
	}
	if granted.Role != "member" || !slices.Equal(granted.Permissions, []permission.Code{permission.KnowledgeManage}) {
		t.Fatalf("granted member = %+v", granted)
	}
	revoked, err := f.service.UpdateMember(t.Context(), f.admin, f.memberID, UpdateMemberInput{Permissions: codes()})
	if err != nil {
		t.Fatal(err)
	}
	if len(revoked.Permissions) != 0 {
		t.Fatalf("revoked member permissions = %#v", revoked.Permissions)
	}
	// The owner keeps the same ability.
	if _, err := f.service.UpdateMember(t.Context(), f.owner, f.memberID, UpdateMemberInput{Permissions: codes(permission.KnowledgeManage)}); err != nil {
		t.Fatal(err)
	}
}

func TestAdministratorDelegationDoesNotWidenPrivileges(t *testing.T) {
	f := newDelegationFixture(t)
	tests := []struct {
		name    string
		current identity.User
		target  string
		input   UpdateMemberInput
		want    error
	}{
		{name: "administrator permission for a member", current: f.admin, target: f.memberID, input: UpdateMemberInput{Permissions: codes(permission.AuditRead)}, want: ErrForbidden},
		{name: "mixed permissions for a member", current: f.admin, target: f.memberID, input: UpdateMemberInput{Permissions: codes(permission.KnowledgeManage, permission.MembersManage)}, want: ErrForbidden},
		{name: "own permissions", current: f.admin, target: f.admin.ActorID, input: UpdateMemberInput{Permissions: codes(permission.KnowledgeManage, permission.MembersManage, permission.AuditRead)}, want: ErrForbidden},
		{name: "own permissions without escalation", current: f.admin, target: f.admin.ActorID, input: UpdateMemberInput{Permissions: codes(permission.KnowledgeManage)}, want: ErrForbidden},
		{name: "another administrator", current: f.admin, target: f.colleague.ActorID, input: UpdateMemberInput{Permissions: codes(permission.KnowledgeManage)}, want: ErrForbidden},
		{name: "the owner", current: f.admin, target: f.owner.ActorID, input: UpdateMemberInput{Permissions: codes(permission.KnowledgeManage)}, want: ErrForbidden},
		{name: "promotion with permissions", current: f.admin, target: f.memberID, input: UpdateMemberInput{Role: ptr("admin"), Permissions: codes(permission.KnowledgeManage)}, want: ErrForbidden},
		{name: "without members.manage", current: f.auditor, target: f.memberID, input: UpdateMemberInput{Permissions: codes(permission.KnowledgeManage)}, want: ErrForbidden},
		{name: "without knowledge.manage", current: f.colleague, target: f.memberID, input: UpdateMemberInput{Permissions: codes(permission.KnowledgeManage)}, want: ErrForbidden},
		{name: "unknown permission", current: f.admin, target: f.memberID, input: UpdateMemberInput{Permissions: codes("unknown")}, want: ErrInvalid},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := f.service.UpdateMember(t.Context(), test.current, test.target, test.input); !errors.Is(err, test.want) {
				t.Fatalf("UpdateMember() error = %v, want %v", err, test.want)
			}
		})
	}
	members, err := f.service.Members(t.Context(), f.owner)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range members {
		switch member.ActorID {
		case f.memberID:
			if member.Role != "member" || len(member.Permissions) != 0 {
				t.Fatalf("member changed by a refused request: %+v", member)
			}
		case f.admin.ActorID:
			if !slices.Equal(member.Permissions, []permission.Code{permission.KnowledgeManage, permission.MembersManage}) {
				t.Fatalf("administrator changed own permissions: %#v", member.Permissions)
			}
		case f.colleague.ActorID:
			if !slices.Equal(member.Permissions, []permission.Code{permission.MembersManage}) {
				t.Fatalf("colleague permissions changed: %#v", member.Permissions)
			}
		}
	}
}

func ptr(value string) *string { return &value }
