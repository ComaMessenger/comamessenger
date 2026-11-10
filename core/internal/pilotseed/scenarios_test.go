package pilotseed_test

import (
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/agenttrigger"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/interactive"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/pilotseed"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
)

// TestPilotRecipesCreateNarrowAgents checks every catalog recipe against the
// real tool catalog: the scopes are exactly what its tools need, every tool
// its instructions name is in its list, the seeded agent got those scopes,
// and its rules pass the trigger validation people's edits go through.
func TestPilotRecipesCreateNarrowAgents(t *testing.T) {
	w := newWorld(t, quietless())
	definitions := map[string]agent.Scope{}
	for _, definition := range w.executor.Definitions() {
		definitions[definition.Name] = definition.RequiredScope
	}
	toolName := regexp.MustCompile(`\b[a-z]+(?:_[a-z]+)+\b`)
	recipes := agent.Recipes("ru")
	if len(recipes) != 6 {
		t.Fatalf("pilot catalog has %d recipes", len(recipes))
	}
	for _, locale := range agent.RecipeLocales {
		for _, recipe := range agent.Recipes(locale) {
			needed := map[agent.Scope]bool{agent.ScopeRuntimeExecute: true, agent.ScopeMessagesRead: true}
			for _, tool := range recipe.Tools {
				scope, ok := definitions[tool]
				if !ok {
					t.Fatalf("%s/%s lists unknown tool %s", recipe.ID, locale, tool)
				}
				needed[scope] = true
			}
			for _, scope := range recipe.Scopes {
				if !needed[scope] {
					t.Errorf("%s/%s has scope %s no tool needs", recipe.ID, locale, scope)
				}
				delete(needed, scope)
			}
			if len(needed) > 0 {
				t.Errorf("%s/%s lacks scopes %v", recipe.ID, locale, needed)
			}
			for _, mentioned := range toolName.FindAllString(recipe.Instructions, -1) {
				if _, isTool := definitions[mentioned]; isTool && !slices.Contains(recipe.Tools, mentioned) {
					t.Errorf("%s/%s instructions use %s outside its tool list", recipe.ID, locale, mentioned)
				}
			}
			for _, need := range recipe.Needs {
				// A slot table is only readable with tables:read; neither the
				// builder nor the Architect derives it from sources.
				if need.Kind == "schedule" && !slices.Contains(recipe.Scopes, agent.ScopeTablesRead) {
					t.Errorf("%s/%s reads the schedule without tables:read", recipe.ID, locale)
				}
			}
			if runes := len([]rune(recipe.Instructions)); runes > 4000 || runes < 200 {
				t.Errorf("%s/%s instructions have %d characters", recipe.ID, locale, runes)
			}
			if recipe.Name == "" || recipe.Summary == "" || recipe.Example == "" || len(recipe.Triggers) == 0 || len(recipe.Needs) == 0 || len(recipe.Checks) < 3 || len(recipe.Checks) > 5 {
				t.Errorf("%s/%s is incomplete: %+v", recipe.ID, locale, recipe)
			}
			for _, text := range append([]string{recipe.Instructions, recipe.Summary, recipe.Example}, recipe.Checks[0].Prompt) {
				if strings.Contains(text, "{{") {
					t.Errorf("%s/%s has an unresolved parameter: %q", recipe.ID, locale, text)
				}
			}
		}
	}
	owner := w.seed.Owner()
	for id, created := range w.seed.Agents {
		recipe, _ := agent.RecipeByID(id, "ru")
		if created.Recipe != id || created.Description != recipe.Instructions || !slices.Equal(created.AllowedScopes, recipe.Scopes) || created.Enabled || created.PublishedVersion != nil {
			t.Errorf("seeded %s = recipe %s, scopes %v, enabled %v", id, created.Recipe, created.AllowedScopes, created.Enabled)
		}
		triggers, err := w.triggers.List(w.ctx, owner, created.ID)
		if err != nil || len(triggers) != len(recipe.Triggers) {
			t.Fatalf("%s triggers = %+v, err=%v", id, triggers, err)
		}
		for _, trigger := range triggers {
			config := trigger.Config
			if _, err := w.triggers.Update(w.ctx, owner, created.ID, trigger.ID, agenttrigger.UpdateInput{Config: &config}); err != nil {
				t.Errorf("%s %s trigger does not validate: %v (%s)", id, trigger.Type, err, config)
			}
		}
	}
}

// TestRecipeResetGivesCurrentTextsToLegacyAgents keeps agents created from the
// old templates working and lets "reset to template" bring the pilot texts.
func TestRecipeResetGivesCurrentTextsToLegacyAgents(t *testing.T) {
	w := newWorld(t, quietless())
	legacy := w.seed.Agents["qa"]
	const oldText = "Answer from accessible workspace history and extracted files."
	if _, err := w.pool.Exec(w.ctx, `UPDATE agents SET description=$2 WHERE actor_id=$1`, legacy.ID, oldText); err != nil {
		t.Fatal(err)
	}
	if _, err := w.pool.Exec(w.ctx, `UPDATE agent_drafts SET description=$2 WHERE agent_id=$1`, legacy.ID, oldText); err != nil {
		t.Fatal(err)
	}
	reset, err := w.agents.ResetRecipe(w.ctx, w.seed.Owner(), legacy.ID)
	english, _ := agent.RecipeByID("qa", "en")
	if err != nil || reset.Description != english.Instructions || reset.RecipeVersion != legacy.RecipeVersion+1 {
		t.Fatalf("reset of an English legacy agent = %q, err=%v", reset.Description, err)
	}
	russian, _ := agent.RecipeByID("qa", "ru")
	reset, err = w.agents.ResetRecipeIn(w.ctx, w.seed.Owner(), legacy.ID, "ru-RU")
	if err != nil || reset.Description != russian.Instructions || !slices.Equal(reset.AllowedScopes, russian.Scopes) {
		t.Fatalf("reset in Russian = %q, err=%v", reset.Description, err)
	}
	triggers, err := w.triggers.List(w.ctx, w.seed.Owner(), legacy.ID)
	if err != nil {
		t.Fatal(err)
	}
	commands := 0
	for _, trigger := range triggers {
		if trigger.Type == "command" && strings.Contains(string(trigger.Config), `"спросить"`) {
			commands++
		}
	}
	if commands != 1 {
		t.Fatalf("reset rules = %+v", triggers)
	}
}

