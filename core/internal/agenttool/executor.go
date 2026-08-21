package agenttool

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/agentmemory"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/search"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

var (
	ErrInvalid              = errors.New("invalid agent tool call")
	ErrForbidden            = errors.New("agent tool call forbidden")
	ErrConfirmationRequired = errors.New("agent tool call confirmation required")
	ErrOutputTooLarge       = errors.New("agent tool output too large")
)

type Definition struct {
	Name          string         `json:"name"`
	Description   string         `json:"description"`
	Mode          string         `json:"mode"`
	RequiredScope agent.Scope    `json:"required_scope"`
	InputSchema   map[string]any `json:"input_schema"`
	compiled      *jsonschema.Schema
}

type Invocation struct {
	User          identity.User
	Identity      access.Identity
	Name          string
	Arguments     json.RawMessage
	RunID         string
	CorrelationID string
	Confirmed     bool
}

type Services struct {
	Chats    *chat.Service
	Messages *message.Service
	Search   *search.Service
	Files    *files.Service
	Memory   *agentmemory.Service
}

type Executor struct {
	pool                     *pgxpool.Pool
	services                 Services
	definitions              map[string]Definition
	maxOutputBytes           int
	requireWriteConfirmation bool
}

func NewExecutor(pool *pgxpool.Pool, services Services, requireWriteConfirmation bool) (*Executor, error) {
	if pool == nil || services.Chats == nil || services.Messages == nil || services.Search == nil || services.Files == nil || services.Memory == nil {
		return nil, fmt.Errorf("agent tool services are incomplete")
	}
	definitions, err := compileDefinitions()
	if err != nil {
		return nil, err
	}
	return &Executor{pool: pool, services: services, definitions: definitions, maxOutputBytes: 1 << 20, requireWriteConfirmation: requireWriteConfirmation}, nil
}

func (executor *Executor) Definitions() []Definition {
	order := []string{"get_chat_messages", "get_thread", "search_messages", "post_message", "reply_in_thread", "add_reaction", "get_file_text", "list_members", "remember", "recall"}
	result := make([]Definition, 0, len(order))
	for _, name := range order {
		definition := executor.definitions[name]
		definition.compiled = nil
		result = append(result, definition)
	}
	return result
}

func (executor *Executor) Invoke(ctx context.Context, invocation Invocation) (json.RawMessage, error) {
	definition, exists := executor.definitions[invocation.Name]
	if !exists || invocation.Identity.AuthenticationKind != "api_key" || invocation.Identity.ActorID != invocation.User.ActorID || invocation.Identity.OrgID != invocation.User.OrgID {
		return nil, ErrForbidden
	}
	if _, err := uuid.Parse(invocation.CorrelationID); err != nil {
		return nil, fmt.Errorf("%w: correlation_id must be a UUID", ErrInvalid)
	}
	if invocation.RunID != "" {
		if _, err := uuid.Parse(invocation.RunID); err != nil {
			return nil, fmt.Errorf("%w: run_id must be a UUID", ErrInvalid)
		}
	}
	if !hasScope(invocation.Identity.Scopes, string(definition.RequiredScope)) {
		return nil, ErrForbidden
	}
	if executor.requireWriteConfirmation && definition.Mode == "write" && !invocation.Confirmed {
		return nil, ErrConfirmationRequired
	}
	var document any
	if err := json.Unmarshal(invocation.Arguments, &document); err != nil {
		return nil, fmt.Errorf("%w: arguments must be JSON", ErrInvalid)
	}
	if err := definition.compiled.Validate(document); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	callID, err := id.New()
	if err != nil {
		return nil, err
	}
	if err := executor.startCall(ctx, callID, invocation, definition); err != nil {
		return nil, err
	}
	result, callErr := executor.execute(ctx, invocation)
	encoded := json.RawMessage(nil)
	if callErr == nil {
		encoded, callErr = json.Marshal(result)
		if callErr == nil && len(encoded) > executor.maxOutputBytes {
			callErr = ErrOutputTooLarge
			encoded = nil
		}
	}
	if err := executor.finishCall(ctx, callID, invocation, definition, len(encoded), callErr); err != nil {
		return nil, err
	}
	return encoded, callErr
}

