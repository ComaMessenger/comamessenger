package message

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// DirectWrite is an agent message about to be created in a direct chat with
// a person.
type DirectWrite struct {
	OrgID   string
	AgentID string
	ChatID  string
	// RunID is the run the message belongs to; empty for an external agent
	// writing through the REST API without a run.
	RunID string
	// Final marks the closing answer of the run in its own chat.
	Final bool
}

// DirectGuard decides whether an agent may write to a person directly. It
// runs inside the message transaction.
type DirectGuard func(ctx context.Context, tx pgx.Tx, write DirectWrite) error

// SetDirectGuard installs the rule for agent writes to direct chats. Without
// one, agents cannot write to direct chats at all.
func (s *Service) SetDirectGuard(guard DirectGuard) { s.directGuard = guard }

type approvedWriteKey struct{}

// WithApprovedWrite marks a write a person has already decided on: an
// approved tool call, or a reminder of a collection started under the
// agent's policy.
func WithApprovedWrite(ctx context.Context) context.Context {
	return context.WithValue(ctx, approvedWriteKey{}, true)
}

// ApprovedWrite reports whether ctx carries a decided write.
func ApprovedWrite(ctx context.Context) bool {
	approved, _ := ctx.Value(approvedWriteKey{}).(bool)
	return approved
}