// TestControlFollowsAcknowledgementsFromRequestToResult plays «Контроль»: the
// request under a message, a private progress card, reminders to the silent
// ones in direct messages, a refresh and the final count for the requester.
func TestControlFollowsAcknowledgementsFromRequestToResult(t *testing.T) {
	w := newWorld(t, quietless())
	control := w.publish("control")
	marina := w.person("marina")
	announcement := w.seed.Messages["entrance"]
	if _, _, err := w.messages.PutReaction(w.ctx, w.person("igor"), announcement, "✅"); err != nil {
		t.Fatal(err)
	}
	w.say("marina", "instructors", "@Контроль проследи, чтобы все отметились до пятницы", announcement, control.ID)
	if err := w.triggers.DispatchEvents(w.ctx); err != nil {
		t.Fatal(err)
	}
	request := w.claim(control.ID, "mention")
	if request.input["actor_id"] != marina.ActorID || request.input["actor_timezone"] != "Europe/Moscow" || request.input["thread_root_id"] != announcement {
		t.Fatalf("mention run input = %v", request.input)
	}
	w.call(request, "get_thread", map[string]any{"message_id": announcement})
	reactions := decode[struct {
		NotReacted []string `json:"not_reacted_actor_ids"`
	}](t, w.call(request, "get_reactions", map[string]any{"message_id": announcement}))
	if len(reactions.NotReacted) != 4 {
		t.Fatalf("not reacted = %v", reactions.NotReacted)
	}
	w.call(request, "list_members", map[string]any{"chat_id": w.seed.Chats["instructors"]})
	// The requester called the agent in a shared chat, so the personal
	// report is writing to a person directly: under the default policy it
	// waits for approval (the «person started it» exception covers only a
	// run started in the direct chat itself). Here Marina approves it.
	progress := decode[message.Message](t, w.callApproved(request, marina, "send_direct_card", map[string]any{
		"actor_id": marina.ActorID, "client_msg_id": uuid.NewString(),
		"blocks": card("Порядок входа с понедельника", "Отметились 1 из 5", []map[string]any{{"text": "Дарья Ким", "state": "pending"}}, nil),
	}))
	report := progress.ChatID
	if report != w.directChat(control.ID, marina.ActorID) || w.count(`SELECT count(*) FROM chat_members WHERE chat_id=$1`, report) != 2 {
		t.Fatalf("the progress card is not private to the requester: chat %s", report)
	}
	// A collection with private reminders is approved once, at its start.
	collection := decode[interactive.Collection](t, w.callApproved(request, marina, "start_collection", map[string]any{
		"message_id": announcement, "response": "reaction", "match": []string{"✅"}, "expect_all_members": true,
		"deadline_at": w.clock.Now().Add(3 * 24 * time.Hour).Format(time.RFC3339), "reminder_channel": "direct",
		"remind_every_seconds": 86400, "max_reminders": 2, "reminder_text": "Пожалуйста, отметьтесь ✅ под сообщением о порядке входа.",
		"report_chat_id": report, "note": "card:" + progress.ID,
	}))
	if len(collection.ExpectedActorIDs) != 5 || len(collection.PendingActorIDs) != 4 {
		t.Fatalf("collection = %+v", collection)
	}
	w.callApproved(request, marina, "update_card", map[string]any{"message_id": progress.ID, "blocks": card("Порядок входа с понедельника", "Отметились 1 из 5", nil,
		[]map[string]any{{"id": "refresh." + collection.ID, "label": "Обновить"}})})
	w.finish(request)
	// In the shared chat the agent only asked for approvals; the approval
	// cards never show what goes to the direct chat (who did not react).
	if got := w.count(`SELECT count(*) FROM messages WHERE chat_id=$1 AND actor_id=$2 AND (body LIKE '%Дарья%' OR COALESCE(blocks::text,'') LIKE '%Дарья%')`, w.seed.Chats["instructors"], control.ID); got != 0 {
		t.Fatalf("the shared chat shows %d agent messages naming people", got)
	}
	if got := w.count(`SELECT count(*) FROM messages WHERE chat_id=$1 AND actor_id=$2 AND NOT COALESCE(blocks::text,'') LIKE '%tool_confirmation%'`, w.seed.Chats["instructors"], control.ID); got != 0 {
		t.Fatalf("the agent wrote %d messages other than approval cards into the shared chat", got)
	}

	// A day later the server reminds the four silent people privately.
	w.clock.Advance(24*time.Hour + time.Minute)
	w.tick()
	if got := w.count(`SELECT count(*) FROM agent_reminders WHERE collection_id=$1`, collection.ID); got != 4 {
		t.Fatalf("reminders sent = %d", got)
	}
	if w.directChat(control.ID, w.person("vera").ActorID) == "" || w.directChat(control.ID, w.person("igor").ActorID) != "" {
		t.Fatal("reminders went to the wrong people")
	}

	// The requester refreshes the card from her direct chat.
	if _, err := w.messages.PressAction(w.ctx, marina, progress.ID, "refresh."+collection.ID); err != nil {
		t.Fatal(err)
	}
	refresh := w.claim(control.ID, "message_action")
	if refresh.chatID != report || refresh.input["action_id"] != "refresh."+collection.ID {
		t.Fatalf("refresh run = %+v", refresh)
	}
	current := decode[interactive.Collection](t, w.call(refresh, "get_collection", map[string]any{"collection_id": strings.TrimPrefix(refresh.input["action_id"].(string), "refresh.")}))
	if len(current.PendingActorIDs) != 4 {
		t.Fatalf("refreshed collection = %+v", current)
	}
	// Marina pressed the button in her direct chat: updating the card there
	// answers her own run and needs no approval.
	w.call(refresh, "update_card", map[string]any{"message_id": progress.ID, "blocks": card("Порядок входа с понедельника", "Отметились 1 из 5", nil,
		[]map[string]any{{"id": "refresh." + collection.ID, "label": "Обновить"}})})
	w.finish(refresh)

	for _, key := range []string{"daria", "vera", "oleg", "pavel"} {
		if _, _, err := w.messages.PutReaction(w.ctx, w.person(key), announcement, "✅"); err != nil {
			t.Fatal(err)
		}
	}
	// «Everyone answered» is noticed within a minute.
	w.clock.Advance(time.Minute + time.Second)
	w.tick()
	result := w.claim(control.ID, "collection")
	if result.chatID != report || result.input["reason"] != "completed" || result.input["note"] != "card:"+progress.ID {
		t.Fatalf("result run = %+v", result)
	}
	w.callApproved(result, marina, "update_card", map[string]any{"message_id": progress.ID, "blocks": card("Порядок входа с понедельника", "Отметились все 5", nil, nil)})
	w.finish(result)
}

