package realtime

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	redis "github.com/redis/go-redis/v9"
)

// Presence is tracked per connection and published per person: "online" when
// any connection is in the foreground, "away" when all are in the background,
// "offline" once the last one closes or stops confirming. Each change goes to
// the workspace once; an unchanged state is re-sent only after half the TTL so
// receivers can expire it when a server dies without saying goodbye.

const (
	maxPresenceSnapshot = 1500
	lastSeenWriteEvery  = time.Minute
)

type presenceChange struct {
	State     string // online, away or offline
	ExpiresAt time.Time
	Broadcast bool
}

type presenceEntry struct {
	ActorID   string    `json:"actor_id"`
	State     string    `json:"state"`
	ExpiresAt time.Time `json:"expires_at"`
}

type presenceSnapshotFrame struct {
	Op     string          `json:"op"`
	Actors []presenceEntry `json:"actors"`
}

type presenceTracker interface {
	// update records state ("active", "away", or "" to forget the connection).
	update(ctx context.Context, orgID, actorID, connectionID, state string, now time.Time) (presenceChange, error)
	snapshot(ctx context.Context, orgID string, now time.Time) ([]presenceEntry, error)
}

type connectionPresence struct {
	state     string
	expiresAt time.Time
}

type localPresence struct {
	ttl         time.Duration
	mu          sync.Mutex
	connections map[string]map[string]connectionPresence // org:actor → connection
	published   map[string]map[string]connectionPresence // org → actor
}

func newLocalPresence(ttl time.Duration) *localPresence {
	return &localPresence{ttl: ttl, connections: make(map[string]map[string]connectionPresence), published: make(map[string]map[string]connectionPresence)}
}

func (p *localPresence) update(_ context.Context, orgID, actorID, connectionID, state string, now time.Time) (presenceChange, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	key := orgID + ":" + actorID
	connections := p.connections[key]
	if connections == nil {
		connections = make(map[string]connectionPresence)
		p.connections[key] = connections
	}
	if state != "" {
		connections[connectionID] = connectionPresence{state: state, expiresAt: now.Add(p.ttl)}
	} else {
		delete(connections, connectionID)
	}
	aggregate := ""
	for id, item := range connections {
		switch {
		case !now.Before(item.expiresAt):
			delete(connections, id)
		case item.state == "active":
			aggregate = "online"
		case aggregate == "":
			aggregate = "away"
		}
	}
	if len(connections) == 0 {
		delete(p.connections, key)
	}
	published := p.published[orgID]
	if published == nil {
		published = make(map[string]connectionPresence)
		p.published[orgID] = published
	}
	previous, known := published[actorID]
	live := known && now.Before(previous.expiresAt)
	if aggregate == "" {
		delete(published, actorID)
		return presenceChange{State: "offline", ExpiresAt: now, Broadcast: live}, nil
	}
	if !live || previous.state != aggregate || previous.expiresAt.Sub(now) < p.ttl/2 {
		published[actorID] = connectionPresence{state: aggregate, expiresAt: now.Add(p.ttl)}
		return presenceChange{State: aggregate, ExpiresAt: now.Add(p.ttl), Broadcast: true}, nil
	}
	return presenceChange{State: aggregate, ExpiresAt: previous.expiresAt}, nil
}

func (p *localPresence) snapshot(_ context.Context, orgID string, now time.Time) ([]presenceEntry, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	result := make([]presenceEntry, 0)
	for actorID, item := range p.published[orgID] {
		if !now.Before(item.expiresAt) {
			delete(p.published[orgID], actorID)
			continue
		}
		if len(result) < maxPresenceSnapshot {
			result = append(result, presenceEntry{ActorID: actorID, State: item.state, ExpiresAt: item.expiresAt})
		}
	}
	return result, nil
}

// redisPresence keeps the same model in two hashes that share a cluster slot:
// one per person (connection → "state|expires_ms") and one per workspace
// (person → published "state|expires_ms").
type redisPresence struct {
	client    *redis.Client
	namespace string
	ttl       time.Duration
	timeout   time.Duration
}

