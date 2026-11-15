package permission

type Code string

const (
	MembersManage      Code = "members.manage"
	InvitationsManage  Code = "invitations.manage"
	WorkspaceSettings  Code = "workspace.settings"
	WorkspacePolicies  Code = "workspace.policies"
	BrandingManage     Code = "branding.manage"
	IntegrationsManage Code = "integrations.manage"
	AgentsManage       Code = "agents.manage"
	AgentsBuild        Code = "agents.build"
	AgentsPublish      Code = "agents.publish"
	AgentsApprove      Code = "agents.approve"
	AgentsObserve      Code = "agents.observe"
	AuditRead          Code = "audit.read"
	ChatsModerate      Code = "chats.moderate"
	KnowledgeManage    Code = "knowledge.manage"
	// OrgManage («Вести оргструктуру») writes departments, positions and
	// assignments. members.manage covers it too (CanManageOrg).
	OrgManage Code = "org.manage"
	// RequestsAddressGroups («Обращаться к отделам и ролям») lets a person
	// address a request to a department or a position. Administrators do
	// not get it by default; the owner always has it.
	RequestsAddressGroups Code = "requests.address_groups"
)

var all = [...]Code{
	MembersManage,
	InvitationsManage,
	WorkspaceSettings,
	WorkspacePolicies,
	BrandingManage,
	IntegrationsManage,
	AgentsManage,
	AgentsBuild,
	AgentsPublish,
	AgentsApprove,
	AgentsObserve,
	AuditRead,
	ChatsModerate,
	KnowledgeManage,
	OrgManage,
	RequestsAddressGroups,
}

// memberGrantable lists permissions that may be granted to a regular member.
// Every other explicit permission requires the administrator role.
var memberGrantable = [...]Code{KnowledgeManage, OrgManage, RequestsAddressGroups}

func All() []Code {
	return append([]Code(nil), all[:]...)
}

func Valid(code Code) bool {
	for _, candidate := range all {
		if candidate == code {
			return true
		}
	}
	return false
}

// MemberGrantable reports whether the permission may be held by a member.
func MemberGrantable(code Code) bool {
	for _, candidate := range memberGrantable {
		if candidate == code {
			return true
		}
	}
	return false
}

func Effective(role string, granted []Code) []Code {
	if role == "owner" {
		return All()
	}
	if role != "admin" && role != "member" {
		return []Code{}
	}
	result := make([]Code, 0, len(granted))
	seen := make(map[Code]struct{}, len(granted))
	for _, code := range granted {
		if !Valid(code) || role == "member" && !MemberGrantable(code) {
			continue
		}
		if _, exists := seen[code]; exists {
			continue
		}
		seen[code] = struct{}{}
		result = append(result, code)
	}
	return result
}

func Allows(role string, granted []Code, required Code) bool {
	if role == "owner" {
		return Valid(required)
	}
	if !Valid(required) || role != "admin" && (role != "member" || !MemberGrantable(required)) {
		return false
	}
	for _, code := range granted {
		if code == required || (code == AgentsManage && isGranularAgentPermission(required)) {
			return true
		}
	}
	return false
}

func isGranularAgentPermission(code Code) bool {
	return code == AgentsBuild || code == AgentsPublish || code == AgentsApprove || code == AgentsObserve
}

// CanManageOrg reports whether the person may write the org structure:
// org.manage, or members.manage which covers it (decision 4 of phase 6.5).
func CanManageOrg(role string, granted []Code) bool {
	return Allows(role, granted, OrgManage) || Allows(role, granted, MembersManage)
}