// TestRemindersRespectPerPersonLimitsAndQuietHours runs two «Контроль»
// requests at once: a person gets no more reminders a day than the server
// allows, and nobody is reminded during quiet hours.
func TestRemindersRespectPerPersonLimitsAndQuietHours(t *testing.T) {
	limits := quietless()
	limits.MaxRemindersPerPersonPerDay = 1
	w := newWorld(t, limits)
	control := w.publish("control")
	start := func(target string) string {
		w.say("marina", "instructors", "@Контроль проследи, чтобы все отметились", target, control.ID)
		if err := w.triggers.DispatchEvents(w.ctx); err != nil {
			t.Fatal(err)
		}
		r := w.claim(control.ID, "mention")
		collection := decode[interactive.Collection](t, w.callApproved(r, w.person("marina"), "start_collection", map[string]any{
			"message_id": target, "response": "reaction", "expect_all_members": true, "deadline_in_seconds": 3 * 86400,
			"reminder_channel": "direct", "remind_every_seconds": 3600, "max_reminders": 2, "reminder_text": "Отметьтесь, пожалуйста.",
		}))
		w.finish(r)
		return collection.ID
	}
	first := start(w.seed.Messages["entrance"])
	second := start(w.say("marina", "instructors", "Завтра санитарный день, залы закрыты с 12:00.", "").ID)
	w.clock.Advance(time.Hour + time.Minute)
	w.tick()
	oleg := w.person("oleg").ActorID
	if got := w.count(`SELECT count(*) FROM agent_reminders WHERE actor_id=$1 AND collection_id=ANY($2::uuid[])`, oleg, []string{first, second}); got != 1 {
		t.Fatalf("Oleg got %d reminders, the daily cap is 1", got)
	}

	quiet := quietless()
	moscow, _ := time.LoadLocation("Europe/Moscow")
	silencedAt := w.clock.Now().Add(time.Hour)
	local := silencedAt.In(moscow)
	minute := local.Hour()*60 + local.Minute()
	quiet.QuietStartMinute, quiet.QuietEndMinute = (minute+1440-30)%1440, (minute+30)%1440
	silenced := interactive.NewService(w.pool, w.messages, w.chats, nil, quiet)
	silenced.SetClock(func() time.Time { return silencedAt })
	before := w.count(`SELECT count(*) FROM agent_reminders`)
	if err := silenced.Tick(w.ctx); err != nil {
		t.Fatal(err)
	}
	if after := w.count(`SELECT count(*) FROM agent_reminders`); after != before {
		t.Fatalf("reminders sent during quiet hours: %d → %d", before, after)
	}
}

