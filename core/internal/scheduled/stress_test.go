package scheduled

// Stress tests for the lock order described at message.lockOrganization.
// They grew out of the security reviewer's probes for PR #22.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/png"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/scheduledreset"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/comamessenger/comamessenger/core/internal/userstate"
	"github.com/comamessenger/comamessenger/core/internal/workspace"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// load runs the workers concurrently for d and fails on any deadlock.
type load struct {
	t         *testing.T
	stop      chan struct{}
	wait      sync.WaitGroup
	deadlocks atomic.Int64
	calls     atomic.Int64
}

func newLoad(t *testing.T) *load { return &load{t: t, stop: make(chan struct{})} }

func (l *load) worker(name string, fn func(i int) error) {
	l.wait.Add(1)
	go func() {
		defer l.wait.Done()
		for i := 0; ; i++ {
			select {
			case <-l.stop:
				return
			default:
			}
			err := fn(i)
			l.calls.Add(1)
			var pg *pgconn.PgError
			if errors.As(err, &pg) && pg.Code == "40P01" {
				l.deadlocks.Add(1)
				l.t.Logf("deadlock in %s: %s", name, pg.Detail)
			}
		}
	}()
}

func (l *load) run(d time.Duration) {
	time.Sleep(d)
	close(l.stop)
	l.wait.Wait()
	l.t.Logf("calls=%d deadlocks=%d", l.calls.Load(), l.deadlocks.Load())
	if l.deadlocks.Load() != 0 {
		l.t.Fatalf("%d deadlocks", l.deadlocks.Load())
	}
}