func (executor *Executor) execute(ctx context.Context, invocation Invocation) (any, error) {
	switch invocation.Name {
	case "get_chat_messages":
		var input struct {
			ChatID    string `json:"chat_id"`
			BeforeSeq *int64 `json:"before_seq"`
			Limit     int    `json:"limit"`
		}
		_ = json.Unmarshal(invocation.Arguments, &input)
		return executor.services.Messages.List(ctx, invocation.User, input.ChatID, message.ListOptions{BeforeSeq: input.BeforeSeq, Limit: input.Limit})
	case "get_thread":
		var input struct {
			MessageID string `json:"message_id"`
			BeforeSeq *int64 `json:"before_seq"`
			Limit     int    `json:"limit"`
		}
		_ = json.Unmarshal(invocation.Arguments, &input)
		return executor.services.Messages.ListThread(ctx, invocation.User, input.MessageID, message.ListOptions{BeforeSeq: input.BeforeSeq, Limit: input.Limit})
	case "search_messages":
		var input struct {
			Query  string `json:"query"`
			ChatID string `json:"chat_id"`
			Limit  int    `json:"limit"`
		}
		_ = json.Unmarshal(invocation.Arguments, &input)
		return executor.services.Search.Search(ctx, invocation.User, search.Input{Query: input.Query, ChatID: input.ChatID, Type: "message", Limit: input.Limit})
	case "post_message", "reply_in_thread":
		var input struct {
			ChatID            string   `json:"chat_id"`
			ClientMsgID       string   `json:"client_msg_id"`
			Body              string   `json:"body"`
			BodyFormat        string   `json:"body_format"`
			ThreadRootID      *string  `json:"thread_root_id"`
			MentionedActorIDs []string `json:"mentioned_actor_ids"`
			FileIDs           []string `json:"file_ids"`
		}
		if err := json.Unmarshal(invocation.Arguments, &input); err != nil {
			return nil, err
		}
		if input.BodyFormat == "" {
			input.BodyFormat = "plain"
		}
		if invocation.Name == "reply_in_thread" && input.ThreadRootID != nil {
			root := *input.ThreadRootID
			input.ThreadRootID = &root
		}
		created, _, err := executor.services.Messages.Create(ctx, invocation.User, input.ChatID, message.CreateInput{ClientMsgID: input.ClientMsgID, Body: input.Body, BodyFormat: input.BodyFormat, ThreadRootID: input.ThreadRootID, ReplyToID: input.ThreadRootID, MentionedActorIDs: input.MentionedActorIDs, FileIDs: input.FileIDs})
		return created, err
	case "add_reaction":
		var input struct {
			MessageID string `json:"message_id"`
			Emoji     string `json:"emoji"`
		}
		_ = json.Unmarshal(invocation.Arguments, &input)
		result, _, err := executor.services.Messages.PutReaction(ctx, invocation.User, input.MessageID, input.Emoji)
		return result, err
	case "get_file_text":
		var input struct {
			FileID   string `json:"file_id"`
			MaxChars int    `json:"max_chars"`
		}
		_ = json.Unmarshal(invocation.Arguments, &input)
		return executor.services.Files.GetText(ctx, invocation.User, input.FileID, input.MaxChars)
	case "list_members":
		var input struct {
			ChatID string `json:"chat_id"`
		}
		_ = json.Unmarshal(invocation.Arguments, &input)
		return executor.services.Chats.ListMembers(ctx, invocation.User, input.ChatID)
	case "remember":
		var input struct {
			Namespace string          `json:"namespace"`
			Key       string          `json:"key"`
			Value     json.RawMessage `json:"value"`
		}
		_ = json.Unmarshal(invocation.Arguments, &input)
		return executor.services.Memory.Remember(ctx, invocation.User, input.Namespace, input.Key, input.Value)
	case "recall":
		var input struct {
			Namespace string   `json:"namespace"`
			Keys      []string `json:"keys"`
			Prefix    string   `json:"prefix"`
			Limit     int      `json:"limit"`
		}
		_ = json.Unmarshal(invocation.Arguments, &input)
		return executor.services.Memory.Recall(ctx, invocation.User, agentmemory.RecallInput{Namespace: input.Namespace, Keys: input.Keys, Prefix: input.Prefix, Limit: input.Limit})
	default:
		return nil, ErrInvalid
	}
}

