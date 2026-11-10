package pilotseed_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/agentmemory"
	"github.com/comamessenger/comamessenger/core/internal/agenttool"
	"github.com/comamessenger/comamessenger/core/internal/agenttrigger"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/interactive"
	"github.com/comamessenger/comamessenger/core/internal/knowledge"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/pilotseed"
	"github.com/comamessenger/comamessenger/core/internal/search"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// plainHasher keeps tests fast; the seed command uses the Argon2id hasher.
type plainHasher struct{}

func (plainHasher) Hash(value string) (string, error) { return "test$" + value, nil }

// clock is the shared fake time of the scripted runtime and Core services.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Set(at time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = at
}

func (c *clock) Advance(by time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(by)
}

// world is the seeded demo centre with the services a scripted runtime
// drives: it plays the model's tool calls the recipe instructions describe,
// so the platform side of each pilot scenario runs for real.
type world struct {
	t           *testing.T
	ctx         context.Context
	pool        *pgxpool.Pool
	clock       *clock
	seed        pilotseed.Result
	messages    *message.Service
	chats       *chat.Service
	interactive *interactive.Service
	executor    *agenttool.Executor
	triggers    *agenttrigger.Service
	agents      *agent.Service
}

func newWorld(t *testing.T, limits interactive.Limits) *world {
	t.Helper()
	ctx := context.Background()
	pool := testdb.New(t)
	store, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	fileService, err := files.NewService(pool, store, "", 16<<20, 8<<20, 4<<20, time.Hour, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	knowledgeService := knowledge.NewService(pool, fileService, nil, nil)
	if _, err := knowledge.NewIndexingClient(pool, knowledgeService, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	chats := chat.NewService(pool)
	messages := message.NewService(pool, 64*1024, 100, nil)
	agents := agent.NewService(pool)
	moscow, _ := time.LoadLocation("Europe/Moscow")
	// Today, 07:00 in the centre: before the first slot of the seeded table.
	today := time.Now().In(moscow)
	fake := &clock{now: time.Date(today.Year(), today.Month(), today.Day(), 7, 0, 0, 0, moscow)}
	seed, err := pilotseed.Seed(ctx, pilotseed.Deps{Pool: pool, Hasher: plainHasher{}, Files: fileService, Knowledge: knowledgeService, Chats: chats, Messages: messages, Agents: agents},
		pilotseed.Options{Password: "demo-pilot-password", Now: fake.Now()})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	interactiveService := interactive.NewService(pool, messages, chats, nil, limits)
	interactiveService.SetClock(fake.Now)
	messages.SetActionHook(interactiveService.ActionHook())
	executor, err := agenttool.NewExecutor(pool, agenttool.Services{Chats: chats, Messages: messages, Search: search.NewService(pool), Files: fileService,
		Memory: agentmemory.NewService(pool), Knowledge: knowledgeService, Interactive: interactiveService}, true)
	if err != nil {
		t.Fatal(err)
	}
	messages.SetConfirmationDecider(executor)
	triggers := agenttrigger.NewService(pool, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return &world{t: t, ctx: ctx, pool: pool, clock: fake, seed: seed, messages: messages, chats: chats, interactive: interactiveService,
		executor: executor, triggers: triggers, agents: agents}
}

// quietless are server limits without quiet hours, so reminders depend only on
// the per-person caps a test sets.
func quietless() interactive.Limits {
	limits := interactive.DefaultLimits()
	limits.QuietStartMinute, limits.QuietEndMinute = 0, 0
	return limits
}

// publish turns a seeded draft into a running agent the way publishing does
// for the parts these tests need: enabled, a published version and an
// approved model connection are outside the scenario.
func (w *world) publish(recipe string) agent.Agent {
	w.t.Helper()
	created := w.seed.Agents[recipe]
	if _, err := w.pool.Exec(w.ctx, `UPDATE agents SET enabled=true,published_version=1,operational_status='active',external_data_sharing_approved=true WHERE actor_id=$1`, created.ID); err != nil {
		w.t.Fatal(err)
	}
	return created
}

func (w *world) person(key string) identity.User {
	return w.seed.People[key]
}

// run is one claimed agent run the scripted runtime plays.
type run struct {
	id, lease, correlation string
	agent                  agent.Agent
	input                  map[string]any
	chatID                 string
}

// claim takes the newest queued run of the agent, as the runtime does.
func (w *world) claim(agentID, triggerType string) run {
	w.t.Helper()
	var result run
	var raw json.RawMessage
	var chatID *string
	err := w.pool.QueryRow(w.ctx, `SELECT id,input,chat_id FROM agent_runs WHERE agent_id=$1 AND status='queued' AND input->>'trigger_type'=$2 ORDER BY created_at DESC LIMIT 1`, agentID, triggerType).Scan(&result.id, &raw, &chatID)
	if err != nil {
		w.t.Fatalf("no queued %s run of %s: %v", triggerType, agentID, err)
	}
	if err := json.Unmarshal(raw, &result.input); err != nil {
		w.t.Fatal(err)
	}
	if chatID != nil {
		result.chatID = *chatID
	}
	result.lease, result.correlation = uuid.NewString(), uuid.NewString()
	if _, err := w.pool.Exec(w.ctx, `UPDATE agent_runs SET status='running',lease_token=$2,lease_expires_at=now()+interval '5 minutes',started_at=now(),timeout_at=now()+interval '10 minutes',correlation_id=$3 WHERE id=$1`,
		result.id, result.lease, result.correlation); err != nil {
		w.t.Fatal(err)
	}
	for _, created := range w.seed.Agents {
		if created.ID == agentID {
			result.agent = created
		}
	}
	return result
}

func (w *world) finish(r run) {
	w.t.Helper()
	if _, err := w.pool.Exec(w.ctx, `UPDATE agent_runs SET status='completed',finished_at=now(),lease_token=NULL,lease_expires_at=NULL WHERE id=$1`, r.id); err != nil {
		w.t.Fatal(err)
	}
}

// call invokes a tool as the runtime does, with exactly the scopes the recipe
// gave the agent: a recipe missing a scope fails here.
func (w *world) call(r run, name string, arguments any) json.RawMessage {
	w.t.Helper()
	output, err := w.tryCall(r, name, arguments)
	if err != nil {
		w.t.Fatalf("%s: %v", name, err)
	}
	return output
}

func (w *world) tryCall(r run, name string, arguments any) (json.RawMessage, error) {
	encoded, err := json.Marshal(arguments)
	if err != nil {
		return nil, err
	}
	var scopes []string
	if err := w.pool.QueryRow(w.ctx, `SELECT allowed_scopes FROM agents WHERE actor_id=$1`, r.agent.ID).Scan(&scopes); err != nil {
		return nil, err
	}
	authentication := access.Identity{AuthenticationKind: "api_key", ActorID: r.agent.ID, OrgID: w.seed.OrgID, KeyID: uuid.NewString(), Scopes: scopes}
	result, err := w.executor.Invoke(w.ctx, agenttool.Invocation{User: identity.User{ActorID: r.agent.ID, OrgID: w.seed.OrgID, OrgRole: "member"}, Identity: authentication,
		Name: name, Arguments: encoded, RunID: r.id, LeaseToken: r.lease, CorrelationID: r.correlation, ToolCallID: uuid.NewString()})
	if err != nil {
		return nil, err
	}
	if result.Confirmation != nil {
		return nil, errors.New(name + " waits for a confirmation; pilot recipes must work without one")
	}
	return result.Output, nil
}

func decode[T any](t *testing.T, raw json.RawMessage) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return value
}

// say posts a human message, optionally mentioning people or agents.
func (w *world) say(person, chatKey, body string, threadRoot string, mentions ...string) message.Message {
	w.t.Helper()
	input := message.CreateInput{ClientMsgID: uuid.NewString(), Body: body, MentionedActorIDs: mentions}
	if threadRoot != "" {
		input.ThreadRootID, input.ReplyToID = &threadRoot, &threadRoot
	}
	created, _, err := w.messages.Create(w.ctx, w.person(person), w.seed.Chats[chatKey], input)
	if err != nil {
		w.t.Fatalf("say: %v", err)
	}
	return created
}

func (w *world) tick() {
	w.t.Helper()
	if err := w.interactive.Tick(w.ctx); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) count(query string, args ...any) int {
	w.t.Helper()
	var value int
	if err := w.pool.QueryRow(w.ctx, query, args...).Scan(&value); err != nil {
		w.t.Fatalf("count %q: %v", query, err)
	}
	return value
}

// directChat is the direct chat between an agent and a person, if any.
func (w *world) directChat(agentID, actorID string) string {
	w.t.Helper()
	left, right := agentID, actorID
	if right < left {
		left, right = right, left
	}
	var chatID string
	err := w.pool.QueryRow(w.ctx, `SELECT id FROM chats WHERE org_id=$1 AND kind='direct' AND direct_pair_key=$2`, w.seed.OrgID, left+":"+right).Scan(&chatID)
	if err != nil && !strings.Contains(err.Error(), "no rows") {
		w.t.Fatal(err)
	}
	return chatID
}

func card(title string, status string, items []map[string]any, actions []map[string]any) map[string]any {
	blocks := map[string]any{"version": 1, "card": map[string]any{"title": title, "status": map[string]any{"label": status, "tone": "info"}}}
	if items != nil {
		blocks["card"].(map[string]any)["items"] = items
	}
	if actions != nil {
		blocks["actions"] = actions
	}
	return blocks
}
