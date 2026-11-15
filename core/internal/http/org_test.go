package http

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	standardhttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/orgstructure"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Without the service every org route of the contract is registered and
// answers 501, as before package S1.
func TestOrgRoutesWithoutServiceAnswerNotImplemented(t *testing.T) {
	h := newIdentityHandlers(slog.New(slog.NewTextHandler(io.Discard, nil)), "", Dependencies{})
	router := chi.NewRouter()
	h.routes(router)
	routes := map[string]bool{}
	if err := chi.Walk(router, func(method, route string, _ standardhttp.Handler, _ ...func(standardhttp.Handler) standardhttp.Handler) error {
		routes[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, route := range orgContractRoutes {
		if !routes[route.method+" "+route.path] {
			t.Errorf("route %s %s is not registered", route.method, route.path)
		}
	}
	if len(orgContractRoutes) != 19 {
		t.Fatalf("contract routes = %d, want 19", len(orgContractRoutes))
	}
	response := httptest.NewRecorder()
	h.orgNotImplemented(response, httptest.NewRequest(standardhttp.MethodGet, "/", nil))
	if response.Code != standardhttp.StatusNotImplemented {
		t.Fatalf("status = %d, want 501", response.Code)
	}
}

type orgHTTPFixture struct {
	t                      *testing.T
	router                 chi.Router
	current                *identity.User
	owner, hr, lead, plain identity.User
	orgID                  string
	org                    *orgstructure.Service
	chats                  *chat.Service
	pool                   *pgxpool.Pool
}

func testdbPoolOf(_ *testing.T, f *orgHTTPFixture) *pgxpool.Pool { return f.pool }

func newOrgHTTPFixture(t *testing.T) *orgHTTPFixture {
	t.Helper()
	pool := testdb.New(t)
	ctx := context.Background()
	orgID := uuid.NewString()
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Опора','opora')`, []any{orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle,title) VALUES
			($1,$5,'user','owner','Owner','owner',''),($2,$5,'user','member','Кадровик','hr',''),
			($3,$5,'user','member','Анна','anna','Старший инструктор'),($4,$5,'user','member','Борис','boris','')`, []any{ids[0], ids[1], ids[2], ids[3], orgID}},
		{`INSERT INTO users(actor_id,org_id,email,password_hash) VALUES
			($1,$5,'owner@example.test','h'),($2,$5,'hr@example.test','h'),($3,$5,'anna@example.test','h'),($4,$5,'boris@example.test','h')`, []any{ids[0], ids[1], ids[2], ids[3], orgID}},
		{`INSERT INTO actor_permissions(org_id,actor_id,permission) VALUES($1,$2,'org.manage')`, []any{orgID, ids[1]}},
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	user := func(actorID, role string, granted ...permission.Code) identity.User {
		return identity.User{ActorID: actorID, OrgID: orgID, OrgRole: role, Status: "active", Permissions: permission.Effective(role, granted)}
	}
	chats := chat.NewService(pool)
	org := orgstructure.NewService(pool, chats, nil)
	f := &orgHTTPFixture{t: t, owner: user(ids[0], "owner"), hr: user(ids[1], "member", permission.OrgManage), lead: user(ids[2], "member"), plain: user(ids[3], "member"), orgID: orgID, org: org, chats: chats, pool: pool}
	h := newIdentityHandlers(slog.New(slog.NewTextHandler(io.Discard, nil)), "", Dependencies{Org: org, Chats: chats})
	router := chi.NewRouter()
	router.Use(func(next standardhttp.Handler) standardhttp.Handler {
		return standardhttp.HandlerFunc(func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), authContextKey{}, authenticated{User: *f.current})))
		})
	})
	h.orgRoutes(router)
	router.Get("/actors", h.listActors)
	f.router = router
	return f
}

func (f *orgHTTPFixture) do(as identity.User, method, path string, body any, headers ...string) *httptest.ResponseRecorder {
	f.t.Helper()
	f.current = &as
	var reader io.Reader = http_noBody{}
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			f.t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request := httptest.NewRequest(method, path, reader)
	for index := 0; index+1 < len(headers); index += 2 {
		request.Header.Set(headers[index], headers[index+1])
	}
	response := httptest.NewRecorder()
	f.router.ServeHTTP(response, request)
	return response
}

type http_noBody struct{}

func (http_noBody) Read([]byte) (int, error) { return 0, io.EOF }

func decodeBody[T any](t *testing.T, response *httptest.ResponseRecorder) T {
	t.Helper()
	var result T
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode %s: %v", response.Body.String(), err)
	}
	return result
}

// Every write route refuses a member without org.manage, with nothing
// changed; reading is open to every active person.
func TestOrgRoutesCheckPermissions(t *testing.T) {
	f := newOrgHTTPFixture(t)
	created := f.do(f.hr, "POST", "/org/departments", map[string]any{"name": "Зал ЛФК", "members": []map[string]any{{"actor_id": f.lead.ActorID, "primary": true}}})
	if created.Code != standardhttp.StatusCreated {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	department := decodeBody[orgstructure.DepartmentWrite](t, created).Department
	positionResponse := f.do(f.hr, "POST", "/org/positions", map[string]any{"name": "Инструктор"})
	if positionResponse.Code != standardhttp.StatusCreated {
		t.Fatalf("position = %d %s", positionResponse.Code, positionResponse.Body.String())
	}
	position := decodeBody[orgstructure.PositionWrite](t, positionResponse).Position
	dep, pos, actor := department.ID, position.ID, f.lead.ActorID
	writes := []struct {
		method, path string
		body         any
	}{
		{"POST", "/org/departments", map[string]any{"name": "Новый"}},
		{"PATCH", "/org/departments/" + dep, map[string]any{"name": "Зал", "expected_version": department.Version}},
		{"DELETE", "/org/departments/" + dep, nil},
		{"POST", "/org/departments/" + dep + "/move", map[string]any{"direction": "up"}},
		{"PUT", "/org/departments/" + dep + "/members/" + f.plain.ActorID, map[string]any{"primary": true}},
		{"DELETE", "/org/departments/" + dep + "/members/" + actor, nil},
		{"POST", "/org/departments/" + dep + "/chat", nil},
		{"PUT", "/org/departments/" + dep + "/chat", map[string]any{"chat_id": uuid.NewString()}},
		{"DELETE", "/org/departments/" + dep + "/chat", nil},
		{"GET", "/org/departments/" + dep + "/chat/missing", nil},
		{"POST", "/org/departments/" + dep + "/chat/add-missing", nil},
		{"PUT", "/org/people/" + f.plain.ActorID, map[string]any{"primary_department_id": dep, "additional_department_ids": []string{}, "position_id": nil}},
		{"POST", "/org/people/assign", map[string]any{"actor_ids": []string{f.plain.ActorID}, "primary_department_id": dep}},
		{"POST", "/org/positions", map[string]any{"name": "Врач"}},
		{"POST", "/org/positions/bulk", map[string]any{"names": []string{"Врач"}}},
		{"PATCH", "/org/positions/" + pos, map[string]any{"name": "Тренер", "expected_version": position.Version}},
		{"DELETE", "/org/positions/" + pos, nil},
		{"GET", "/org/title-suggestions", nil},
	}
	before := decodeBody[orgstructure.Structure](t, f.do(f.plain, "GET", "/org", nil))
	for _, write := range writes {
		response := f.do(f.plain, write.method, write.path, write.body)
		if response.Code != standardhttp.StatusForbidden {
			t.Errorf("%s %s by a plain member = %d %s", write.method, write.path, response.Code, response.Body.String())
			continue
		}
		if body := decodeBody[api.Error](t, response); body.Code != "forbidden" {
			t.Errorf("%s %s code = %s", write.method, write.path, body.Code)
		}
	}
	after := decodeBody[orgstructure.Structure](t, f.do(f.plain, "GET", "/org", nil))
	if after.Version != before.Version {
		t.Fatalf("refused writes changed the version %d -> %d", before.Version, after.Version)
	}
	// Error codes and details reach the client.
	response := f.do(f.hr, "POST", "/org/departments", map[string]any{"name": "зал лфк"})
	if body := decodeBody[api.Error](t, response); response.Code != standardhttp.StatusConflict || body.Code != "org_name_taken" {
		t.Fatalf("name taken = %d %+v", response.Code, body)
	}
	response = f.do(f.hr, "PATCH", "/org/departments/"+dep, map[string]any{"parent_id": dep, "expected_version": department.Version})
	if body := decodeBody[api.Error](t, response); response.Code != standardhttp.StatusConflict || body.Code != "org_cycle" {
		t.Fatalf("cycle = %d %+v", response.Code, body)
	}
	response = f.do(f.hr, "PUT", "/org/departments/"+uuid.NewString()+"/members/"+actor, map[string]any{"primary": true})
	if body := decodeBody[api.Error](t, response); response.Code != standardhttp.StatusNotFound || body.Code != "department_not_found" {
		t.Fatalf("missing department = %d %+v", response.Code, body)
	}
	response = f.do(f.hr, "PUT", "/org/people/"+actor, map[string]any{"primary_department_id": nil, "additional_department_ids": []string{dep}, "position_id": nil})
	body := decodeBody[api.Error](t, response)
	if response.Code != standardhttp.StatusUnprocessableEntity || body.Code != "org_invalid" || body.Details == nil || (*body.Details)["field"] != "additional_department_ids" {
		t.Fatalf("invalid = %d %+v", response.Code, body)
	}
	response = f.do(f.hr, "POST", "/org/departments", map[string]any{"name": "X", "unknown": true})
	if response.Code != standardhttp.StatusBadRequest {
		t.Fatalf("unknown field = %d", response.Code)
	}
	// Leaving out position_id keeps it; null clears it.
	response = f.do(f.hr, "POST", "/org/people/assign", map[string]any{"actor_ids": []string{actor}, "position_id": pos})
	if response.Code != standardhttp.StatusOK {
		t.Fatalf("assign = %d %s", response.Code, response.Body.String())
	}
	response = f.do(f.hr, "POST", "/org/people/assign", map[string]any{"actor_ids": []string{actor}, "add_department_id": dep})
	assigned := decodeBody[orgstructure.AssignPeopleResult](t, response)
	if assigned.People[0].PositionID == nil {
		t.Fatalf("absent position_id cleared the position: %+v", assigned)
	}
	response = f.do(f.hr, "POST", "/org/people/assign", map[string]any{"actor_ids": []string{actor}, "position_id": nil})
	assigned = decodeBody[orgstructure.AssignPeopleResult](t, response)
	if assigned.People[0].PositionID != nil {
		t.Fatalf("null position_id kept the position: %+v", assigned)
	}
}

func TestOrgStructureETag(t *testing.T) {
	f := newOrgHTTPFixture(t)
	first := f.do(f.plain, "GET", "/org", nil)
	if first.Code != standardhttp.StatusOK || first.Header().Get("ETag") != `"org-1"` {
		t.Fatalf("first = %d etag %q", first.Code, first.Header().Get("ETag"))
	}
	structure := decodeBody[orgstructure.Structure](t, first)
	if structure.Version != 1 || structure.Departments == nil || structure.Positions == nil || structure.People == nil {
		t.Fatalf("empty structure = %s", first.Body.String())
	}
	for _, header := range []string{`"org-1"`, `W/"org-1"`, `"org-0", "org-1"`, `*`} {
		cached := f.do(f.plain, "GET", "/org", nil, "If-None-Match", header)
		if cached.Code != standardhttp.StatusNotModified || cached.Body.Len() != 0 || cached.Header().Get("ETag") != `"org-1"` {
			t.Fatalf("If-None-Match %s = %d", header, cached.Code)
		}
	}
	if response := f.do(f.hr, "POST", "/org/departments", map[string]any{"name": "Зал"}); response.Code != standardhttp.StatusCreated {
		t.Fatal(response.Body.String())
	}
	stale := f.do(f.plain, "GET", "/org", nil, "If-None-Match", `"org-1"`)
	if stale.Code != standardhttp.StatusOK || stale.Header().Get("ETag") != `"org-2"` {
		t.Fatalf("stale = %d %q", stale.Code, stale.Header().Get("ETag"))
	}
	if !strings.Contains(stale.Body.String(), `"name":"Зал"`) {
		t.Fatalf("body = %s", stale.Body.String())
	}
}

// The id of a private department chat reaches only its members, in reads
// and in write responses.
func TestDepartmentChatIDStaysPrivate(t *testing.T) {
	f := newOrgHTTPFixture(t)
	created := decodeBody[orgstructure.DepartmentWrite](t, f.do(f.hr, "POST", "/org/departments", map[string]any{"name": "Зал ЛФК", "lead_actor_id": f.lead.ActorID}))
	chatResponse := f.do(f.lead, "POST", "/org/departments/"+created.Department.ID+"/chat", nil)
	if chatResponse.Code != standardhttp.StatusCreated {
		t.Fatalf("lead creates chat = %d %s", chatResponse.Code, chatResponse.Body.String())
	}
	chatID := decodeBody[orgstructure.DepartmentChatResult](t, chatResponse).Chat.ID
	for _, outsider := range []identity.User{f.plain, f.hr, f.owner} {
		for _, path := range []string{"/org"} {
			body := f.do(outsider, "GET", path, nil).Body.String()
			if strings.Contains(body, chatID) || !strings.Contains(body, `"has_chat":true`) {
				t.Fatalf("%s sees %s", outsider.ActorID, body)
			}
		}
		if outsider.ActorID == f.plain.ActorID {
			continue
		}
		write := f.do(outsider, "POST", "/org/departments/"+created.Department.ID+"/move", map[string]any{"direction": "down"})
		if write.Code != standardhttp.StatusOK || strings.Contains(write.Body.String(), chatID) {
			t.Fatalf("write response to %s = %d %s", outsider.ActorID, write.Code, write.Body.String())
		}
		missing := f.do(outsider, "GET", "/org/departments/"+created.Department.ID+"/chat/missing", nil)
		if missing.Code != standardhttp.StatusForbidden || strings.Contains(missing.Body.String(), chatID) {
			t.Fatalf("missing for %s = %d %s", outsider.ActorID, missing.Code, missing.Body.String())
		}
	}
	if body := f.do(f.lead, "GET", "/org", nil).Body.String(); !strings.Contains(body, chatID) {
		t.Fatalf("the member does not see the chat: %s", body)
	}
}

func TestListActorsSearchesPositionAndDepartments(t *testing.T) {
	f := newOrgHTTPFixture(t)
	department := decodeBody[orgstructure.DepartmentWrite](t, f.do(f.hr, "POST", "/org/departments", map[string]any{"name": "Бассейн", "members": []map[string]any{{"actor_id": f.plain.ActorID, "primary": true}}}))
	f.do(f.hr, "POST", "/org/departments", map[string]any{"name": "Кухня", "members": []map[string]any{{"actor_id": f.lead.ActorID, "primary": true}, {"actor_id": f.plain.ActorID, "primary": false}}})
	position := decodeBody[orgstructure.PositionWrite](t, f.do(f.hr, "POST", "/org/positions", map[string]any{"name": "Врач-реабилитолог"}))
	f.do(f.hr, "POST", "/org/people/assign", map[string]any{"actor_ids": []string{f.lead.ActorID}, "position_id": position.Position.ID})
	search := func(q string) map[string]chat.Actor {
		t.Helper()
		page := decodeBody[chat.ActorPage](t, f.do(f.plain, "GET", "/actors?q="+q, nil))
		result := map[string]chat.Actor{}
		for _, actor := range page.Actors {
			result[actor.ID] = actor
		}
		return result
	}
	byDepartment := search("%D0%B1%D0%B0%D1%81%D1%81%D0%B5%D0%B9%D0%BD") // «бассейн»
	if len(byDepartment) != 1 || byDepartment[f.plain.ActorID].PrimaryDepartmentID == nil || *byDepartment[f.plain.ActorID].PrimaryDepartmentID != department.Department.ID {
		t.Fatalf("by department = %+v", byDepartment)
	}
	byAdditional := search("%D0%BA%D1%83%D1%85") // «кух»: primary and additional members
	if len(byAdditional) != 2 {
		t.Fatalf("by additional department = %+v", byAdditional)
	}
	byPosition := search("%D1%80%D0%B5%D0%B0%D0%B1%D0%B8%D0%BB%D0%B8%D1%82") // «реабилит»
	if len(byPosition) != 1 || byPosition[f.lead.ActorID].PositionID == nil || *byPosition[f.lead.ActorID].PositionID != position.Position.ID {
		t.Fatalf("by position = %+v", byPosition)
	}
}

// Agents do not see the org structure through /actors either.
func TestListActorsHidesOrgStructureFromAgents(t *testing.T) {
	f := newOrgHTTPFixture(t)
	f.do(f.hr, "POST", "/org/departments", map[string]any{"name": "Бассейн", "members": []map[string]any{{"actor_id": f.plain.ActorID, "primary": true}}})
	agentID := uuid.NewString()
	if _, err := f.chats.Create(context.Background(), f.owner, chat.CreateInput{Kind: "group", Name: "x"}); err != nil {
		t.Fatal(err)
	}
	pool := testdbPoolOf(t, f)
	if _, err := pool.Exec(context.Background(), `INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'agent','member','Бот','bot')`, agentID, f.orgID); err != nil {
		t.Fatal(err)
	}
	agent := identity.User{ActorID: agentID, OrgID: f.orgID, OrgRole: "member"}
	page := decodeBody[chat.ActorPage](t, f.do(agent, "GET", "/actors?q=%D0%B1%D0%B0%D1%81%D1%81%D0%B5%D0%B9%D0%BD", nil))
	if len(page.Actors) != 0 {
		t.Fatalf("agent found people by department: %+v", page.Actors)
	}
	page = decodeBody[chat.ActorPage](t, f.do(agent, "GET", "/actors", nil))
	for _, actor := range page.Actors {
		if actor.PositionID != nil || actor.PrimaryDepartmentID != nil {
			t.Fatalf("agent sees the assignment: %+v", actor)
		}
	}
	if len(page.Actors) == 0 {
		t.Fatal("agent sees nobody")
	}
}
