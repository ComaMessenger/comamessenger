package authz

type Action string

const (
	ChatCreate       Action = "chat.create"
	ChannelCreate    Action = "channel.create"
	ChatRead         Action = "chat.read"
	ChatManage       Action = "chat.manage"
	MemberManage     Action = "member.manage"
	MessagePublish   Action = "message.publish"
	ThreadReply      Action = "thread.reply"
	InvitationCreate Action = "invitation.create"
	UserManage       Action = "user.manage"
)

type Role string

const (
	Owner  Role = "owner"
	Admin  Role = "admin"
	Member Role = "member"
)

type ChatKind string

const (
	Direct  ChatKind = "direct"
	Group   ChatKind = "group"
	Channel ChatKind = "channel"
)

type Context struct {
	Active     bool
	OrgRole    Role
	ChatKind   ChatKind
	ChatMember bool
	ChatRole   Role
}

func Can(ctx Context, action Action) bool {
	if !ctx.Active {
		return false
	}

	switch action {
	case ChatCreate:
		return true
	case ChannelCreate, InvitationCreate, UserManage:
		return ctx.OrgRole == Owner || ctx.OrgRole == Admin
	case ChatRead:
		return ctx.ChatMember
	case ChatManage, MemberManage:
		return ctx.ChatMember && (ctx.ChatRole == Owner || ctx.ChatRole == Admin)
	case MessagePublish, ThreadReply:
		if !ctx.ChatMember {
			return false
		}
		if ctx.ChatKind == Channel {
			return ctx.ChatRole == Owner || ctx.ChatRole == Admin
		}
		return true
	default:
		return false
	}
}
