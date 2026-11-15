package orgstructure

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// fixture is a fictional rehab centre: an owner, an administrator who
// manages members, an administrator with neither members.manage nor
// org.manage, an HR member with org.manage, regular staff, an agent and a
// deactivated person.
type fixture struct {
	t       *testing.T
	pool    *pgxpool.Pool
	service *Service
	chats   *chat.Service
	orgID   string

	owner, admin, auditor, hr identity.User
	staff                     []identity.User
	agentID, formerID         string

	mu     sync.Mutex
	wakeup []int64
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	pool := testdb.New(t)
	f := &fixture{t: t, pool: pool, orgID: uuid.NewString()}
	ownerID := uuid.NewString()
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Опора','opora')`, []any{f.orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'user','owner','owner','owner')`, []any{ownerID, f.orgID}},
		{`INSERT INTO users(actor_id,org_id,email,password_hash) VALUES($1,$2,'owner@example.test','hash')`, []any{ownerID, f.orgID}},
	} {
		if _, err := tx.Exec(context.Background(), statement.sql, statement.args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.owner = identity.User{ActorID: ownerID, OrgID: f.orgID, OrgRole: "owner", Status: "active", Permissions: permission.Effective("owner", nil)}
	f.admin = f.person("admin", "admin", permission.MembersManage)
	f.auditor = f.person("auditor", "admin", permission.AuditRead, permission.KnowledgeManage)
	f.hr = f.person("hr", "member", permission.OrgManage)
	for _, handle := range []string{"anna", "boris", "vera", "gleb", "dina", "egor"} {
		f.staff = append(f.staff, f.person(handle, "member"))
	}
	f.agentID = uuid.NewString()
	f.exec(`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'agent','member','Помощник','helper')`, f.agentID, f.orgID)
	former := f.person("former", "member")
	f.formerID = former.ActorID
	f.exec(`UPDATE actors SET status='deactivated' WHERE id=$1`, f.formerID)
	f.chats = chat.NewService(pool)
	f.service = NewService(pool, f.chats, func(_ string, seq int64) {
		f.mu.Lock()
		f.wakeup = append(f.wakeup, seq)
		f.mu.Unlock()
	})
	return f
}

func (f *fixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.pool.Exec(context.Background(), sql, args...); err != nil {
		f.t.Fatalf("exec %s: %v", sql, err)
	}
}

func (f *fixture) person(handle, role string, granted ...permission.Code) identity.User {
	f.t.Helper()
	actorID := uuid.NewString()
	f.exec(`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'user',$3,$4,$5)`, actorID, f.orgID, role, handle, handle)
	f.exec(`INSERT INTO users(actor_id,org_id,email,password_hash) VALUES($1,$2,$3,'hash')`, actorID, f.orgID, handle+"@example.test")
	for _, code := range granted {
		f.exec(`INSERT INTO actor_permissions(org_id,actor_id,permission) VALUES($1,$2,$3)`, f.orgID, actorID, string(code))
	}
	return identity.User{ActorID: actorID, OrgID: f.orgID, OrgRole: role, Status: "active", Permissions: permission.Effective(role, granted)}
}

func (f *fixture) orgVersion() int64 {
	f.t.Helper()
	var version int64
	if err := f.pool.QueryRow(context.Background(), `SELECT org_version FROM organizations WHERE id=$1`, f.orgID).Scan(&version); err != nil {
		f.t.Fatal(err)
	}
	return version
}

type orgEvent struct {
	Version int64  `json:"version"`
	Reason  string `json:"reason"`
}

func (f *fixture) orgEvents() []orgEvent {
	f.t.Helper()
	rows, err := f.pool.Query(context.Background(), `
		SELECT data FROM events WHERE org_id=$1 AND type='org.updated' AND chat_id IS NULL AND audience_actor_id IS NULL ORDER BY seq`, f.orgID)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	result := []orgEvent{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			f.t.Fatal(err)
		}
		var event orgEvent
		if err := json.Unmarshal(raw, &event); err != nil {
			f.t.Fatal(err)
		}
		result = append(result, event)
	}
	return result
}

func (f *fixture) department(name string, parentID *string, members ...MemberInput) Department {
	f.t.Helper()
	result, err := f.service.CreateDepartment(context.Background(), f.hr, CreateDepartmentInput{Name: name, ParentID: parentID, Members: members})
	if err != nil {
		f.t.Fatalf("create department %s: %v", name, err)
	}
	return result.Department
}

func (f *fixture) structure(viewer identity.User) Structure {
	f.t.Helper()
	result, err := f.service.Structure(context.Background(), viewer)
	if err != nil {
		f.t.Fatal(err)
	}
	return result
}

func personOf(structure Structure, actorID string) (Person, bool) {
	for _, person := range structure.People {
		if person.ActorID == actorID {
			return person, true
		}
	}
	return Person{}, false
}

func departmentOf(structure Structure, departmentID string) (Department, bool) {
	for _, department := range structure.Departments {
		if department.ID == departmentID {
			return department, true
		}
	}
	return Department{}, false
}

func ptr[T any](value T) *T { return &value }

func wantErr(t *testing.T, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}

func primary(actorID string) MemberInput    { return MemberInput{ActorID: actorID, Primary: true} }
func additional(actorID string) MemberInput { return MemberInput{ActorID: actorID} }

type chatCreateInput = chat.CreateInput
