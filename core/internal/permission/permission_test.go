package permission

import "testing"

func TestAllows(t *testing.T) {
	tests := []struct {
		name     string
		role     string
		granted  []Code
		required Code
		want     bool
	}{
		{name: "owner has every known permission", role: "owner", required: AuditRead, want: true},
		{name: "admin needs an explicit permission", role: "admin", required: AuditRead, want: false},
		{name: "admin receives a granted permission", role: "admin", granted: []Code{AuditRead}, required: AuditRead, want: true},
		{name: "legacy agent manager can build", role: "admin", granted: []Code{AgentsManage}, required: AgentsBuild, want: true},
		{name: "builder cannot publish", role: "admin", granted: []Code{AgentsBuild}, required: AgentsPublish, want: false},
		{name: "member never receives explicit permissions", role: "member", granted: []Code{AuditRead}, required: AuditRead, want: false},
		{name: "member may receive the knowledge permission", role: "member", granted: []Code{KnowledgeManage}, required: KnowledgeManage, want: true},
		{name: "member without the knowledge permission is denied", role: "member", required: KnowledgeManage, want: false},
		{name: "member may receive org.manage", role: "member", granted: []Code{OrgManage}, required: OrgManage, want: true},
		{name: "member may receive requests.address_groups", role: "member", granted: []Code{RequestsAddressGroups}, required: RequestsAddressGroups, want: true},
		{name: "admin does not get requests.address_groups without a grant", role: "admin", granted: []Code{MembersManage, KnowledgeManage}, required: RequestsAddressGroups, want: false},
		{name: "admin does not get org.manage without a grant", role: "admin", granted: []Code{MembersManage}, required: OrgManage, want: false},
		{name: "owner always addresses groups", role: "owner", required: RequestsAddressGroups, want: true},
		{name: "unknown permission is denied", role: "owner", required: Code("unknown"), want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := Allows(test.role, test.granted, test.required); got != test.want {
				t.Fatalf("Allows() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestEffective(t *testing.T) {
	owner := Effective("owner", nil)
	if len(owner) != len(All()) {
		t.Fatalf("owner permissions = %d, want %d", len(owner), len(All()))
	}
	admin := Effective("admin", []Code{AuditRead, AuditRead, Code("unknown")})
	if len(admin) != 1 || admin[0] != AuditRead {
		t.Fatalf("admin permissions = %#v", admin)
	}
	if member := Effective("member", []Code{AuditRead}); member == nil || len(member) != 0 {
		t.Fatalf("member permissions = %#v, want non-nil empty slice", member)
	}
	if member := Effective("member", []Code{AuditRead, KnowledgeManage}); len(member) != 1 || member[0] != KnowledgeManage {
		t.Fatalf("member permissions = %#v, want knowledge.manage only", member)
	}
}

func TestCanManageOrg(t *testing.T) {
	tests := []struct {
		name    string
		role    string
		granted []Code
		want    bool
	}{
		{name: "owner", role: "owner", want: true},
		{name: "admin with members.manage", role: "admin", granted: []Code{MembersManage}, want: true},
		{name: "admin with org.manage", role: "admin", granted: []Code{OrgManage}, want: true},
		{name: "admin without either", role: "admin", granted: []Code{KnowledgeManage, AuditRead}, want: false},
		{name: "member with org.manage", role: "member", granted: []Code{OrgManage}, want: true},
		{name: "member with members.manage stored by mistake", role: "member", granted: []Code{MembersManage}, want: false},
		{name: "plain member", role: "member", want: false},
		{name: "unknown role", role: "guest", granted: []Code{OrgManage}, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := CanManageOrg(test.role, test.granted); got != test.want {
				t.Fatalf("CanManageOrg() = %v, want %v", got, test.want)
			}
		})
	}
}
