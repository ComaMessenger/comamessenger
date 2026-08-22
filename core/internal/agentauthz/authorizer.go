package agentauthz

import (
	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
)

// Authorizer is the single policy boundary shared by agent management,
// runtime endpoints and tool execution. It deliberately does not query the
// database: chat membership remains enforced by the domain services that own
// the protected resource.
type Authorizer struct{}

func New() Authorizer { return Authorizer{} }

func (Authorizer) CanManage(current identity.User) bool {
	return permission.Allows(current.OrgRole, current.Permissions, permission.AgentsManage)
}

func (Authorizer) CanBuild(current identity.User) bool {
	return permission.Allows(current.OrgRole, current.Permissions, permission.AgentsBuild)
}

func (Authorizer) CanPublish(current identity.User) bool {
	return permission.Allows(current.OrgRole, current.Permissions, permission.AgentsPublish)
}

func (Authorizer) CanApprove(current identity.User) bool {
	return permission.Allows(current.OrgRole, current.Permissions, permission.AgentsApprove)
}

func (Authorizer) CanObserve(current identity.User) bool {
	return permission.Allows(current.OrgRole, current.Permissions, permission.AgentsObserve)
}

func (authorizer Authorizer) CanView(current identity.User) bool {
	return authorizer.CanObserve(current) || authorizer.CanBuild(current) || authorizer.CanPublish(current) || authorizer.CanApprove(current)
}

func (Authorizer) IsRuntime(current identity.User, authentication access.Identity) bool {
	return authentication.AuthenticationKind == "api_key" &&
		authentication.ActorID == current.ActorID &&
		authentication.OrgID == current.OrgID &&
		authentication.KeyID != "" &&
		HasScope(authentication.Scopes, "runtime:execute")
}

func (Authorizer) IsOrganizationWorker(current identity.User, authentication access.Identity) bool {
	return authentication.AuthenticationKind == "api_key" &&
		authentication.ActorID == current.ActorID &&
		authentication.OrgID == current.OrgID &&
		authentication.KeyID != "" &&
		HasScope(authentication.Scopes, "runtime:worker")
}

func (authorizer Authorizer) CanWork(current identity.User, authentication access.Identity) bool {
	return authorizer.IsRuntime(current, authentication) || authorizer.IsOrganizationWorker(current, authentication)
}

func (Authorizer) CanInvokeTool(current identity.User, authentication access.Identity, requiredScope string) bool {
	return authentication.AuthenticationKind == "api_key" &&
		authentication.ActorID == current.ActorID &&
		authentication.OrgID == current.OrgID &&
		HasScope(authentication.Scopes, requiredScope)
}

func HasScope(scopes []string, required string) bool {
	if required == "" {
		return true
	}
	for _, scope := range scopes {
		if scope == required {
			return true
		}
	}
	return false
}
