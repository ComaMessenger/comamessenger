package poll_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/poll"
	"github.com/google/uuid"
)

func TestNormalize(t *testing.T) {
	now := time.Now().UTC()
	long := strings.Repeat("я", 301)
	cases := []struct {
		name  string
		spec  poll.CreateSpec
		field string
	}{
		{"empty question", poll.CreateSpec{Question: "  ", Options: []string{"a", "b"}}, "question"},
		{"long question", poll.CreateSpec{Question: long, Options: []string{"a", "b"}}, "question"},
		{"one option", poll.CreateSpec{Question: "q", Options: []string{"a"}}, "options"},
		{"eleven options", poll.CreateSpec{Question: "q", Options: strings.Split("a b c d e f g h i j k", " ")}, "options"},
		{"empty option", poll.CreateSpec{Question: "q", Options: []string{"a", " "}}, "options[1]"},
		{"long option", poll.CreateSpec{Question: "q", Options: []string{"a", strings.Repeat("x", 101)}}, "options[1]"},
		{"repeat ignoring case", poll.CreateSpec{Question: "q", Options: []string{"Среда", "среда"}}, "options"},
		{"due too soon", poll.CreateSpec{Question: "q", Options: []string{"a", "b"}, DueAt: ptr(now.Add(9 * time.Minute))}, "due_at"},
		{"due too far", poll.CreateSpec{Question: "q", Options: []string{"a", "b"}, DueAt: ptr(now.Add(91 * 24 * time.Hour))}, "due_at"},
	}
	for _, c := range cases {
		_, err := poll.Normalize(c.spec, now)
		var invalid *poll.InvalidError
		if !errors.As(err, &invalid) || invalid.Field != c.field {
			t.Errorf("%s: error = %v, want field %s", c.name, err, c.field)
		}
	}
	plan, err := poll.Normalize(poll.CreateSpec{Question: " Когда? ", Options: []string{" Среда", "Четверг "}, DueAt: ptr(now.Add(time.Hour))}, now)
	if err != nil || plan.Question != "Когда?" || !slices.Equal(plan.Options, []string{"Среда", "Четверг"}) {
		t.Fatalf("plan = %+v, %v", plan, err)
	}
	if body := poll.Body(plan.Question, plan.Options); body != "Опрос: Когда?\n\n— Среда\n— Четверг" {
		t.Fatalf("body = %q", body)
	}
}

func TestCreatePoll(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	due := w.clock.Now().Add(2 * time.Hour)
	created := w.create(t, w.author, message.CreatePollInput{DueAt: &due})
	if created.Type != "poll" || created.BodyFormat != "plain" || created.Body != "Опрос: Когда удобнее субботник?\n\n— Среда\n— Четверг\n— Суббота" {
		t.Fatalf("message = %+v", created)
	}
	p := created.Poll
	if p.Status != "open" || p.VoterCount != 0 || p.MemberCount != chatPeople || p.FinalCounts != nil || p.Version != 1 || p.DueAt == nil {
		t.Fatalf("poll = %+v", p)
	}
	if v := created.PollViewer; v.Voted || !v.CanVote || !v.CanViewResults || !v.CanClose || !v.CanViewWaiting || v.CanRemind != true {
		t.Fatalf("author viewer = %+v", v)
	}
	if w.jobs.live(created.ID) == 0 {
		t.Fatal("no closing job")
	}
	// A replay returns the original; other content conflicts.
	input := message.CreatePollInput{ClientMsgID: created.ClientMsgID, Question: "Когда удобнее субботник?", Options: []string{"Среда", "Четверг", "Суббота"},
		Multiple: ptr(false), Anonymous: ptr(false), DueAt: &due}
	again, fresh, err := w.messages.CreatePoll(ctx, w.author, w.chatID, input)
	if err != nil || fresh || again.ID != created.ID {
		t.Fatalf("replay = %v %v %v", again.ID, fresh, err)
	}
	input.Anonymous = ptr(true)
	if _, _, err := w.messages.CreatePoll(ctx, w.author, w.chatID, input); !errors.Is(err, message.ErrIdempotencyConflict) {
		t.Fatalf("replay with other flags = %v", err)
	}
	// multiple and anonymous are required.
	_, _, err = w.messages.CreatePoll(ctx, w.author, w.chatID, message.CreatePollInput{ClientMsgID: uuid.NewString(), Question: "q", Options: []string{"a", "b"}, Multiple: ptr(false)})
	var invalid *poll.InvalidError
	if !errors.As(err, &invalid) || invalid.Field != "anonymous" {
		t.Fatalf("missing anonymous = %v", err)
	}
	// Not a member, an agent, an archived chat.
	_, _, err = w.messages.CreatePoll(ctx, w.outsider, w.chatID, message.CreatePollInput{ClientMsgID: uuid.NewString(), Question: "q", Options: []string{"a", "b"}, Multiple: ptr(false), Anonymous: ptr(false)})
	expectErr(t, err, message.ErrNotFound)
	agent := identity.User{ActorID: w.agentID, OrgID: w.orgID, OrgRole: "member", Status: "active"}
	_, _, err = w.messages.CreatePoll(ctx, agent, w.chatID, message.CreatePollInput{ClientMsgID: uuid.NewString(), Question: "q", Options: []string{"a", "b"}, Multiple: ptr(false), Anonymous: ptr(false)})
	if !errors.Is(err, message.ErrForbidden) && !errors.Is(err, poll.ErrForbidden) {
		t.Fatalf("agent poll = %v", err)
	}
	w.exec(t, `UPDATE chats SET archived_at = now() WHERE id = $1`, w.otherID)
	_, _, err = w.messages.CreatePoll(ctx, w.author, w.otherID, message.CreatePollInput{ClientMsgID: uuid.NewString(), Question: "q", Options: []string{"a", "b"}, Multiple: ptr(false), Anonymous: ptr(false)})
	expectErr(t, err, poll.ErrChatArchived)
}

func TestOpenPollLimits(t *testing.T) {
	w := newWorld(t)
	w.polls.SetLimits(poll.Limits{OpenPerChat: 2, OpenPerAuthor: 3, RemindInterval: time.Hour, RemindMax: 5, DailyRemindersPerPerson: 10})
	w.create(t, w.author, message.CreatePollInput{})
	second := w.create(t, w.alice, message.CreatePollInput{})
	_, _, err := w.messages.CreatePoll(context.Background(), w.bob, w.chatID, message.CreatePollInput{ClientMsgID: uuid.NewString(), Question: "q", Options: []string{"a", "b"}, Multiple: ptr(false), Anonymous: ptr(false)})
	expectErr(t, err, poll.ErrLimitReached)
	if _, err := w.polls.Close(context.Background(), w.alice, second.ID); err != nil {
		t.Fatal(err)
	}
	w.create(t, w.bob, message.CreatePollInput{})
}