// TestHelpDeskAnswersWithSourcesAndCallsAPersonWithoutAnswer plays «Справка».
func TestHelpDeskAnswersWithSourcesAndCallsAPersonWithoutAnswer(t *testing.T) {
	w := newWorld(t, quietless())
	help := w.publish("qa")
	w.say("igor", "questions", "@Справка как оформить замену, если я заболел в день занятия?", "", help.ID)
	if err := w.triggers.DispatchEvents(w.ctx); err != nil {
		t.Fatal(err)
	}
	answer := w.claim(help.ID, "mention")
	type fragments struct {
		Found     bool `json:"found"`
		Fragments []struct {
			DocumentTitle string `json:"document_title"`
			Section       string `json:"section"`
			Text          string `json:"text"`
		} `json:"fragments"`
	}
	found := decode[fragments](t, w.call(answer, "search_knowledge", map[string]any{"query": "замена заболел день занятия"}))
	if !found.Found || found.Fragments[0].DocumentTitle != "Регламент замен" || !strings.Contains(found.Fragments[0].Text, "08:00") {
		t.Fatalf("policy search = %+v", found)
	}
	w.finish(answer)

	question := w.say("pavel", "questions", "@Справка сколько стоит компенсация за переработку в выходные?", "", help.ID)
	if err := w.triggers.DispatchEvents(w.ctx); err != nil {
		t.Fatal(err)
	}
	missing := w.claim(help.ID, "mention")
	if nothing := decode[fragments](t, w.call(missing, "search_knowledge", map[string]any{"query": "компенсация переработка выходные"})); nothing.Found {
		t.Fatalf("an absent answer was found: %+v", nothing)
	}
	owners := decode[fragments](t, w.call(missing, "search_knowledge", map[string]any{"query": "кадровые вопросы отвечает"}))
	if !owners.Found || !strings.Contains(owners.Fragments[0].Text, "Марина Орлова") {
		t.Fatalf("owner search = %+v", owners)
	}
	members := decode[[]chat.Member](t, w.call(missing, "list_members", map[string]any{"chat_id": w.seed.Chats["questions"]}))
	var responsible string
	for _, member := range members {
		if member.DisplayName == "Марина Орлова" {
			responsible = member.ActorID
		}
	}
	called := decode[message.Message](t, w.call(missing, "post_card", map[string]any{
		"chat_id": w.seed.Chats["questions"], "thread_root_id": question.ID, "client_msg_id": uuid.NewString(), "mentioned_actor_ids": []string{responsible},
		"blocks": map[string]any{"version": 1, "card": map[string]any{"title": "Вопрос без ответа в базе знаний",
			"fields": []map[string]any{{"label": "Вопрос", "value": "Компенсация за переработку в выходные"}, {"label": "Спросил", "value": "Павел Нестеров"}}}},
	}))
	if !slices.Contains(called.MentionedActorIDs, w.person("marina").ActorID) || called.ThreadRootID == nil || *called.ThreadRootID != question.ID {
		t.Fatalf("the responsible person was not called: %+v", called)
	}
	// The help desk cannot answer people privately or write elsewhere.
	if _, err := w.tryCall(missing, "post_message", map[string]any{"chat_id": w.seed.Chats["questions"], "client_msg_id": uuid.NewString(), "body": "x"}); err == nil {
		t.Fatal("the help desk got a write scope it does not need")
	}
	w.finish(missing)
}

type tableRow struct {
	Values map[string]string `json:"values"`
}

func slotRows(t *testing.T, w *world, r run, filters ...map[string]any) []tableRow {
	t.Helper()
	tables := decode[struct {
		Tables []struct {
			DocumentID string `json:"document_id"`
			Title      string `json:"title"`
		} `json:"tables"`
	}](t, w.call(r, "query_table", map[string]any{}))
	if len(tables.Tables) != 1 || tables.Tables[0].DocumentID != w.seed.Documents["schedule"] {
		t.Fatalf("tables = %+v", tables)
	}
	rows := decode[struct {
		Rows []tableRow `json:"rows"`
	}](t, w.call(r, "query_table", map[string]any{"document_id": tables.Tables[0].DocumentID, "filters": filters}))
	return rows.Rows
}

func memberIDs(t *testing.T, w *world, r run, chatKey string) map[string]string {
	t.Helper()
	members := decode[[]chat.Member](t, w.call(r, "list_members", map[string]any{"chat_id": w.seed.Chats[chatKey]}))
	result := map[string]string{}
	for _, member := range members {
		result[member.DisplayName] = member.ActorID
	}
	return result
}

