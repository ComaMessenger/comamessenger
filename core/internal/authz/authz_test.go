package authz

import "testing"

func TestCan(t *testing.T) {
	tests := []struct {
		name   string
		ctx    Context
		action Action
		want   bool
	}{
		{name: "inactive denied", ctx: Context{OrgRole: Owner, ChatMember: true, ChatRole: Owner}, action: ChatManage, want: false},
		{name: "member creates group", ctx: Context{Active: true, OrgRole: Member}, action: ChatCreate, want: true},
		{name: "member cannot create channel", ctx: Context{Active: true, OrgRole: Member}, action: ChannelCreate, want: false},
		{name: "admin creates channel", ctx: Context{Active: true, OrgRole: Admin}, action: ChannelCreate, want: true},
		{name: "non-member cannot read", ctx: Context{Active: true, OrgRole: Owner}, action: ChatRead, want: false},
		{name: "chat member reads", ctx: Context{Active: true, OrgRole: Member, ChatMember: true, ChatRole: Member}, action: ChatRead, want: true},
		{name: "chat member cannot manage", ctx: Context{Active: true, ChatMember: true, ChatRole: Member}, action: ChatManage, want: false},
		{name: "chat admin manages", ctx: Context{Active: true, ChatMember: true, ChatRole: Admin}, action: ChatManage, want: true},
		{name: "group member publishes", ctx: Context{Active: true, ChatKind: Group, ChatMember: true, ChatRole: Member}, action: MessagePublish, want: true},
		{name: "channel member cannot publish", ctx: Context{Active: true, ChatKind: Channel, ChatMember: true, ChatRole: Member}, action: MessagePublish, want: false},
		{name: "channel admin publishes", ctx: Context{Active: true, ChatKind: Channel, ChatMember: true, ChatRole: Admin}, action: MessagePublish, want: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := Can(test.ctx, test.action); got != test.want {
				t.Fatalf("Can() = %v, want %v", got, test.want)
			}
		})
	}
}