var presenceUpdateScript = redis.NewScript(`
local now=tonumber(ARGV[4]); local ttl=tonumber(ARGV[5])
local function parse(v) local i=string.find(v,'|',1,true); return string.sub(v,1,i-1), tonumber(string.sub(v,i+1)) end
if ARGV[3] ~= '' then
  redis.call('HSET',KEYS[1],ARGV[2],ARGV[3]..'|'..(now+ttl)); redis.call('PEXPIRE',KEYS[1],ttl)
else
  redis.call('HDEL',KEYS[1],ARGV[2])
end
local all=redis.call('HGETALL',KEYS[1]); local agg=''
for i=1,#all,2 do
  local st,exp=parse(all[i+1])
  if exp<=now then redis.call('HDEL',KEYS[1],all[i]) elseif st=='active' then agg='online' elseif agg=='' then agg='away' end
end
local prev=redis.call('HGET',KEYS[2],ARGV[1]); local pst=''; local pexp=0
if prev then pst,pexp=parse(prev) end
local live=(prev and pexp>now) and 1 or 0
if agg=='' then redis.call('HDEL',KEYS[2],ARGV[1]); return {'offline',now,live} end
if live==0 or pst~=agg or (pexp-now)<ttl/2 then
  redis.call('HSET',KEYS[2],ARGV[1],agg..'|'..(now+ttl)); redis.call('PEXPIRE',KEYS[2],86400000)
  return {agg,now+ttl,1}
end
return {agg,pexp,0}`)

func (p *redisPresence) keys(orgID, actorID string) []string {
	tag := "{" + orgID + "}"
	return []string{p.namespace + ":presence:" + tag + ":conn:" + actorID, p.namespace + ":presence:" + tag + ":state"}
}

func (p *redisPresence) update(ctx context.Context, orgID, actorID, connectionID, state string, now time.Time) (presenceChange, error) {
	opCtx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	values, err := presenceUpdateScript.Run(opCtx, p.client, p.keys(orgID, actorID), actorID, connectionID, state, now.UnixMilli(), p.ttl.Milliseconds()).Slice()
	if err != nil || len(values) != 3 {
		return presenceChange{}, ErrEphemeralUnavailable
	}
	aggregate, _ := values[0].(string)
	expires, _ := values[1].(int64)
	broadcast, _ := values[2].(int64)
	return presenceChange{State: aggregate, ExpiresAt: time.UnixMilli(expires).UTC(), Broadcast: broadcast == 1}, nil
}

func (p *redisPresence) snapshot(ctx context.Context, orgID string, now time.Time) ([]presenceEntry, error) {
	opCtx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	key := p.keys(orgID, "")[1]
	values, err := p.client.HGetAll(opCtx, key).Result()
	if err != nil {
		return nil, ErrEphemeralUnavailable
	}
	result := make([]presenceEntry, 0, len(values))
	stale := make([]string, 0)
	for actorID, value := range values {
		state, rawExpires, ok := strings.Cut(value, "|")
		expires, parseErr := strconv.ParseInt(rawExpires, 10, 64)
		if !ok || parseErr != nil || expires <= now.UnixMilli() {
			stale = append(stale, actorID)
			continue
		}
		if len(result) < maxPresenceSnapshot {
			result = append(result, presenceEntry{ActorID: actorID, State: state, ExpiresAt: time.UnixMilli(expires).UTC()})
		}
	}
	if len(stale) > 0 {
		_ = p.client.HDel(opCtx, key, stale...).Err()
	}
	return result, nil
}

// PresenceSnapshot lists who is online or away in the user's workspace.
func (e *Ephemeral) PresenceSnapshot(ctx context.Context, user identity.User) (*presenceSnapshotFrame, error) {
	entries, err := e.presence.snapshot(ctx, user.OrgID, frameNow())
	if err != nil {
		return nil, err
	}
	return &presenceSnapshotFrame{Op: "presence.snapshot", Actors: entries}, nil
}

// Disconnected forgets a closed connection and tells the workspace when it
// was the person's last one.
func (e *Ephemeral) Disconnected(ctx context.Context, user identity.User, connectionID string) {
	now := frameNow()
	change, err := e.presence.update(ctx, user.OrgID, user.ActorID, connectionID, "", now)
	if err != nil {
		e.logger.Warn("forget presence connection", "actor_id", user.ActorID, "error", err)
		return
	}
	if !change.Broadcast {
		return
	}
	e.touchLastSeen(ctx, user, now)
	if err := e.broadcastPresence(ctx, user, connectionID, change, now); err != nil {
		e.logger.Warn("broadcast offline presence", "actor_id", user.ActorID, "error", err)
	}
}