// TestSlotsAsksFreeInstructorsAndLeavesTheTableToPeople plays «Слоты» on the
// table source: free instructors come from the schedule, answer with buttons,
// the administrator alone decides, and the table stays untouched.
func TestSlotsAsksFreeInstructorsAndLeavesTheTableToPeople(t *testing.T) {
	w := newWorld(t, quietless())
	slots := w.publish("slots")
	daria := w.person("daria")
	w.say("daria", "schedule", "@Слоты найди, кто может взять слот в зале 2 послезавтра с 14:00 до 18:00. Павел не сможет.", "", slots.ID)
	if err := w.triggers.DispatchEvents(w.ctx); err != nil {
		t.Fatal(err)
	}
	request := w.claim(slots.ID, "mention")
	if request.input["actor_id"] != daria.ActorID {
		t.Fatalf("request input = %v", request.input)
	}
	moscow, _ := time.LoadLocation("Europe/Moscow")
	day := w.clock.Now().In(moscow).AddDate(0, 0, 1).Format("2006-01-02")
	rows := slotRows(t, w, request, map[string]any{"column": "Дата", "value": day})
	busyAfternoon := map[string]bool{}
	var open []tableRow
	for _, row := range rows {
		if row.Values["Статус"] == "свободен" {
			open = append(open, row)
		} else if row.Values["Начало"] < "18:00" && row.Values["Конец"] > "14:00" {
			busyAfternoon[row.Values["Инструктор"]] = true
		}
	}
	if len(open) != 1 || open[0].Values["Зал"] != "Зал 2" {
		t.Fatalf("open slots = %+v", open)
	}
	members := memberIDs(t, w, request, "schedule")
	var candidates []string
	for _, name := range []string{"Игорь Сомов", "Вера Лисина", "Олег Тарасов"} {
		if !busyAfternoon[name] {
			candidates = append(candidates, members[name])
		}
	}
	if len(candidates) != 2 || slices.Contains(candidates, members["Олег Тарасов"]) {
		t.Fatalf("candidates = %v (busy %v)", candidates, busyAfternoon)
	}
	answer := map[string]any{"actor_ids": candidates}
	poll := decode[message.Message](t, w.call(request, "post_card", map[string]any{
		"chat_id": w.seed.Chats["schedule"], "client_msg_id": uuid.NewString(), "mentioned_actor_ids": candidates,
		"blocks": card("Слот: "+day+" 14:00–18:00 · Зал 2", "Ждём ответов", nil, []map[string]any{
			{"id": "can", "label": "Могу", "group": "answer", "limit": "per_actor", "allowed": answer},
			{"id": "cannot", "label": "Не могу", "group": "answer", "limit": "per_actor", "allowed": answer},
		}),
	}))
	collection := decode[interactive.Collection](t, w.call(request, "start_collection", map[string]any{
		"message_id": poll.ID, "response": "action", "match": []string{"can", "cannot"}, "expected_actor_ids": candidates,
		"deadline_in_seconds": 7200, "reminder_channel": "thread", "remind_every_seconds": 1800, "max_reminders": 1,
		"reminder_text": "Ответьте, пожалуйста, на вопрос о слоте в чате «Расписание».", "note": "admin:" + daria.ActorID + "; card:" + poll.ID,
	}))
	w.finish(request)
	if _, err := w.messages.PressAction(w.ctx, w.person("oleg"), poll.ID, "can"); !errors.Is(err, message.ErrForbidden) {
		t.Fatalf("a busy instructor answered: %v", err)
	}
	if _, err := w.messages.PressAction(w.ctx, w.person("igor"), poll.ID, "can"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.messages.PressAction(w.ctx, w.person("vera"), poll.ID, "cannot"); err != nil {
		t.Fatal(err)
	}
	w.clock.Advance(time.Minute + time.Second)
	w.tick()
	report := w.claim(slots.ID, "collection")
	result := decode[interactive.Collection](t, w.call(report, "get_collection", map[string]any{"collection_id": collection.ID}))
	if result.Status != "completed" || len(result.Responded) != 2 {
		t.Fatalf("answers = %+v", result)
	}
	choice := decode[message.Message](t, w.call(report, "post_card", map[string]any{
		"chat_id": w.seed.Chats["schedule"], "client_msg_id": uuid.NewString(), "mentioned_actor_ids": []string{daria.ActorID},
		"blocks": card("Слот: "+day+" 14:00–18:00 · Зал 2", "2 из 2 ответили", []map[string]any{{"text": "Игорь Сомов — могу"}, {"text": "Вера Лисина — не могу"}},
			[]map[string]any{
				{"id": "assign.1", "label": "Назначить Игоря Сомова", "limit": "single", "group": "decision", "allowed": map[string]any{"actor_ids": []string{daria.ActorID}}},
				{"id": "wait", "label": "Подождать", "limit": "single", "group": "decision", "allowed": map[string]any{"actor_ids": []string{daria.ActorID}}},
			}),
	}))
	w.finish(report)
	if _, err := w.messages.PressAction(w.ctx, w.person("igor"), choice.ID, "assign.1"); !errors.Is(err, message.ErrForbidden) {
		t.Fatalf("an instructor assigned himself: %v", err)
	}
	var version int
	if err := w.pool.QueryRow(w.ctx, `SELECT content_version FROM knowledge_documents WHERE id=$1`, w.seed.Documents["schedule"]).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if _, err := w.messages.PressAction(w.ctx, daria, choice.ID, "assign.1"); err != nil {
		t.Fatal(err)
	}
	decision := w.claim(slots.ID, "message_action")
	if decision.input["action_id"] != "assign.1" || decision.input["actor_id"] != daria.ActorID {
		t.Fatalf("decision input = %v", decision.input)
	}
	w.call(decision, "update_card", map[string]any{"message_id": choice.ID, "blocks": card("Слот: "+day+" 14:00–18:00 · Зал 2", "Закрыт — назначен Игорь Сомов", nil, nil)})
	w.finish(decision)
	var after int
	if err := w.pool.QueryRow(w.ctx, `SELECT content_version FROM knowledge_documents WHERE id=$1`, w.seed.Documents["schedule"]).Scan(&after); err != nil || after != version {
		t.Fatalf("the table changed: %d → %d (%v)", version, after, err)
	}
}

// TestHandoffAsksLeavingInstructorAndEscalatesUnacceptedSlot plays
// «Передача»: the morning plan, the question at the end of a slot, the
// handover card with «Принял слот» and the escalation when nobody accepts.
func TestHandoffAsksLeavingInstructorAndEscalatesUnacceptedSlot(t *testing.T) {
	w := newWorld(t, quietless())
	handoff := w.publish("handoff")
	if _, err := w.pool.Exec(w.ctx, `UPDATE agent_triggers SET next_run_at=now()-interval '1 minute' WHERE agent_id=$1 AND type='schedule'`, handoff.ID); err != nil {
		t.Fatal(err)
	}
	if err := w.triggers.DispatchSchedules(w.ctx); err != nil {
		t.Fatal(err)
	}
	plan := w.claim(handoff.ID, "schedule")
	moscow, _ := time.LoadLocation("Europe/Moscow")
	today := w.clock.Now().In(moscow)
	rows := slotRows(t, w, plan, map[string]any{"column": "Дата", "value": today.Format("2006-01-02")}, map[string]any{"column": "Зал", "value": "Зал 1"})
	if len(rows) != 2 || rows[0].Values["Инструктор"] != "Игорь Сомов" || rows[1].Values["Инструктор"] != "Вера Лисина" {
		t.Fatalf("hall 1 today = %+v", rows)
	}
	at := func(clock string) time.Time {
		parsed, _ := time.ParseInLocation("2006-01-02 15:04", today.Format("2006-01-02")+" "+clock, moscow)
		return parsed
	}
	slotEnd, nextStart := at(rows[0].Values["Конец"]), at(rows[1].Values["Начало"])
	people := memberIDs(t, w, plan, "hall1")
	igor, vera := people["Игорь Сомов"], people["Вера Лисина"]
	w.call(plan, "schedule_followup", map[string]any{"at": slotEnd.Format(time.RFC3339), "chat_id": w.seed.Chats["hall1"], "note": "handover",
		"context": map[string]any{"step": "ask", "hall": "Зал 1", "leaving": igor, "next": vera, "next_start": nextStart.Format(time.RFC3339)}})
	w.finish(plan)

	w.clock.Set(slotEnd.Add(30 * time.Second))
	w.tick()
	ask := w.claim(handoff.ID, "followup")
	if ask.chatID != w.seed.Chats["hall1"] || ask.input["context"].(map[string]any)["leaving"] != igor {
		t.Fatalf("follow-up run = %+v", ask)
	}
	question := decode[message.Message](t, w.call(ask, "post_card", map[string]any{
		"chat_id": w.seed.Chats["hall1"], "client_msg_id": uuid.NewString(), "mentioned_actor_ids": []string{igor},
		"blocks": card("Игорь, ваш слот закончился. В 14:00 заступает Вера Лисина. Что передать?", "Ждём ответа", nil, nil),
	}))
	w.call(ask, "start_collection", map[string]any{"message_id": question.ID, "response": "reply", "expected_actor_ids": []string{igor},
		"deadline_at": nextStart.Add(-15 * time.Minute).Format(time.RFC3339), "note": `{"step":"collect","next":"` + vera + `"}`})
	w.finish(ask)
	w.say("igor", "hall1", "В группе на 15:00 двое новеньких, пусть начнёт с разминки на ковриках.", question.ID)
	w.clock.Advance(time.Minute + time.Second)
	w.tick()
	collected := w.claim(handoff.ID, "collection")
	thread := decode[message.Page](t, w.call(collected, "get_thread", map[string]any{"message_id": question.ID}))
	if len(thread.Messages) == 0 || !strings.Contains(thread.Messages[len(thread.Messages)-1].Body, "разминки") {
		t.Fatalf("thread = %+v", thread)
	}
	handover := decode[message.Message](t, w.call(collected, "post_card", map[string]any{
		"chat_id": w.seed.Chats["hall1"], "client_msg_id": uuid.NewString(), "mentioned_actor_ids": []string{vera},
		"blocks": map[string]any{"version": 1,
			"card":    map[string]any{"title": "Вера, перед вашим слотом 14:00–18:00", "fields": []map[string]any{{"label": "От Игоря", "value": "Группа 15:00: двое новеньких, начать с разминки на ковриках"}}},
			"actions": []map[string]any{{"id": "accept", "label": "Принял слот", "limit": "single", "allowed": map[string]any{"actor_ids": []string{vera}}}},
			"sources": []map[string]any{{"kind": "message", "message_id": thread.Messages[len(thread.Messages)-1].ID}}},
	}))
	w.call(collected, "start_collection", map[string]any{"message_id": handover.ID, "response": "action", "match": []string{"accept"}, "expected_actor_ids": []string{vera},
		"deadline_at": nextStart.Add(5 * time.Minute).Format(time.RFC3339), "note": "step=accept"})
	w.finish(collected)
	if _, err := w.messages.PressAction(w.ctx, w.person("igor"), handover.ID, "accept"); !errors.Is(err, message.ErrForbidden) {
		t.Fatalf("somebody else accepted the slot: %v", err)
	}

	w.clock.Set(nextStart.Add(6 * time.Minute))
	w.tick()
	escalation := w.claim(handoff.ID, "collection")
	pending, _ := escalation.input["pending_actor_ids"].([]any)
	if escalation.input["reason"] != "expired" || len(pending) != 1 || pending[0] != vera {
		t.Fatalf("escalation input = %v", escalation.input)
	}
	members := decode[[]chat.Member](t, w.call(escalation, "list_members", map[string]any{"chat_id": w.seed.Chats["hall1"]}))
	var admins []string
	for _, member := range members {
		if member.Type == "user" && (member.Role == "owner" || member.Role == "admin") {
			admins = append(admins, member.ActorID)
		}
	}
	alert := decode[message.Message](t, w.call(escalation, "post_card", map[string]any{
		"chat_id": w.seed.Chats["hall1"], "client_msg_id": uuid.NewString(), "mentioned_actor_ids": admins,
		"blocks": card("Вера Лисина не подтвердила, что приняла слот в зале 1. Слот начался", "Нужно внимание", nil, nil),
	}))
	if !slices.Contains(alert.MentionedActorIDs, w.person("marina").ActorID) {
		t.Fatalf("the administrator was not told: %+v", alert.MentionedActorIDs)
	}
	w.finish(escalation)
}

// TestMentorGreetsNewcomerAndRemindsAboutOpenItems plays «Наставник».
func TestMentorGreetsNewcomerAndRemindsAboutOpenItems(t *testing.T) {
	w := newWorld(t, quietless())
	mentor := w.publish("onboarding")
	vera := w.person("vera")
	if _, err := w.chats.AddMember(w.ctx, w.seed.Owner(), w.seed.Chats["newcomers"], chat.MemberInput{ActorID: vera.ActorID, Role: "member"}); err != nil {
		t.Fatal(err)
	}
	if err := w.triggers.DispatchEvents(w.ctx); err != nil {
		t.Fatal(err)
	}
	greet := w.claim(mentor.ID, "event")
	eventData, _ := greet.input["event_data"].(map[string]any)
	if greet.input["event_type"] != "member.joined" || eventData["actor_id"] != vera.ActorID || greet.chatID != w.seed.Chats["newcomers"] {
		t.Fatalf("join run = %+v", greet)
	}
	items := []string{"Получить пропуск у администратора", "Прочитать правила работы в залах", "Пройти инструктаж по оборудованию", "Познакомиться с врачами отделения", "Провести занятие вместе с наставником"}
	cardItems := make([]map[string]any, 0, len(items))
	actions := make([]map[string]any, 0, len(items))
	for index, item := range items {
		cardItems = append(cardItems, map[string]any{"text": item, "state": "pending"})
		actions = append(actions, map[string]any{"id": "done." + string(rune('1'+index)), "label": item + " — готово", "limit": "per_actor", "allowed": map[string]any{"actor_ids": []string{vera.ActorID}}})
	}
	checklist := decode[message.Message](t, w.call(greet, "post_card", map[string]any{
		"chat_id": w.seed.Chats["newcomers"], "client_msg_id": uuid.NewString(), "mentioned_actor_ids": []string{vera.ActorID},
		"blocks": card("Первая неделя", "0 из 5", cardItems, actions),
	}))
	tomorrow := w.clock.Now().Add(24 * time.Hour)
	w.call(greet, "schedule_followup", map[string]any{"at": tomorrow.Format(time.RFC3339), "chat_id": w.seed.Chats["newcomers"], "note": "checklist",
		"context": map[string]any{"card_message_id": checklist.ID, "member_id": vera.ActorID}})
	w.finish(greet)

	if _, err := w.messages.PressAction(w.ctx, w.seed.Owner(), checklist.ID, "done.3"); !errors.Is(err, message.ErrForbidden) {
		t.Fatalf("someone else ticked the newcomer's item: %v", err)
	}
	if _, err := w.messages.PressAction(w.ctx, vera, checklist.ID, "done.3"); err != nil {
		t.Fatal(err)
	}
	ticked := w.claim(mentor.ID, "message_action")
	cardItems[2]["state"] = "done"
	w.call(ticked, "update_card", map[string]any{"message_id": checklist.ID, "blocks": card("Первая неделя", "1 из 5", cardItems, actions)})
	w.finish(ticked)

	w.clock.Advance(24*time.Hour + time.Minute)
	w.tick()
	remind := w.claim(mentor.ID, "followup")
	if remind.input["context"].(map[string]any)["member_id"] != vera.ActorID {
		t.Fatalf("follow-up = %v", remind.input)
	}
	// The reminder mentions the newcomer in the newcomers chat: no private
	// write, so no approval and no direct-message limit.
	reminder := decode[message.Message](t, w.call(remind, "post_card", map[string]any{"chat_id": w.seed.Chats["newcomers"], "client_msg_id": uuid.NewString(),
		"mentioned_actor_ids": []string{vera.ActorID}, "blocks": card("Осталось на первой неделе", "4 пункта", cardItems[:2], nil)}))
	if !slices.Contains(reminder.MentionedActorIDs, vera.ActorID) || w.directChat(mentor.ID, vera.ActorID) != "" {
		t.Fatal("the reminder did not reach the newcomer in the newcomers chat")
	}
	keys := decode[struct {
		Found     bool `json:"found"`
		Fragments []struct {
			DocumentTitle string `json:"document_title"`
		} `json:"fragments"`
	}](t, w.call(remind, "search_knowledge", map[string]any{"query": "ключи от залов"}))
	if !keys.Found || keys.Fragments[0].DocumentTitle != "Правила работы в залах" {
		t.Fatalf("keys answer = %+v", keys)
	}
	w.finish(remind)
}

// TestWhatDidIMissSendsAPrivateSummaryWithLinks plays «Что я пропустил».
func TestWhatDidIMissSendsAPrivateSummaryWithLinks(t *testing.T) {
	w := newWorld(t, quietless())
	missed := w.publish("summarizer")
	igor := w.person("igor")
	summaryCard := func(sourceID string) map[string]any {
		return map[string]any{"actor_id": igor.ActorID, "client_msg_id": uuid.NewString(),
			"blocks": map[string]any{"version": 1, "card": map[string]any{"title": "Пока вас не было: 3 дня", "items": []map[string]any{{"text": "Расписание: нужен инструктор в зал 2 послезавтра 14:00–18:00"}}},
				"sources": []map[string]any{{"kind": "message", "message_id": sourceID}}}}
	}

	// Asked in a shared chat: the personal summary is writing to a person
	// directly and waits for approval under the default policy.
	w.say("igor", "hall1", "/пропустил 3 дня", "")
	if err := w.triggers.DispatchEvents(w.ctx); err != nil {
		t.Fatal(err)
	}
	request := w.claim(missed.ID, "command")
	if request.input["command"] != "пропустил" || request.input["command_arguments"] != "3 дня" || request.input["actor_id"] != igor.ActorID {
		t.Fatalf("command run = %v", request.input)
	}
	page := decode[message.Page](t, w.call(request, "get_chat_messages", map[string]any{"chat_id": w.seed.Chats["schedule"]}))
	if len(page.Messages) == 0 {
		t.Fatal("no schedule messages")
	}
	if _, err := w.tryCall(request, "get_chat_messages", map[string]any{"chat_id": w.seed.Chats["questions"]}); err == nil {
		t.Fatal("the summary read a chat the agent is not in")
	}
	if _, err := w.tryCall(request, "send_direct_card", summaryCard(page.Messages[0].ID)); err == nil || !strings.Contains(err.Error(), "confirmation") {
		t.Fatalf("a personal summary asked from a shared chat went out without approval: %v", err)
	}
	if w.directChat(missed.ID, igor.ActorID) != "" {
		t.Fatal("a direct chat was opened before approval")
	}
	w.finish(request)

	// Asked in his own direct chat with the agent: the answer goes out at once.
	direct, err := w.chats.Create(w.ctx, igor, chat.CreateInput{Kind: "direct", Visibility: "private", MemberIDs: []string{missed.ID}})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.messages.Create(w.ctx, igor, direct.ID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "/пропустил 3 дня"}); err != nil {
		t.Fatal(err)
	}
	if err := w.triggers.DispatchEvents(w.ctx); err != nil {
		t.Fatal(err)
	}
	own := w.claim(missed.ID, "command")
	if own.chatID != direct.ID {
		t.Fatalf("direct request run chat = %s", own.chatID)
	}
	summary := decode[message.Message](t, w.call(own, "send_direct_card", summaryCard(page.Messages[0].ID)))
	if summary.ChatID != direct.ID || summary.Blocks == nil || len(summary.Blocks.Sources) != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	if got := w.count(`SELECT count(*) FROM chat_members WHERE chat_id=$1`, summary.ChatID); got != 2 {
		t.Fatalf("the summary chat has %d members", got)
	}
	w.finish(own)
}

