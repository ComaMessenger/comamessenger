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