// recount checks that the stored counts of an ordinary poll equal the
// votes.
func recount(t *testing.T, w *world, messageID string) []int {
	t.Helper()
	var stored []int32
	var voters int
	if err := w.pool.QueryRow(context.Background(), `SELECT option_counts, voter_count FROM message_polls WHERE message_id=$1`, messageID).Scan(&stored, &voters); err != nil {
		t.Fatal(err)
	}
	for index, count := range stored {
		if n := w.count(t, `SELECT count(*) FROM message_poll_votes WHERE message_id=$1 AND option_index=$2`, messageID, index); n != int(count) {
			t.Fatalf("option %d: stored %d, votes %d", index, count, n)
		}
	}
	if n := w.count(t, `SELECT count(*) FROM message_poll_voters WHERE message_id=$1`, messageID); n != voters {
		t.Fatalf("voter_count %d, voters %d", voters, n)
	}
	result := make([]int, len(stored))
	for index, count := range stored {
		result[index] = int(count)
	}
	return result
}

func TestOrdinaryVoteChangeAndRetract(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	created := w.create(t, w.author, message.CreatePollInput{})
	// One option without multiple; indexes in range.
	for _, options := range [][]int{{0, 1}, {3}, {}, {-1}} {
		_, err := w.polls.Vote(ctx, w.alice, created.ID, poll.VoteInput{Options: options})
		var invalid *poll.InvalidError
		if !errors.As(err, &invalid) || invalid.Field != "options" {
			t.Fatalf("vote %v = %v", options, err)
		}
	}
	state := w.vote(t, w.alice, created.ID, 1)
	if !state.Viewer.Voted || !slices.Equal(state.Viewer.MyOptions, []int{1}) || !state.Viewer.CanChange || !slices.Equal(state.Viewer.Counts, []int{0, 1, 0}) ||
		state.Poll.VoterCount != 1 || state.Poll.FinalCounts != nil {
		t.Fatalf("after vote = %+v %+v", state.Poll, state.Viewer)
	}
	w.vote(t, w.bob, created.ID, 1)
	// The same vote again changes nothing and emits nothing.
	before := w.maxSeq(t)
	w.vote(t, w.alice, created.ID, 1)
	if w.maxSeq(t) != before {
		t.Fatal("repeating the same vote emitted events")
	}
	state = w.vote(t, w.alice, created.ID, 2)
	if !slices.Equal(state.Viewer.MyOptions, []int{2}) || !slices.Equal(state.Viewer.Counts, []int{0, 1, 1}) || state.Poll.VoterCount != 2 {
		t.Fatalf("after change = %+v %+v", state.Poll, state.Viewer)
	}
	if got := recount(t, w, created.ID); !slices.Equal(got, []int{0, 1, 1}) {
		t.Fatalf("counts = %v", got)
	}
	if err := w.polls.Retract(ctx, w.alice, created.ID); err != nil {
		t.Fatal(err)
	}
	if err := w.polls.Retract(ctx, w.alice, created.ID); err != nil {
		t.Fatalf("second retract = %v", err)
	}
	state = w.get(t, w.alice, created.ID)
	if state.Viewer.Voted || state.Viewer.CanViewResults || state.Viewer.Counts != nil || state.Poll.VoterCount != 1 {
		t.Fatalf("after retract = %+v %+v", state.Poll, state.Viewer)
	}
	if got := recount(t, w, created.ID); !slices.Equal(got, []int{0, 1, 0}) {
		t.Fatalf("counts after retract = %v", got)
	}
	// Multiple answers.
	multi := w.create(t, w.author, message.CreatePollInput{Multiple: ptr(true)})
	state = w.vote(t, w.carol, multi.ID, 2, 0)
	if !slices.Equal(state.Viewer.MyOptions, []int{0, 2}) || !slices.Equal(state.Viewer.Counts, []int{1, 0, 1}) {
		t.Fatalf("multiple = %+v", state.Viewer)
	}
	if _, err := w.polls.Vote(ctx, w.carol, multi.ID, poll.VoteInput{Options: []int{1, 1}}); err == nil {
		t.Fatal("repeated index accepted")
	}
	// The voter gets poll.vote.updated with the choice; the chat gets
	// poll.updated without an actor and without counts.
	events := w.events(t, created.ID, 0)
	for _, item := range ofType(events, "poll.updated") {
		if item.ActorID != nil || item.Audience != nil || item.Data["final_counts"] != nil {
			t.Fatalf("poll.updated = %+v", item)
		}
	}
	votes := ofType(events, "poll.vote.updated")
	if len(votes) == 0 || votes[0].Audience == nil || *votes[0].Audience != w.alice.ActorID {
		t.Fatalf("poll.vote.updated = %+v", votes)
	}
	// Stale version.
	_, err := w.polls.Vote(ctx, w.carol, created.ID, poll.VoteInput{Options: []int{0}, ExpectedVersion: ptr(1)})
	expectErr(t, err, poll.ErrVersionConflict)
}