// TestSeedRefusesANonEmptyDatabase guards demo data from landing in a real
// workspace by accident.
func TestSeedRefusesANonEmptyDatabase(t *testing.T) {
	w := newWorld(t, quietless())
	_, err := pilotseed.Seed(w.ctx, pilotseed.Deps{Pool: w.pool, Hasher: plainHasher{}, Chats: w.chats, Messages: w.messages, Agents: w.agents},
		pilotseed.Options{Password: "demo-pilot-password"})
	if !errors.Is(err, pilotseed.ErrNotEmpty) {
		t.Fatalf("second seed error = %v", err)
	}
	_, err = pilotseed.Seed(w.ctx, pilotseed.Deps{Pool: w.pool, Hasher: plainHasher{}, Chats: w.chats, Messages: w.messages, Agents: w.agents},
		pilotseed.Options{Password: "demo-pilot-password", AllowNonEmpty: true})
	if err == nil || !strings.Contains(err.Error(), "ran here before") {
		t.Fatalf("repeated seed error = %v", err)
	}
	if got := w.count(`SELECT count(*) FROM organizations`); got != 1 {
		t.Fatalf("organizations = %d", got)
	}
	var raw json.RawMessage
	if err := w.pool.QueryRow(w.ctx, `SELECT blocks FROM messages WHERE id=$1`, w.seed.Messages["handover_card"]).Scan(&raw); err != nil || !strings.Contains(string(raw), "Принял слот") {
		t.Fatalf("demo handover card = %s, err=%v", raw, err)
	}
}