func (executor *Executor) startCall(ctx context.Context, callID string, invocation Invocation, definition Definition) error {
	var runID any
	if invocation.RunID != "" {
		runID = invocation.RunID
	}
	summary, _ := json.Marshal(map[string]any{"argument_bytes": len(invocation.Arguments)})
	_, err := executor.pool.Exec(ctx, `INSERT INTO agent_tool_calls(id,org_id,agent_id,run_id,correlation_id,tool_name,mode,required_scope,input_summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, callID, invocation.User.OrgID, invocation.User.ActorID, runID, invocation.CorrelationID, definition.Name, definition.Mode, string(definition.RequiredScope), summary)
	if err != nil {
		return fmt.Errorf("record agent tool call: %w", err)
	}
	return nil
}

func (executor *Executor) finishCall(ctx context.Context, callID string, invocation Invocation, definition Definition, outputBytes int, callErr error) error {
	status, errorCode := "completed", ""
	if callErr != nil {
		status = "failed"
		errorCode = classifyError(callErr)
	}
	auditID, err := id.New()
	if err != nil {
		return err
	}
	tx, err := executor.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `UPDATE agent_tool_calls SET status=$2,output_bytes=$3,error_code=$4,finished_at=now() WHERE id=$1 AND status='running'`, callID, status, outputBytes, errorCode)
	if err != nil || result.RowsAffected() != 1 {
		if err == nil {
			err = pgx.ErrNoRows
		}
		return fmt.Errorf("finish agent tool call: %w", err)
	}
	metadata, _ := json.Marshal(map[string]any{"tool_call_id": callID, "run_id": invocation.RunID, "correlation_id": invocation.CorrelationID, "tool": definition.Name, "mode": definition.Mode, "required_scope": definition.RequiredScope, "status": status, "error_code": errorCode, "output_bytes": outputBytes})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'agent.tool.call','agent',$3,$4)`, auditID, invocation.User.OrgID, invocation.User.ActorID, metadata); err != nil {
		return fmt.Errorf("audit agent tool call: %w", err)
	}
	return tx.Commit(ctx)
}

func hasScope(scopes []string, wanted string) bool {
	for _, scope := range scopes {
		if scope == wanted {
			return true
		}
	}
	return false
}
func classifyError(err error) string {
	switch {
	case errors.Is(err, ErrForbidden):
		return "forbidden"
	case errors.Is(err, ErrInvalid), errors.Is(err, message.ErrInvalid), errors.Is(err, search.ErrInvalid), errors.Is(err, files.ErrInvalid), errors.Is(err, agentmemory.ErrInvalid):
		return "validation_failed"
	case errors.Is(err, message.ErrNotFound), errors.Is(err, files.ErrNotFound), errors.Is(err, chat.ErrNotFound):
		return "not_found"
	case errors.Is(err, message.ErrForbidden), errors.Is(err, files.ErrForbidden), errors.Is(err, chat.ErrForbidden):
		return "forbidden"
	case errors.Is(err, ErrOutputTooLarge):
		return "output_too_large"
	default:
		return "internal_error"
	}
}

func compileDefinitions() (map[string]Definition, error) {
	definitions := rawDefinitions()
	result := make(map[string]Definition, len(definitions))
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	for _, definition := range definitions {
		location := "https://comamessenger.local/schemas/agent-tools/" + definition.Name
		encoded, err := json.Marshal(definition.InputSchema)
		if err != nil {
			return nil, err
		}
		var schemaDocument any
		if err := json.Unmarshal(encoded, &schemaDocument); err != nil {
			return nil, err
		}
		if err := compiler.AddResource(location, schemaDocument); err != nil {
			return nil, err
		}
		compiled, err := compiler.Compile(location)
		if err != nil {
			return nil, err
		}
		definition.compiled = compiled
		result[definition.Name] = definition
	}
	return result, nil
}