// TestAnonymityIsHonest: nothing the server keeps, sends or answers links
// a voter to an option of an anonymous poll — checked in the database by
// direct SQL, in the events and frames, and in the replies.
func TestAnonymityIsHonest(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	start := w.maxSeq(t)
	created := w.create(t, w.author, message.CreatePollInput{Anonymous: ptr(true), Multiple: ptr(true)})
	choices := map[string][]int{w.alice.ActorID: {0}, w.bob.ActorID: {1, 2}, w.carol.ActorID: {2}}
	for _, voter := range []identity.User{w.alice, w.bob, w.carol} {
		state := w.vote(t, voter, created.ID, choices[voter.ActorID]...)
		if !state.Viewer.Voted || state.Viewer.MyOptions != nil || state.Viewer.CanVote || state.Viewer.CanChange || state.Viewer.CanViewVoters {
			t.Fatalf("anonymous voter view = %+v", state.Viewer)
		}
	}
	// The vote is final.
	_, err := w.polls.Vote(ctx, w.alice, created.ID, poll.VoteInput{Options: []int{1}})
	expectErr(t, err, poll.ErrVoteFinal)
	_, err = w.polls.Vote(ctx, w.alice, created.ID, poll.VoteInput{Options: []int{0}})
	expectErr(t, err, poll.ErrVoteFinal)
	expectErr(t, w.polls.Retract(ctx, w.alice, created.ID), poll.ErrVoteFinal)

	// The database: counts and who voted, never the choice.
	if n := w.count(t, `SELECT count(*) FROM message_poll_votes WHERE message_id=$1`, created.ID); n != 0 {
		t.Fatalf("anonymous votes stored: %d", n)
	}
	var counts []int32
	if err := w.pool.QueryRow(ctx, `SELECT option_counts FROM message_polls WHERE message_id=$1`, created.ID).Scan(&counts); err != nil || !slices.Equal(counts, []int32{1, 1, 2}) {
		t.Fatalf("counts = %v %v", counts, err)
	}
	// The trigger refuses a choice of an anonymous poll even from SQL.
	if _, err := w.pool.Exec(ctx, `INSERT INTO message_poll_votes (org_id, message_id, actor_id, option_index) VALUES ($1, $2, $3, 0)`,
		w.orgID, created.ID, w.alice.ActorID); err == nil || !strings.Contains(err.Error(), "anonymous") {
		t.Fatalf("trigger: %v", err)
	}
	// Audit: nothing about votes.
	if n := w.count(t, `SELECT count(*) FROM audit_log WHERE org_id=$1 AND (target_id::text=$2 OR action LIKE 'poll%')`, w.orgID, created.ID); n != 0 {
		t.Fatalf("audit rows = %d", n)
	}
	// Events: poll.updated has no actor and no counts; poll.vote.updated
	// says only «voted»; nothing else names an option.
	events := w.events(t, created.ID, start)
	for _, item := range events {
		switch item.Type {
		case "poll.updated":
			if item.ActorID != nil || item.Data["final_counts"] != nil || strings.Contains(item.Raw, "options") {
				t.Fatalf("poll.updated = %s actor=%v", item.Raw, item.ActorID)
			}
		case "poll.vote.updated":
			keys := []string{}
			for key := range item.Data {
				keys = append(keys, key)
			}
			slices.Sort(keys)
			if !slices.Equal(keys, []string{"chat_id", "message_id", "version", "voted"}) {
				t.Fatalf("anonymous poll.vote.updated = %s", item.Raw)
			}
		case "message.created":
		default:
			t.Fatalf("unexpected event %s: %s", item.Type, item.Raw)
		}
	}
	// Frames the voters and others receive: no choice, no open counts.
	for _, reader := range []identity.User{w.alice, w.owner, w.author} {
		for _, frame := range w.replay(t, reader, start) {
			raw := string(frame.Data)
			if strings.Contains(raw, `"options":[0`) || strings.Contains(raw, `"options":[1`) || strings.Contains(raw, `"options":[2`) ||
				strings.Contains(raw, `"counts"`) || strings.Contains(raw, `"poll_viewer"`) || strings.Contains(raw, `"my_options"`) {
				t.Fatalf("frame %s leaks: %s", frame.Type, raw)
			}
			if frame.Type == "poll.updated" && frame.ActorID != nil {
				t.Fatalf("poll.updated frame has an actor")
			}
		}
	}
	// Nobody can list voters by option or the waiting list, the author and
	// a chat admin included.
	for _, reader := range []identity.User{w.author, w.admin, w.alice, w.owner} {
		for _, filter := range []string{"option:0", "option:2", "waiting"} {
			_, err := w.polls.Voters(ctx, reader, created.ID, poll.VotersOptions{Filter: filter})
			expectErr(t, err, poll.ErrForbidden)
		}
	}
	// The author sees the counts and how many have not voted, no names.
	state := w.get(t, w.author, created.ID)
	if !slices.Equal(state.Viewer.Counts, []int{1, 1, 2}) || state.Viewer.CanViewWaiting || state.Viewer.CanViewVoters ||
		state.Poll.MemberCount-state.Poll.VoterCount != chatPeople-3 {
		t.Fatalf("author view = %+v %+v", state.Poll, state.Viewer)
	}
	// After closing everyone sees the result, still without the choice.
	closed, err := w.polls.Close(ctx, w.author, created.ID)
	if err != nil || !slices.Equal(closed.Poll.FinalCounts, []int{1, 1, 2}) {
		t.Fatalf("closed = %+v %v", closed.Poll, err)
	}
	if n := w.count(t, `SELECT count(*) FROM message_poll_votes WHERE message_id=$1`, created.ID); n != 0 {
		t.Fatalf("anonymous votes stored after close: %d", n)
	}
	_, err = w.polls.Voters(ctx, w.author, created.ID, poll.VotersOptions{Filter: "option:2"})
	expectErr(t, err, poll.ErrForbidden)
}