// TestSeedNextToRealDataCreatesNoAdministrators (security review, item 5):
// with --allow-non-empty the demo people are plain members, and the existing
// owner creates the demo chats and agents.
func TestSeedNextToRealDataCreatesNoAdministrators(t *testing.T) {
	pool := testdb.New(t)
	orgID, ownerID := uuid.NewString(), uuid.NewString()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `INSERT INTO organizations(id,name,slug) VALUES($1,'Real clinic','real-clinic')`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'user','owner','Real owner','real-owner')`, ownerID, orgID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := pilotseed.Seed(t.Context(), newDeps(t, pool), pilotseed.Options{Password: "demo-pilot-password"}); !errors.Is(err, pilotseed.ErrNotEmpty) {
		t.Fatalf("seed without the flag = %v", err)
	}
	result, err := pilotseed.Seed(t.Context(), newDeps(t, pool), pilotseed.Options{Password: "demo-pilot-password", AllowNonEmpty: true})
	if err != nil {
		t.Fatal(err)
	}
	var privileged int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM actors WHERE org_id=$1 AND type='user' AND org_role IN ('owner','admin') AND id<>$2`, orgID, ownerID).Scan(&privileged); err != nil || privileged != 0 {
		t.Fatalf("demo people with administrative rights: %d (err=%v)", privileged, err)
	}
	if result.OrgID != orgID || result.Owner().ActorID != ownerID || result.Agents["control"].OwnerActorID != ownerID {
		t.Fatalf("demo created by %s in %s", result.Owner().ActorID, result.OrgID)
	}
}