func rawDefinitions() []Definition {
	uuidSchema := map[string]any{"type": "string", "format": "uuid"}
	positive := map[string]any{"type": "integer", "minimum": 1}
	limit := map[string]any{"type": "integer", "minimum": 1, "maximum": 100}
	object := func(required []string, properties map[string]any) map[string]any {
		result := map[string]any{"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "additionalProperties": false, "properties": properties}
		if len(required) > 0 {
			result["required"] = required
		}
		return result
	}
	return []Definition{
		{Name: "get_chat_messages", Description: "Read recent root messages from a chat.", Mode: "read", RequiredScope: agent.ScopeMessagesRead, InputSchema: object([]string{"chat_id"}, map[string]any{"chat_id": uuidSchema, "before_seq": positive, "limit": limit})},
		{Name: "get_thread", Description: "Read replies in a message thread.", Mode: "read", RequiredScope: agent.ScopeMessagesRead, InputSchema: object([]string{"message_id"}, map[string]any{"message_id": uuidSchema, "before_seq": positive, "limit": limit})},
		{Name: "search_messages", Description: "Search messages visible to the agent.", Mode: "read", RequiredScope: agent.ScopeSearchRead, InputSchema: object([]string{"query"}, map[string]any{"query": map[string]any{"type": "string", "minLength": 1, "maxLength": 200}, "chat_id": uuidSchema, "limit": limit})},
		{Name: "post_message", Description: "Post a message to a chat.", Mode: "write", RequiredScope: agent.ScopeMessagesWrite, InputSchema: messageSchema(object, uuidSchema, false)},
		{Name: "reply_in_thread", Description: "Reply to a thread.", Mode: "write", RequiredScope: agent.ScopeMessagesWrite, InputSchema: messageSchema(object, uuidSchema, true)},
		{Name: "add_reaction", Description: "Add a reaction to a message.", Mode: "write", RequiredScope: agent.ScopeReactionsWrite, InputSchema: object([]string{"message_id", "emoji"}, map[string]any{"message_id": uuidSchema, "emoji": map[string]any{"type": "string", "minLength": 1, "maxLength": 16}})},
		{Name: "get_file_text", Description: "Read bounded extracted text from an accessible file.", Mode: "read", RequiredScope: agent.ScopeFilesRead, InputSchema: object([]string{"file_id"}, map[string]any{"file_id": uuidSchema, "max_chars": map[string]any{"type": "integer", "minimum": 1, "maximum": 100000}})},
		{Name: "list_members", Description: "List active members of a chat.", Mode: "read", RequiredScope: agent.ScopeMembersRead, InputSchema: object([]string{"chat_id"}, map[string]any{"chat_id": uuidSchema})},
		{Name: "remember", Description: "Store a namespaced JSON memory value.", Mode: "write", RequiredScope: agent.ScopeMemoryWrite, InputSchema: object([]string{"key", "value"}, map[string]any{"namespace": map[string]any{"type": "string", "pattern": "^[a-z0-9][a-z0-9_.-]{0,63}$"}, "key": map[string]any{"type": "string", "minLength": 1, "maxLength": 255}, "value": map[string]any{}})},
		{Name: "recall", Description: "Recall namespaced memory values by key or prefix.", Mode: "read", RequiredScope: agent.ScopeMemoryRead, InputSchema: object(nil, map[string]any{"namespace": map[string]any{"type": "string", "pattern": "^[a-z0-9][a-z0-9_.-]{0,63}$"}, "keys": map[string]any{"type": "array", "maxItems": 100, "uniqueItems": true, "items": map[string]any{"type": "string", "minLength": 1, "maxLength": 255}}, "prefix": map[string]any{"type": "string", "maxLength": 255}, "limit": limit})},
	}
}

func messageSchema(object func([]string, map[string]any) map[string]any, uuidSchema map[string]any, thread bool) map[string]any {
	required := []string{"chat_id", "client_msg_id", "body"}
	if thread {
		required = append(required, "thread_root_id")
	}
	properties := map[string]any{"chat_id": uuidSchema, "client_msg_id": uuidSchema, "body": map[string]any{"type": "string", "maxLength": 65536}, "body_format": map[string]any{"type": "string", "enum": []string{"plain", "markdown"}}, "thread_root_id": uuidSchema, "mentioned_actor_ids": map[string]any{"type": "array", "maxItems": 100, "uniqueItems": true, "items": uuidSchema}, "file_ids": map[string]any{"type": "array", "maxItems": 20, "uniqueItems": true, "items": uuidSchema}}
	return object(required, properties)
}