// touchLastSeen stores users.last_seen_at at most once a minute per person:
// a cheap in-memory check first, then a guard in the UPDATE itself so other
// instances do not write more often either. Agents have no users row.
func (e *Ephemeral) touchLastSeen(ctx context.Context, user identity.User, now time.Time) {
	key := user.OrgID + ":" + user.ActorID
	e.mu.Lock()
	if last, ok := e.lastSeenWrites[key]; ok && now.Sub(last) < lastSeenWriteEvery {
		e.mu.Unlock()
		return
	}
	e.lastSeenWrites[key] = now
	if len(e.lastSeenWrites) > 4096 {
		for other, at := range e.lastSeenWrites {
			if now.Sub(at) >= lastSeenWriteEvery {
				delete(e.lastSeenWrites, other)
			}
		}
	}
	e.mu.Unlock()
	if _, err := e.pool.Exec(ctx, `UPDATE users SET last_seen_at=now() WHERE org_id=$1 AND actor_id=$2 AND (last_seen_at IS NULL OR last_seen_at <= now() - interval '1 minute')`, user.OrgID, user.ActorID); err != nil {
		e.logger.Warn("store last seen", "actor_id", user.ActorID, "error", err)
	}
}

// broadcastPresence sends the person's state to the workspace. Leaving
// (away/offline) carries last_seen_at only for those who share a chat with
// the person when neither side hides last seen; the rest get the state alone.
func (e *Ephemeral) broadcastPresence(ctx context.Context, user identity.User, excludeConnectionID string, change presenceChange, now time.Time) error {
	frame := presenceEventFrame{Op: "presence", ActorID: user.ActorID, State: change.State, ExpiresAt: change.ExpiresAt}
	if change.State == "online" {
		return e.broadcast(ctx, user, excludeConnectionID, "", false, frame)
	}
	rows, err := e.pool.Query(ctx, `
		SELECT a.id::text,
		       subject.actor_id IS NOT NULL
		       AND COALESCE(subject.preferences->>'last_seen_visibility','everyone') <> 'nobody'
		       AND COALESCE(viewer.preferences->>'last_seen_visibility','everyone') <> 'nobody'
		       AND EXISTS (SELECT 1 FROM chat_members mine JOIN chat_members theirs ON theirs.org_id=mine.org_id AND theirs.chat_id=mine.chat_id
		                   JOIN chats c ON c.org_id=mine.org_id AND c.id=mine.chat_id AND c.archived_at IS NULL
		                   WHERE mine.org_id=$1 AND mine.actor_id=$2 AND theirs.actor_id=a.id)
		FROM actors a
		LEFT JOIN users subject ON subject.org_id=$1 AND subject.actor_id=$2
		LEFT JOIN users viewer ON viewer.org_id=a.org_id AND viewer.actor_id=a.id
		WHERE a.org_id=$1 AND a.status='active' AND a.deleted_at IS NULL`, user.OrgID, user.ActorID)
	if err != nil {
		return fmt.Errorf("list presence recipients: %w", err)
	}
	defer rows.Close()
	withTime, without := make([]string, 0), make([]string, 0)
	for rows.Next() {
		var actorID string
		var shares bool
		if err := rows.Scan(&actorID, &shares); err != nil {
			return err
		}
		if shares {
			withTime = append(withTime, actorID)
		} else {
			without = append(without, actorID)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(without) > 0 {
		if err := e.publish(ctx, user.OrgID, without, excludeConnectionID, frame); err != nil {
			return err
		}
	}
	if len(withTime) > 0 {
		seen := now.UTC()
		frame.LastSeenAt = &seen
		return e.publish(ctx, user.OrgID, withTime, excludeConnectionID, frame)
	}
	return nil
}

// frameNow is the clock for ephemeral frames, cut to milliseconds: Hermes on
// the phone does not parse more than three fractional digits, so a
// nanosecond expires_at reads as NaN and the frame expires at once.
func frameNow() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }
