package message

import (
	"context"
	"fmt"

	"github.com/comamessenger/comamessenger/core/internal/authz"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
)

// The functions below let the scheduled message service reuse the ordinary
// send path: the same validation, authorization, idempotency and events.

// ValidateCreate normalizes and validates a person's message input without
// touching the database.
func (s *Service) ValidateCreate(chatID string, input *CreateInput) error {
	if input.Blocks != nil || input.RunID != nil {
		return invalid("scheduled messages are plain messages of people")
	}
	return s.validateCreate(chatID, input)
}

// AuthorizeCreateTx checks inside tx everything the ordinary send checks
// before writing: active membership in a live chat, the right to write or
// reply, the reply target and thread, the mentions and that every file is
// ready and owned by user. It writes nothing. input must be validated.
func (s *Service) AuthorizeCreateTx(ctx context.Context, tx pgx.Tx, user identity.User, chatID string, input CreateInput) error {
	kind, role, err := requireMembership(ctx, tx, user, chatID)
	if err != nil {
		return err
	}
	if err := s.authorizeWrite(ctx, tx, user, chatID, kind, role, input); err != nil {
		return err
	}
	if err := validateReferences(ctx, tx, user.OrgID, chatID, input.ReplyToID, input.ThreadRootID); err != nil {
		return err
	}
	if err := validateMentions(ctx, tx, user.OrgID, chatID, input.MentionedActorIDs); err != nil {
		return err
	}
	return validateFiles(ctx, tx, user, input.FileIDs)
}

func (s *Service) authorizeWrite(ctx context.Context, tx pgx.Tx, user identity.User, chatID, kind, role string, input CreateInput) error {
	action := authz.MessagePublish
	if input.ThreadRootID != nil {
		action = authz.ThreadReply
	}
	if !can(user, kind, role, action) {
		return ErrForbidden
	}
	var isAgent bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM agents WHERE org_id=$1 AND actor_id=$2)`, user.OrgID, user.ActorID).Scan(&isAgent); err != nil {
		return fmt.Errorf("check message author: %w", err)
	}
	if isAgent {
		return ErrForbidden
	}
	return nil
}

// CreateTx publishes a person's message inside the caller's transaction.
// The caller commits and, when created is true, calls NotifyCommitted with
// the returned high watermark. input must be validated by ValidateCreate.
func (s *Service) CreateTx(ctx context.Context, tx pgx.Tx, user identity.User, chatID string, input CreateInput) (Message, bool, int64, error) {
	return s.createTx(ctx, tx, user, chatID, input, nil, false)
}

// NotifyCommitted wakes realtime delivery after a committed CreateTx.
func (s *Service) NotifyCommitted(orgID string, highWatermark int64) {
	s.notifyAfterCommit(orgID, highWatermark)
}

// CommandFingerprint is the idempotency fingerprint of a message command.
func CommandFingerprint(chatID string, input CreateInput) [32]byte {
	return commandFingerprint(chatID, input)
}