// Results are visible after one's own vote, to the author always and to
// everyone once closed; never in MessagePoll or a frame while open.
func TestResultsVisibility(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	start := w.maxSeq(t)
	created := w.create(t, w.author, message.CreatePollInput{})
	w.vote(t, w.alice, created.ID, 0)
	w.vote(t, w.bob, created.ID, 0)
	carol := w.get(t, w.carol, created.ID)
	if carol.Viewer.CanViewResults || carol.Viewer.CanViewVoters || carol.Viewer.Counts != nil || carol.Viewer.CanViewWaiting || carol.Poll.FinalCounts != nil {
		t.Fatalf("non-voter = %+v %+v", carol.Poll, carol.Viewer)
	}
	if carol.Poll.VoterCount != 2 || carol.Poll.MemberCount != chatPeople {
		t.Fatalf("N из M = %d из %d", carol.Poll.VoterCount, carol.Poll.MemberCount)
	}
	_, err := w.polls.Voters(ctx, w.carol, created.ID, poll.VotersOptions{Filter: "option:0"})
	expectErr(t, err, poll.ErrForbidden)
	_, err = w.polls.Voters(ctx, w.carol, created.ID, poll.VotersOptions{Filter: "waiting"})
	expectErr(t, err, poll.ErrForbidden)
	_, err = w.polls.Voters(ctx, w.alice, created.ID, poll.VotersOptions{Filter: "waiting"})
	expectErr(t, err, poll.ErrForbidden)
	// The feed shows the same to carol.
	page, err := w.messages.List(ctx, w.carol, w.chatID, message.ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range page.Messages {
		if item.ID == created.ID && (item.PollViewer == nil || item.PollViewer.Counts != nil || item.Poll.FinalCounts != nil) {
			t.Fatalf("feed item = %+v %+v", item.Poll, item.PollViewer)
		}
	}
	// A voter sees who voted for what; the author and the chat admin see
	// who has not voted.
	alice := w.get(t, w.alice, created.ID)
	if !alice.Viewer.CanViewVoters || !slices.Equal(alice.Viewer.Counts, []int{2, 0, 0}) {
		t.Fatalf("voter = %+v", alice.Viewer)
	}
	voters, err := w.polls.Voters(ctx, w.alice, created.ID, poll.VotersOptions{Filter: "option:0", Limit: 1})
	if err != nil || len(voters.Items) != 1 || voters.NextCursor == nil {
		t.Fatalf("voters page = %+v %v", voters, err)
	}
	more, err := w.polls.Voters(ctx, w.alice, created.ID, poll.VotersOptions{Filter: "option:0", Limit: 1, Cursor: voters.NextCursor})
	if err != nil || len(more.Items) != 1 || more.Items[0].ActorID == voters.Items[0].ActorID || more.NextCursor != nil {
		t.Fatalf("voters next page = %+v %v", more, err)
	}
	_, err = w.polls.Voters(ctx, w.alice, created.ID, poll.VotersOptions{Filter: "option:5"})
	var invalid *poll.InvalidError
	if !errors.As(err, &invalid) {
		t.Fatalf("option out of range = %v", err)
	}
	for _, reader := range []identity.User{w.author, w.admin} {
		state := w.get(t, reader, created.ID)
		if !state.Viewer.CanViewWaiting {
			t.Fatalf("%s cannot see the waiting list", reader.ActorID)
		}
		waiting, err := w.polls.Voters(ctx, reader, created.ID, poll.VotersOptions{Filter: "waiting"})
		if err != nil || len(waiting.Items) != chatPeople-2 {
			t.Fatalf("waiting = %+v %v", waiting, err)
		}
		for _, item := range waiting.Items {
			if item.ActorID == w.alice.ActorID || item.ActorID == w.bob.ActorID || item.ActorID == w.agentID || item.ActorID == w.sleepyID || item.VotedAt != nil {
				t.Fatalf("waiting item = %+v", item)
			}
		}
	}
	// The author sees the counts without voting; the admin does not.
	if state := w.get(t, w.author, created.ID); !slices.Equal(state.Viewer.Counts, []int{2, 0, 0}) {
		t.Fatalf("author counts = %v", state.Viewer.Counts)
	}
	if state := w.get(t, w.admin, created.ID); state.Viewer.Counts != nil {
		t.Fatalf("admin counts = %v", state.Viewer.Counts)
	}
	// No frame of an open poll carries counts.
	for _, frame := range w.replay(t, w.carol, start) {
		var data map[string]any
		_ = json.Unmarshal(frame.Data, &data)
		if p, ok := data["poll"].(map[string]any); ok && p["final_counts"] != nil {
			t.Fatalf("message frame with counts: %s", frame.Data)
		}
		if frame.Type == "poll.updated" && data["final_counts"] != nil {
			t.Fatalf("poll.updated with counts: %s", frame.Data)
		}
		if strings.Contains(string(frame.Data), "poll_viewer") || strings.Contains(string(frame.Data), `"counts"`) {
			t.Fatalf("frame with a viewer: %s", frame.Data)
		}
	}
	// Closed: everyone.
	closed, err := w.polls.Close(ctx, w.admin, created.ID)
	if err != nil || closed.Poll.ClosedReason == nil || *closed.Poll.ClosedReason != poll.ReasonModerator {
		t.Fatalf("admin close = %+v %v", closed.Poll, err)
	}
	carol = w.get(t, w.carol, created.ID)
	if !carol.Viewer.CanViewResults || !carol.Viewer.CanViewVoters || !slices.Equal(carol.Poll.FinalCounts, []int{2, 0, 0}) || carol.Viewer.CanVote {
		t.Fatalf("after close = %+v %+v", carol.Poll, carol.Viewer)
	}
	if _, err := w.polls.Voters(ctx, w.carol, created.ID, poll.VotersOptions{Filter: "option:0"}); err != nil {
		t.Fatal(err)
	}
	// Outsiders get nothing.
	_, err = w.polls.Get(ctx, w.outsider, created.ID)
	expectErr(t, err, poll.ErrNotFound)
	_, err = w.polls.Voters(ctx, w.outsider, created.ID, poll.VotersOptions{Filter: "option:0"})
	expectErr(t, err, poll.ErrNotFound)
}

func TestCloseManually(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	created := w.create(t, w.author, message.CreatePollInput{DueAt: ptr(w.clock.Now().Add(time.Hour))})
	job := w.jobs.live(created.ID)
	_, err := w.polls.Close(ctx, w.alice, created.ID)
	expectErr(t, err, poll.ErrForbidden)
	w.vote(t, w.alice, created.ID, 2)
	state, err := w.polls.Close(ctx, w.author, created.ID)
	if err != nil || state.Poll.Status != "closed" || *state.Poll.ClosedReason != poll.ReasonAuthor || state.Poll.ClosedAt == nil {
		t.Fatalf("close = %+v %v", state.Poll, err)
	}
	if w.jobs.live(created.ID) != 0 || !w.jobs.cancelled[job] {
		t.Fatal("closing job not cancelled")
	}
	before := w.maxSeq(t)
	if again, err := w.polls.Close(ctx, w.author, created.ID); err != nil || again.Poll.Version != state.Poll.Version || w.maxSeq(t) != before {
		t.Fatalf("second close = %+v %v", again.Poll, err)
	}
	_, err = w.polls.Vote(ctx, w.bob, created.ID, poll.VoteInput{Options: []int{0}})
	expectErr(t, err, poll.ErrClosed)
	expectErr(t, w.polls.Retract(ctx, w.alice, created.ID), poll.ErrClosed)
	_, err = w.polls.Remind(ctx, w.author, created.ID)
	expectErr(t, err, poll.ErrClosed)
	// No push for closing by hand.
	if n := w.count(t, `SELECT count(*) FROM events WHERE subject_id=$1 AND type='poll.notified'`, created.ID); n != 0 {
		t.Fatalf("notified on manual close = %d", n)
	}
}

func TestCloseByDueDate(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	due := w.clock.Now().Add(time.Hour)
	created := w.create(t, w.author, message.CreatePollInput{DueAt: &due})
	job := w.jobs.live(created.ID)
	w.vote(t, w.alice, created.ID, 1)
	// Early: snooze.
	var snooze poll.Snooze
	if err := w.polls.Expire(ctx, created.ID, job); !errors.As(err, &snooze) {
		t.Fatalf("early job = %v", err)
	}
	w.clock.Set(due.Add(time.Second))
	// A stale job does nothing.
	if err := w.polls.Expire(ctx, created.ID, job+100); err != nil {
		t.Fatal(err)
	}
	if state := w.get(t, w.carol, created.ID); state.Poll.Status != "open" {
		t.Fatal("stale job closed the poll")
	}
	start := w.maxSeq(t)
	if err := w.polls.Expire(ctx, created.ID, job); err != nil {
		t.Fatal(err)
	}
	state := w.get(t, w.carol, created.ID)
	if state.Poll.Status != "closed" || *state.Poll.ClosedReason != poll.ReasonExpired || !slices.Equal(state.Poll.FinalCounts, []int{0, 1, 0}) {
		t.Fatalf("expired = %+v", state.Poll)
	}
	events := w.events(t, created.ID, start)
	notified := ofType(events, "poll.notified")
	if len(ofType(events, "poll.updated")) != 1 || len(notified) != 1 || *notified[0].Audience != w.author.ActorID ||
		notified[0].ActorID != nil || notified[0].Data["kind"] != "closed_expired" {
		t.Fatalf("expiry events = %+v", events)
	}
	if n := w.count(t, `SELECT count(*) FROM notification_jobs WHERE event_seq=$1`, notified[0].Seq); n != 1 {
		t.Fatal("no push job for closed_expired")
	}
	// Running again changes nothing.
	if err := w.polls.Expire(ctx, created.ID, job); err != nil || w.maxSeq(t) != notified[0].Seq {
		t.Fatalf("second run = %v", err)
	}
	// In an archived chat the poll closes silently.
	other := w.create(t, w.author, message.CreatePollInput{DueAt: ptr(w.clock.Now().Add(time.Hour))})
	w.exec(t, `UPDATE chats SET archived_at = now() WHERE id = $1`, w.chatID)
	w.clock.Set(w.clock.Now().Add(2 * time.Hour))
	start = w.maxSeq(t)
	if err := w.polls.Expire(ctx, other.ID, w.jobs.live(other.ID)); err != nil {
		t.Fatal(err)
	}
	if n := len(ofType(w.events(t, other.ID, start), "poll.notified")); n != 0 {
		t.Fatalf("notified in an archived chat = %d", n)
	}
	if w.count(t, `SELECT count(*) FROM message_polls WHERE message_id=$1 AND status='closed' AND closed_reason='expired'`, other.ID) != 1 {
		t.Fatal("archived poll not closed")
	}
	// Archived: votes and reads refused.
	_, err := w.polls.Get(ctx, w.alice, other.ID)
	expectErr(t, err, poll.ErrNotFound)
}

func TestArchivedChatRefusesActions(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	created := w.create(t, w.author, message.CreatePollInput{})
	w.vote(t, w.alice, created.ID, 0)
	w.exec(t, `UPDATE chats SET archived_at = now() WHERE id = $1`, w.chatID)
	_, err := w.polls.Vote(ctx, w.bob, created.ID, poll.VoteInput{Options: []int{0}})
	expectErr(t, err, poll.ErrChatArchived)
	expectErr(t, w.polls.Retract(ctx, w.alice, created.ID), poll.ErrChatArchived)
	_, err = w.polls.Close(ctx, w.author, created.ID)
	expectErr(t, err, poll.ErrChatArchived)
	_, err = w.polls.Remind(ctx, w.author, created.ID)
	expectErr(t, err, poll.ErrChatArchived)
}

func TestMessageDeletionClosesPoll(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	due := w.clock.Now().Add(3 * time.Hour)
	created := w.create(t, w.author, message.CreatePollInput{DueAt: &due})
	job := w.jobs.live(created.ID)
	if len(w.waiting(t, w.alice, "polls")) != 1 {
		t.Fatal("poll not waiting before deletion")
	}
	if _, err := w.messages.Delete(ctx, w.author, created.ID); err != nil {
		t.Fatal(err)
	}
	if !w.jobs.cancelled[job] {
		t.Fatal("closing job not cancelled")
	}
	var status, reason, question string
	var options []string
	if err := w.pool.QueryRow(ctx, `SELECT status, closed_reason, question, options FROM message_polls WHERE message_id=$1`, created.ID).Scan(&status, &reason, &question, &options); err != nil {
		t.Fatal(err)
	}
	if status != "closed" || reason != poll.ReasonMessageDeleted || question != "" || strings.Join(options, "") != "" || len(options) != 3 {
		t.Fatalf("deleted poll = %s %s %q %q", status, reason, question, options)
	}
	if len(w.waiting(t, w.alice, "polls")) != 0 {
		t.Fatal("deleted poll still waiting")
	}
	updated := ofType(w.events(t, created.ID, 0), "poll.updated")
	if last := updated[len(updated)-1]; last.Data["closed_reason"] != poll.ReasonMessageDeleted || last.Data["final_counts"] != nil {
		t.Fatalf("poll.updated of a deleted poll = %s", last.Raw)
	}
	_, err := w.polls.Get(ctx, w.alice, created.ID)
	expectErr(t, err, poll.ErrNotFound)
	_, err = w.polls.Vote(ctx, w.alice, created.ID, poll.VoteInput{Options: []int{0}})
	expectErr(t, err, poll.ErrNotFound)
}

// The denominator: a voter who leaves stays counted and cannot change the
// vote; a person who leaves without voting drops out; poll.updated tells
// the chat.
func TestLeavingTheChat(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	created := w.create(t, w.author, message.CreatePollInput{})
	w.vote(t, w.alice, created.ID, 0)
	start := w.maxSeq(t)
	if err := w.chats.RemoveMember(ctx, w.alice, w.chatID, w.alice.ActorID); err != nil {
		t.Fatal(err)
	}
	// The chat gets poll.updated whether or not the person voted: its
	// absence would tell who voted.
	if n := len(ofType(w.events(t, created.ID, start), "poll.updated")); n != 1 {
		t.Fatalf("poll.updated on a voter leaving = %d", n)
	}
	state := w.get(t, w.carol, created.ID)
	if state.Poll.VoterCount != 1 || state.Poll.MemberCount != chatPeople {
		t.Fatalf("after voter left: %d из %d", state.Poll.VoterCount, state.Poll.MemberCount)
	}
	_, err := w.polls.Vote(ctx, w.alice, created.ID, poll.VoteInput{Options: []int{1}})
	expectErr(t, err, poll.ErrNotMember)
	expectErr(t, w.polls.Retract(ctx, w.alice, created.ID), poll.ErrNotMember)
	_, err = w.polls.Vote(ctx, w.outsider, created.ID, poll.VoteInput{Options: []int{1}})
	expectErr(t, err, poll.ErrNotFound)
	w.vote(t, w.bob, created.ID, 0)
	voters, err := w.polls.Voters(ctx, w.bob, created.ID, poll.VotersOptions{Filter: "option:0"})
	if err != nil || len(voters.Items) != 2 {
		t.Fatalf("voters = %+v %v", voters, err)
	}
	for _, item := range voters.Items {
		if item.InChat != (item.ActorID != w.alice.ActorID) {
			t.Fatalf("in_chat = %+v", item)
		}
	}
	start = w.maxSeq(t)
	if err := w.chats.RemoveMember(ctx, w.carol, w.chatID, w.carol.ActorID); err != nil {
		t.Fatal(err)
	}
	updated := ofType(w.events(t, created.ID, start), "poll.updated")
	if len(updated) != 1 || updated[0].Data["member_count"] != float64(chatPeople-1) || updated[0].ActorID != nil {
		t.Fatalf("poll.updated on a non-voter leaving = %+v", updated)
	}
	if state := w.get(t, w.bob, created.ID); state.Poll.MemberCount != chatPeople-1 || state.Poll.VoterCount != 2 {
		t.Fatalf("after non-voter left: %d из %d", state.Poll.VoterCount, state.Poll.MemberCount)
	}
	// The author who left loses the author's rights.
	if err := w.chats.RemoveMember(ctx, w.author, w.chatID, w.author.ActorID); err != nil {
		t.Fatal(err)
	}
	_, err = w.polls.Close(ctx, w.author, created.ID)
	expectErr(t, err, poll.ErrNotMember)
	if _, err := w.polls.Close(ctx, w.admin, created.ID); err != nil {
		t.Fatal(err)
	}
}

// In an anonymous poll M never tells whether the person who left had voted:
// a voter and a non-voter leaving lower it the same way.
func TestAnonymousDenominatorHidesWhoVoted(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	created := w.create(t, w.author, message.CreatePollInput{Anonymous: ptr(true)})
	w.vote(t, w.alice, created.ID, 0)
	if state := w.get(t, w.bob, created.ID); state.Poll.MemberCount != chatPeople || state.Poll.VoterCount != 1 {
		t.Fatalf("start: %d из %d", state.Poll.VoterCount, state.Poll.MemberCount)
	}
	start := w.maxSeq(t)
	if err := w.chats.RemoveMember(ctx, w.alice, w.chatID, w.alice.ActorID); err != nil {
		t.Fatal(err)
	}
	voterLeft := w.get(t, w.bob, created.ID)
	voterEvents := len(ofType(w.events(t, created.ID, start), "poll.updated"))
	start = w.maxSeq(t)
	if err := w.chats.RemoveMember(ctx, w.carol, w.chatID, w.carol.ActorID); err != nil {
		t.Fatal(err)
	}
	nonVoterLeft := w.get(t, w.bob, created.ID)
	nonVoterEvents := len(ofType(w.events(t, created.ID, start), "poll.updated"))
	if voterLeft.Poll.MemberCount != chatPeople-1 || nonVoterLeft.Poll.MemberCount != chatPeople-2 || voterEvents != 1 || nonVoterEvents != 1 ||
		nonVoterLeft.Poll.VoterCount != 1 {
		t.Fatalf("voter left: M=%d events=%d; non-voter left: M=%d events=%d", voterLeft.Poll.MemberCount, voterEvents, nonVoterLeft.Poll.MemberCount, nonVoterEvents)
	}
}

// An author who may no longer write to the chat (a channel member) neither
// edits the question nor reminds.
func TestAuthorWithoutPublishRight(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	created := w.create(t, w.author, message.CreatePollInput{})
	w.exec(t, `UPDATE chats SET kind = 'channel' WHERE id = $1`, w.chatID)
	_, err := w.polls.Remind(ctx, w.author, created.ID)
	expectErr(t, err, poll.ErrForbidden)
	_, err = w.messages.UpdatePoll(ctx, w.author, created.ID, poll.EditInput{Question: "Новый", ExpectedVersion: ptr(created.Poll.Version)})
	expectErr(t, err, poll.ErrForbidden)
}

func TestWaitingInboxAndCounters(t *testing.T) {
	w := newWorld(t)
	soon := w.clock.Now().Add(3 * time.Hour)
	later := w.clock.Now().Add(72 * time.Hour)
	hot := w.create(t, w.author, message.CreatePollInput{DueAt: &soon})
	cold := w.create(t, w.author, message.CreatePollInput{DueAt: &later, Anonymous: ptr(true)})
	w.create(t, w.author, message.CreatePollInput{}) // without a due date: never waits
	items := w.waiting(t, w.alice, "polls")
	if len(items) != 2 || items[0].Message.ID != hot.ID || items[1].Message.ID != cold.ID {
		t.Fatalf("waiting = %+v", items)
	}
	for _, item := range items {
		if item.Kind != "poll" || item.Message.Poll == nil || item.Message.PollViewer == nil || item.Request != nil || item.Viewer != nil || item.MyRole != nil ||
			item.Message.PollViewer.Counts != nil || item.DueAt == nil {
			t.Fatalf("waiting item = %+v", item)
		}
	}
	if all := w.waiting(t, w.alice, "all"); len(all) != 2 {
		t.Fatalf("all = %d", len(all))
	}
	if tasks := w.waiting(t, w.alice, "tasks"); len(tasks) != 0 {
		t.Fatalf("tasks = %d", len(tasks))
	}
	snapshot := w.unread(t, w.alice)
	if snapshot.PollsWaitingTotal != 2 || snapshot.PollsHotTotal != 1 {
		t.Fatalf("unread = %d/%d", snapshot.PollsWaitingTotal, snapshot.PollsHotTotal)
	}
	for _, item := range snapshot.Chats {
		if item.ChatID == w.chatID && item.PollsWaiting != 2 {
			t.Fatalf("chat polls_waiting = %d", item.PollsWaiting)
		}
	}
	// Voting removes it; outsiders and agents never see it.
	w.vote(t, w.alice, hot.ID, 0)
	if items := w.waiting(t, w.alice, "polls"); len(items) != 1 || items[0].Message.ID != cold.ID {
		t.Fatalf("after vote = %+v", items)
	}
	if items := w.waiting(t, w.outsider, "polls"); len(items) != 0 {
		t.Fatalf("outsider = %+v", items)
	}
	if snapshot := w.unread(t, w.outsider); snapshot.PollsWaitingTotal != 0 {
		t.Fatalf("outsider unread = %d", snapshot.PollsWaitingTotal)
	}
	// Access at read time: a member who left no longer sees it; an archived
	// chat hides it.
	w.exec(t, `DELETE FROM chat_members WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.bob.ActorID)
	if items := w.waiting(t, w.bob, "polls"); len(items) != 0 {
		t.Fatalf("left member = %+v", items)
	}
	w.exec(t, `UPDATE chats SET archived_at = now() WHERE id = $1`, w.chatID)
	if items := w.waiting(t, w.carol, "all"); len(items) != 0 {
		t.Fatalf("archived = %+v", items)
	}
}

func TestRemind(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	w.polls.SetLimits(poll.Limits{OpenPerChat: 100, OpenPerAuthor: 200, RemindInterval: 2 * time.Hour, RemindMax: 5, DailyRemindersPerPerson: 2})
	created := w.create(t, w.author, message.CreatePollInput{Anonymous: ptr(true)})
	w.vote(t, w.alice, created.ID, 0)
	_, err := w.polls.Remind(ctx, w.alice, created.ID)
	expectErr(t, err, poll.ErrForbidden)
	start := w.maxSeq(t)
	result, err := w.polls.Remind(ctx, w.author, created.ID)
	// bob, carol, admin, owner: the voter and the author are left out.
	if err != nil || result.Reminded != 4 || result.NextRemindAt == nil {
		t.Fatalf("remind = %+v %v", result, err)
	}
	notified := ofType(w.events(t, created.ID, start), "poll.notified")
	if len(notified) != 4 {
		t.Fatalf("notified = %d", len(notified))
	}
	for _, item := range notified {
		if *item.Audience == w.alice.ActorID || *item.Audience == w.author.ActorID || *item.ActorID != w.author.ActorID || item.Data["kind"] != "reminded" ||
			len(item.Data) != 3 {
			t.Fatalf("notice = %+v", item)
		}
	}
	// Too soon.
	_, err = w.polls.Remind(ctx, w.author, created.ID)
	var tooSoon *poll.RemindTooSoonError
	if !errors.As(err, &tooSoon) || tooSoon.RetryAfter <= 0 {
		t.Fatalf("second remind = %v", err)
	}
	state := w.get(t, w.author, created.ID)
	if state.Viewer.CanRemind || state.Viewer.NextRemindAt == nil {
		t.Fatalf("author viewer = %+v", state.Viewer)
	}
	// The daily limit: the third reminder in a day reaches nobody's phone,
	// but is still counted.
	second := w.create(t, w.author, message.CreatePollInput{})
	third := w.create(t, w.author, message.CreatePollInput{})
	if _, err := w.polls.Remind(ctx, w.author, second.ID); err != nil {
		t.Fatal(err)
	}
	start = w.maxSeq(t)
	result, err = w.polls.Remind(ctx, w.author, third.ID)
	if err != nil || result.Reminded != 5 {
		t.Fatalf("third remind = %+v %v", result, err)
	}
	if n := w.count(t, `SELECT count(*) FROM notification_jobs j JOIN events e ON e.org_id=j.org_id AND e.seq=j.event_seq WHERE e.subject_id=$1 AND e.type='poll.notified'`, third.ID); n != 1 {
		t.Fatalf("pushes over the daily limit = %d (only alice may get one)", n)
	}
	if n := len(ofType(w.events(t, third.ID, start), "poll.notified")); n != 1 {
		t.Fatalf("events over the daily limit = %d", n)
	}
	// At most 5 per poll.
	for range 4 {
		w.clock.Set(w.clock.Now().Add(2 * time.Hour))
		if _, err := w.polls.Remind(ctx, w.author, created.ID); err != nil {
			t.Fatal(err)
		}
	}
	w.clock.Set(w.clock.Now().Add(2 * time.Hour))
	_, err = w.polls.Remind(ctx, w.author, created.ID)
	expectErr(t, err, poll.ErrLimitReached)
	if state := w.get(t, w.author, created.ID); state.Viewer.CanRemind || state.Viewer.NextRemindAt != nil {
		t.Fatalf("after 5 = %+v", state.Viewer)
	}
}

// Concurrent votes keep the counts exact and versions strictly growing.
func TestConcurrentVotes(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	created := w.create(t, w.author, message.CreatePollInput{Multiple: ptr(true)})
	anonymous := w.create(t, w.author, message.CreatePollInput{Anonymous: ptr(true)})
	people := []identity.User{w.author, w.alice, w.bob, w.carol, w.admin, w.owner}
	var group sync.WaitGroup
	errs := make(chan error, 100)
	for round := range 3 {
		for index, person := range people {
			group.Add(2)
			go func() {
				defer group.Done()
				_, err := w.polls.Vote(ctx, person, created.ID, poll.VoteInput{Options: []int{(index + round) % 3}})
				errs <- err
			}()
			go func() {
				defer group.Done()
				_, err := w.polls.Vote(ctx, person, anonymous.ID, poll.VoteInput{Options: []int{index % 3}})
				if errors.Is(err, poll.ErrVoteFinal) {
					err = nil
				}
				errs <- err
			}()
		}
	}
	// Closing races the votes too.
	group.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	got := recount(t, w, created.ID)
	sum := 0
	for _, count := range got {
		sum += count
	}
	if sum != len(people) {
		t.Fatalf("ordinary counts = %v", got)
	}
	var counts []int32
	var voters int
	if err := w.pool.QueryRow(ctx, `SELECT option_counts, voter_count FROM message_polls WHERE message_id=$1`, anonymous.ID).Scan(&counts, &voters); err != nil {
		t.Fatal(err)
	}
	if voters != len(people) || counts[0]+counts[1]+counts[2] != int32(len(people)) {
		t.Fatalf("anonymous counts = %v voters %d", counts, voters)
	}
	versions := map[float64]bool{}
	for _, item := range ofType(w.events(t, created.ID, 0), "poll.updated") {
		version := item.Data["version"].(float64)
		if versions[version] {
			t.Fatalf("version %v repeats", version)
		}
		versions[version] = true
	}
}

// Votes racing closing and deletion never change a closed poll.
func TestVoteRacesCloseAndDelete(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	for _, del := range []bool{false, true} {
		created := w.create(t, w.author, message.CreatePollInput{})
		var group sync.WaitGroup
		for _, person := range []identity.User{w.alice, w.bob, w.carol, w.admin} {
			group.Add(1)
			go func() {
				defer group.Done()
				_, err := w.polls.Vote(ctx, person, created.ID, poll.VoteInput{Options: []int{0}})
				if err != nil && !errors.Is(err, poll.ErrClosed) && !errors.Is(err, poll.ErrNotFound) {
					t.Error(err)
				}
			}()
		}
		group.Add(1)
		go func() {
			defer group.Done()
			var err error
			if del {
				_, err = w.messages.Delete(ctx, w.author, created.ID)
			} else {
				_, err = w.polls.Close(ctx, w.author, created.ID)
			}
			if err != nil {
				t.Error(err)
			}
		}()
		group.Wait()
		var closedVersion, voters int
		var counts []int32
		if err := w.pool.QueryRow(ctx, `SELECT version, voter_count, option_counts FROM message_polls WHERE message_id=$1 AND status='closed'`, created.ID).Scan(&closedVersion, &voters, &counts); err != nil {
			t.Fatal(err)
		}
		if int(counts[0]) != voters {
			t.Fatalf("counts %v voters %d", counts, voters)
		}
		// Nothing after the closing event.
		updated := ofType(w.events(t, created.ID, 0), "poll.updated")
		last := updated[len(updated)-1]
		if last.Data["status"] != "closed" || int(last.Data["version"].(float64)) != closedVersion {
			t.Fatalf("last poll.updated = %s", last.Raw)
		}
	}
}

// Agents read a poll as its text: no poll, no viewer, no poll.updated.
func TestAgentsReadPollAsText(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	start := w.maxSeq(t)
	created := w.create(t, w.author, message.CreatePollInput{})
	w.vote(t, w.alice, created.ID, 0)
	agent := identity.User{ActorID: w.agentID, OrgID: w.orgID, OrgRole: "member", Status: "active"}
	read, err := w.messages.Get(ctx, agent, created.ID)
	if err != nil || read.Poll != nil || read.PollViewer != nil || !strings.HasPrefix(read.Body, "Опрос: ") {
		t.Fatalf("agent read = %+v %v", read, err)
	}
	page, err := w.messages.List(ctx, agent, w.chatID, message.ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range page.Messages {
		if item.Poll != nil || item.PollViewer != nil {
			t.Fatalf("agent feed has a poll: %+v", item)
		}
	}
	for _, frame := range w.replay(t, agent, start) {
		if frame.Type == "poll.updated" || strings.Contains(string(frame.Data), `"poll":{`) {
			t.Fatalf("agent frame %s: %s", frame.Type, frame.Data)
		}
	}
	live, err := eventlogLive(w, start)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range live {
		if slices.Contains(event.RecipientActorIDs, w.agentID) && (event.Frame.Type == "poll.updated" || strings.Contains(string(event.Frame.Data), `"poll":{`)) {
			t.Fatalf("live agent frame %s: %s", event.Frame.Type, event.Frame.Data)
		}
	}
	_, err = w.polls.Vote(ctx, agent, created.ID, poll.VoteInput{Options: []int{0}})
	expectErr(t, err, poll.ErrNotFound)
	_, err = w.polls.Get(ctx, agent, created.ID)
	expectErr(t, err, poll.ErrNotFound)
}

// updatePoll: only the author edits the question of an open poll; the body
// is rebuilt, the message gets edited_at, the votes stay; updateMessage
// refuses polls.
func TestEditQuestion(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	created := w.create(t, w.author, message.CreatePollInput{})
	state := w.vote(t, w.alice, created.ID, 1)
	version := state.Poll.Version
	edit := func(user identity.User, question string, expected int) (message.Message, error) {
		return w.messages.UpdatePoll(ctx, user, created.ID, poll.EditInput{Question: question, ExpectedVersion: &expected})
	}
	_, err := edit(w.alice, "чужой", version)
	expectErr(t, err, poll.ErrForbidden)
	_, err = edit(w.admin, "чужой", version)
	expectErr(t, err, poll.ErrForbidden)
	_, err = edit(w.outsider, "чужой", version)
	expectErr(t, err, poll.ErrNotFound)
	_, err = edit(w.author, "Когда?", version+5)
	expectErr(t, err, poll.ErrVersionConflict)
	_, err = edit(w.author, strings.Repeat("я", 301), version)
	var invalid *poll.InvalidError
	if !errors.As(err, &invalid) || invalid.Field != "question" {
		t.Fatalf("long question = %v", err)
	}
	_, err = w.messages.UpdatePoll(ctx, w.author, created.ID, poll.EditInput{Question: "Когда?"})
	if !errors.As(err, &invalid) || invalid.Field != "expected_version" {
		t.Fatalf("no expected_version = %v", err)
	}
	start := w.maxSeq(t)
	updated, err := edit(w.author, " Когда субботник? ", version)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Body != "Опрос: Когда субботник?\n\n— Среда\n— Четверг\n— Суббота" || updated.BodyFormat != "plain" || updated.EditedAt == nil ||
		updated.Poll.Question != "Когда субботник?" || updated.Poll.VoterCount != 1 || updated.Poll.Version != version+1 ||
		updated.PollViewer == nil || !slices.Equal(updated.Poll.Options, []string{"Среда", "Четверг", "Суббота"}) {
		t.Fatalf("edited = %+v %+v", updated, updated.Poll)
	}
	events := w.events(t, created.ID, start)
	if len(events) != 2 || events[0].Type != "message.updated" || events[1].Type != "poll.updated" ||
		events[1].ActorID != nil || events[1].Data["version"] != float64(version+1) {
		t.Fatalf("edit events = %+v", events)
	}
	if n := w.count(t, `SELECT count(*) FROM message_revisions WHERE message_id=$1`, created.ID); n != 1 {
		t.Fatalf("revisions = %d", n)
	}
	if got := recount(t, w, created.ID); !slices.Equal(got, []int{0, 1, 0}) {
		t.Fatalf("votes after edit = %v", got)
	}
	// The same question changes nothing.
	before := w.maxSeq(t)
	if _, err := edit(w.author, "Когда субботник?", version+1); err != nil || w.maxSeq(t) != before {
		t.Fatalf("same question = %v", err)
	}
	// updateMessage refuses polls.
	if _, err := w.messages.Update(ctx, w.author, created.ID, message.UpdateInput{Body: "текст", ExpectedVersion: updated.Version}); !errors.Is(err, message.ErrInvalid) {
		t.Fatalf("updateMessage of a poll = %v", err)
	}
	// A closed poll keeps its question.
	if _, err := w.polls.Close(ctx, w.author, created.ID); err != nil {
		t.Fatal(err)
	}
	closed := w.get(t, w.author, created.ID)
	_, err = edit(w.author, "Другой вопрос", closed.Poll.Version)
	expectErr(t, err, poll.ErrClosed)
	// The author who left cannot edit.
	other := w.create(t, w.author, message.CreatePollInput{})
	if err := w.chats.RemoveMember(ctx, w.author, w.chatID, w.author.ActorID); err != nil {
		t.Fatal(err)
	}
	_, err = w.messages.UpdatePoll(ctx, w.author, other.ID, poll.EditInput{Question: "x", ExpectedVersion: ptr(other.Poll.Version)})
	expectErr(t, err, poll.ErrNotMember)
}
