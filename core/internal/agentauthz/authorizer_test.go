package agentauthz

import (
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
)

func TestAuthorizer(t *testing.T) {
	authorizer := New()
	owner := identity.User{ActorID: "owner", OrgID: "org", OrgRole: "owner"}
	admin := identity.User{ActorID: "admin", OrgID: "org", OrgRole: "admin", Permissions: []permission.Code{permission.AgentsManage}}
	builder := identity.User{ActorID: "builder", OrgID: "org", OrgRole: "admin", Permissions: []permission.Code{permission.AgentsBuild}}
	publisher := identity.User{ActorID: "publisher", OrgID: "org", OrgRole: "admin", Permissions: []permission.Code{permission.AgentsPublish}}
	member := identity.User{ActorID: "member", OrgID: "org", OrgRole: "member"}
	if !authorizer.CanManage(owner) || !authorizer.CanManage(admin) || authorizer.CanManage(member) {
		t.Fatal("management policy mismatch")
	}
	if !authorizer.CanBuild(builder) || authorizer.CanPublish(builder) || !authorizer.CanPublish(publisher) || authorizer.CanBuild(publisher) {
		t.Fatal("granular product permissions overlap")
	}
	if !authorizer.CanBuild(admin) || !authorizer.CanPublish(admin) || !authorizer.CanApprove(admin) || !authorizer.CanObserve(admin) {
		t.Fatal("legacy agents.manage did not expand to product permissions")
	}
	agent := identity.User{ActorID: "agent", OrgID: "org"}
	runtime := access.Identity{AuthenticationKind: "api_key", ActorID: "agent", OrgID: "org", KeyID: "key", Scopes: []string{"runtime:execute", "messages:read"}}
	if !authorizer.IsRuntime(agent, runtime) || !authorizer.CanInvokeTool(agent, runtime, "messages:read") {
		t.Fatal("runtime policy rejected a matching agent key")
	}
	runtime.ActorID = "other"
	if authorizer.IsRuntime(agent, runtime) || authorizer.CanInvokeTool(agent, runtime, "messages:read") {
		t.Fatal("runtime policy accepted another actor's key")
	}
	worker := access.Identity{AuthenticationKind: "api_key", ActorID: "agent", OrgID: "org", KeyID: "key", Scopes: []string{"runtime:worker"}}
	if !authorizer.IsOrganizationWorker(agent, worker) || !authorizer.CanWork(agent, worker) {
		t.Fatal("organization worker policy rejected a matching worker key")
	}
}
