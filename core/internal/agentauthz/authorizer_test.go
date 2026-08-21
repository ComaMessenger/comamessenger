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
	member := identity.User{ActorID: "member", OrgID: "org", OrgRole: "member"}
	if !authorizer.CanManage(owner) || !authorizer.CanManage(admin) || authorizer.CanManage(member) {
		t.Fatal("management policy mismatch")
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
}