func tinyPNG(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// Every kind of transaction that takes the organization row or a person's
// rows, at once: no deadlock, and the event sequence stays gapless and
// in order for a reader.
func TestEventSequenceUnderMixedLoad(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	w.service.SetLimits(Limits{PerAuthor: 1 << 20, PerChat: 1 << 20})
	states := userstate.NewService(w.pool, 1024, nil)
	store, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	fileService, err := files.NewService(w.pool, store, "", 64<<20, 8<<20, 4<<20, time.Hour, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	avatar := tinyPNG(t)
	identities := w.identityRepo()
	members := workspace.NewRepository(w.pool)
	var start int64
	if err := w.pool.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id=$1`, w.orgID).Scan(&start); err != nil {
		t.Fatal(err)
	}
	seed, _, err := w.messages.Create(ctx, w.owner.User, w.groupID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "seed"})
	if err != nil {
		t.Fatal(err)
	}

	l := newLoad(t)
	for range 3 {
		l.worker("send", func(int) error {
			_, _, err := w.messages.Create(ctx, w.owner.User, w.groupID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "x"})
			return err
		})
	}
	l.worker("react", func(i int) error {
		if i%2 == 0 {
			_, _, err := w.messages.PutReaction(ctx, w.other.User, seed.ID, "👍")
			return err
		}
		_, err := w.messages.DeleteReaction(ctx, w.other.User, seed.ID, "👍")
		return err
	})
	l.worker("pin", func(i int) error {
		if i%2 == 0 {
			_, _, err := w.messages.PutPin(ctx, w.owner.User, seed.ID)
			return err
		}
		_, err := w.messages.DeletePin(ctx, w.owner.User, seed.ID)
		return err
	})
	l.worker("draft", func(i int) error {
		_, _, err := states.PutDraft(ctx, w.other.User, w.other.SessionID, w.groupID, userstate.PutDraftInput{Body: fmt.Sprint("d", i), BodyFormat: "plain"})
		return err
	})
	l.worker("read", func(int) error {
		_, _, err := states.MarkChatRead(ctx, w.other.User, w.other.SessionID, w.groupID, 1<<40)
		return err
	})
	l.worker("schedule+sendnow", func(int) error {
		item, _, err := w.service.Create(ctx, w.author, w.groupID, w.input("s"))
		if err != nil {
			return err
		}
		_, err = w.service.SendNow(ctx, w.author, item.ID)
		return err
	})
	l.worker("status", func(i int) error {
		expires := time.Now().Add(-time.Second)
		_, _, err := identities.UpdateStatus(ctx, identity.User{OrgID: w.orgID, ActorID: w.author.User.ActorID}, identity.CustomStatus{Emoji: "🙂", Text: fmt.Sprint(i), ExpiresAt: &expires})
		return err
	})
	l.worker("status-expiry", func(int) error {
		_, err := identities.ExpireStatuses(ctx, time.Now(), 10)
		return err
	})
	l.worker("avatar", func(int) error {
		_, err := fileService.PutAvatar(ctx, w.author.User, w.author.User.ActorID, "image/png", bytes.NewReader(avatar))
		return err
	})
	l.worker("chat-avatar", func(int) error {
		_, err := fileService.PutChatAvatar(ctx, w.owner.User, w.groupID, "image/png", bytes.NewReader(avatar))
		return err
	})
	l.worker("password", func(int) error {
		_, err := identities.ChangePassword(ctx, w.orgID, w.admin.User.ActorID, w.admin.SessionID, "hash", uuid.NewString(), time.Now())
		return err
	})
	l.worker("require-password", func(int) error {
		_, err := members.RequirePasswordChange(ctx, w.orgID, w.owner.User.ActorID, w.admin.User.ActorID, "owner", time.Now())
		if errors.Is(err, workspace.ErrForbidden) {
			return nil
		}
		return err
	})
	l.worker("deactivate", func(i int) error {
		status := "deactivated"
		if i%2 == 1 {
			status = "active"
		}
		_, err := members.UpdateMember(ctx, w.orgID, w.owner.User.ActorID, w.other.User.ActorID, workspace.UpdateMemberInput{Status: &status})
		return err
	})
	l.worker("revoke-device", func(int) error {
		phone := w.secondSession(t)
		if _, _, err := w.service.Create(ctx, phone, w.groupID, w.input("from phone")); err != nil {
			return err
		}
		return identities.RevokeDevice(ctx, w.author.User.ActorID, phone.SessionID, time.Now())
	})
	l.worker("refresh-reuse", func(int) error {
		phone := w.secondSession(t)
		hash := w.setRefresh(t, phone.SessionID, uuid.NewString(), false)
		if err := w.rotate(hash); err != nil {
			return err
		}
		if err := w.rotate(hash); !errors.Is(err, identity.ErrRefreshReuse) {
			return err
		}
		return nil
	})
	l.worker("revoke-others", func(int) error {
		_, err := identities.RevokeOtherSessions(ctx, w.admin.User.ActorID, w.admin.SessionID, time.Now())
		return err
	})
	l.worker("reconcile", func(int) error {
		_, err := scheduledreset.Reconcile(ctx, w.pool, w.orgID, w.author.User.ActorID)
		return err
	})
	l.worker("cleanup", func(int) error {
		_, err := w.service.Cleanup(ctx)
		return err
	})
	// A reader must never see a hole that is filled later.
	var holes atomic.Int64
	l.wait.Add(1)
	go func() {
		defer l.wait.Done()
		seen := start
		for {
			select {
			case <-l.stop:
				return
			default:
			}
			rows, err := w.pool.Query(ctx, `SELECT seq FROM events WHERE org_id=$1 AND seq>$2 ORDER BY seq`, w.orgID, seen)
			if err != nil {
				continue
			}
			for rows.Next() {
				var seq int64
				_ = rows.Scan(&seq)
				if seq != seen+1 {
					holes.Add(1)
					break
				}
				seen = seq
			}
			rows.Close()
		}
	}()
	l.run(4 * time.Second)

	var count, minSeq, maxSeq, distinct, orgSeq int64
	if err := w.pool.QueryRow(ctx, `SELECT count(*), min(seq), max(seq), count(DISTINCT seq) FROM events WHERE org_id=$1 AND seq>$2`, w.orgID, start).
		Scan(&count, &minSeq, &maxSeq, &distinct); err != nil {
		t.Fatal(err)
	}
	if err := w.pool.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id=$1`, w.orgID).Scan(&orgSeq); err != nil {
		t.Fatal(err)
	}
	if count != distinct || maxSeq-minSeq+1 != count || maxSeq != orgSeq || holes.Load() != 0 {
		t.Fatalf("event sequence broken: events=%d distinct=%d range=[%d,%d] org=%d holes=%d", count, distinct, minSeq, maxSeq, orgSeq, holes.Load())
	}
}

// Custom statuses used to lock the actor before the organization, the
// reverse of sends.
func TestStatusUpdatesDoNotDeadlockWithSends(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	w.service.SetLimits(Limits{PerAuthor: 1 << 20, PerChat: 1 << 20})
	identities := w.identityRepo()
	l := newLoad(t)
	for range 2 {
		l.worker("status", func(i int) error {
			_, _, err := identities.UpdateStatus(ctx, identity.User{OrgID: w.orgID, ActorID: w.author.User.ActorID}, identity.CustomStatus{Emoji: "🙂", Text: fmt.Sprint(i)})
			return err
		})
		l.worker("schedule+sendnow", func(int) error {
			item, _, err := w.service.Create(ctx, w.author, w.groupID, w.input("s"))
			if err != nil {
				return err
			}
			_, err = w.service.SendNow(ctx, w.author, item.ID)
			return err
		})
		l.worker("send", func(int) error {
			_, _, err := w.messages.Create(ctx, w.author.User, w.groupID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "x"})
			return err
		})
	}
	l.run(3 * time.Second)
}

// Drafts and read markers used FOR UPDATE on the organization, which waits
// for the audit inserts of a deactivation that waits for them.
func TestDraftsDoNotDeadlockWithDeactivation(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	states := userstate.NewService(w.pool, 1024, nil)
	members := workspace.NewRepository(w.pool)
	l := newLoad(t)
	for range 2 {
		l.worker("draft", func(i int) error {
			_, _, err := states.PutDraft(ctx, w.other.User, w.other.SessionID, w.groupID, userstate.PutDraftInput{Body: fmt.Sprint("d", i), BodyFormat: "plain"})
			if err != nil && strings.Contains(err.Error(), "version") {
				return nil
			}
			return err
		})
		l.worker("read", func(int) error {
			_, _, err := states.MarkChatRead(ctx, w.other.User, w.other.SessionID, w.groupID, 1<<40)
			return err
		})
	}
	l.worker("deactivate", func(i int) error {
		status := "deactivated"
		if i%2 == 1 {
			status = "active"
		}
		_, err := members.UpdateMember(ctx, w.orgID, w.owner.User.ActorID, w.other.User.ActorID, workspace.UpdateMemberInput{Status: &status})
		return err
	})
	l.run(3 * time.Second)
}
