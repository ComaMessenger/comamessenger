// Package pilotseed creates the fictional rehabilitation centre of the phase
// 5.3 pilot: people, chats, a knowledge collection with policies and a slot
// table, and the six pilot agents as drafts. It feeds demos, mobile e2e and
// the Go scenario tests of the pilot recipes. All data is invented.
package pilotseed

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/knowledge"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotEmpty means the database already has an organization and the caller
// did not allow seeding next to existing data.
var ErrNotEmpty = errors.New("the database already has an organization; pass the explicit flag to seed next to existing data")

// Hasher hashes demo passwords; *password.Hasher satisfies it.
type Hasher interface {
	Hash(string) (string, error)
}

// Deps are the services the seed writes through, so every row passes the same
// validation as product requests.
type Deps struct {
	Pool      *pgxpool.Pool
	Hasher    Hasher
	Files     *files.Service
	Knowledge *knowledge.Service
	Chats     *chat.Service
	Messages  *message.Service
	Agents    *agent.Service
}

// Options tune one seed run.
type Options struct {
	// AllowNonEmpty seeds into the existing organization instead of refusing.
	AllowNonEmpty bool
	// Password of every demo account.
	Password string
	// Now anchors the slot table: today and the next two days.
	Now time.Time
	// Timezone of the demo people.
	Timezone string
	// EmailDomain of the demo accounts; example.com never delivers mail.
	EmailDomain string
}

// Person is one fictional member.
type Person struct {
	Key, Name, Handle, Role, Title string
}

// People of the demo centre. Keys are stable for tests and e2e.
var People = []Person{
	{Key: "marina", Name: "Марина Орлова", Handle: "marina", Role: "owner", Title: "Старший администратор"},
	{Key: "daria", Name: "Дарья Ким", Handle: "daria", Role: "admin", Title: "Администратор"},
	{Key: "igor", Name: "Игорь Сомов", Handle: "igor", Role: "member", Title: "Инструктор ЛФК"},
	{Key: "vera", Name: "Вера Лисина", Handle: "vera", Role: "member", Title: "Инструктор ЛФК"},
	{Key: "oleg", Name: "Олег Тарасов", Handle: "oleg", Role: "member", Title: "Инструктор ЛФК"},
	{Key: "pavel", Name: "Павел Нестеров", Handle: "pavel", Role: "member", Title: "Инструктор ЛФК"},
	{Key: "anna", Name: "Анна Белова", Handle: "anna", Role: "member", Title: "Врач-реабилитолог"},
}

type chatSpec struct {
	key, name, topic string
	members          []string
}

var chats = []chatSpec{
	{key: "hall1", name: "Зал 1", topic: "Занятия ЛФК в зале 1", members: []string{"marina", "daria", "igor", "vera"}},
	{key: "schedule", name: "Расписание", topic: "Слоты инструкторов и замены", members: []string{"marina", "daria", "igor", "vera", "oleg", "pavel"}},
	{key: "instructors", name: "Инструкторы", topic: "Объявления для инструкторов", members: []string{"marina", "daria", "igor", "vera", "oleg", "pavel"}},
	{key: "questions", name: "Вопросы по регламентам", topic: "Спросите @Справку или администратора", members: []string{"marina", "daria", "igor", "vera", "oleg", "pavel", "anna"}},
	{key: "newcomers", name: "Новички", topic: "Первая неделя в центре", members: []string{"marina", "daria"}},
}

// agentPlaces binds each pilot recipe to its chats and whether it reads the
// knowledge collection.
var agentPlaces = []struct {
	recipe, handle string
	chats          []string
	knowledge      bool
}{
	{recipe: "control", handle: "control", chats: []string{"instructors"}},
	{recipe: "qa", handle: "spravka", chats: []string{"questions"}, knowledge: true},
	{recipe: "onboarding", handle: "mentor", chats: []string{"newcomers"}, knowledge: true},
	{recipe: "slots", handle: "slots", chats: []string{"schedule"}, knowledge: true},
	{recipe: "handoff", handle: "handoff", chats: []string{"hall1"}, knowledge: true},
	{recipe: "summarizer", handle: "missed", chats: []string{"hall1", "schedule", "instructors"}},
}

// Result names what the seed created.
type Result struct {
	OrgID        string
	People       map[string]identity.User
	Chats        map[string]string
	CollectionID string
	Documents    map[string]string
	Agents       map[string]agent.Agent
	Messages     map[string]string
	ScheduleDay  string
	// Creator made the chats, the collection and the agents: the demo lead in
	// a new demo organization, the existing owner in a non-empty one.
	Creator identity.User
}

// Owner is the person who created the demo chats, knowledge and agents.
func (result Result) Owner() identity.User { return result.Creator }

// Seed creates the demo centre. It refuses a database that already has an
// organization unless AllowNonEmpty is set.
func Seed(ctx context.Context, deps Deps, options Options) (Result, error) {
	if options.Password == "" || len(options.Password) < 12 {
		return Result{}, fmt.Errorf("the demo password must have at least 12 characters")
	}
	if options.Now.IsZero() {
		options.Now = time.Now()
	}
	if options.Timezone == "" {
		options.Timezone = "Europe/Moscow"
	}
	if options.EmailDomain == "" {
		options.EmailDomain = "example.com"
	}
	location, err := time.LoadLocation(options.Timezone)
	if err != nil {
		return Result{}, fmt.Errorf("demo timezone: %w", err)
	}
	result := Result{People: map[string]identity.User{}, Chats: map[string]string{}, Documents: map[string]string{}, Agents: map[string]agent.Agent{}, Messages: map[string]string{}}
	if err := seedPeople(ctx, deps, options, &result); err != nil {
		return Result{}, err
	}
	owner := result.Owner()
	for _, spec := range chats {
		memberIDs := make([]string, 0, len(spec.members))
		for _, key := range spec.members {
			if result.People[key].ActorID != owner.ActorID {
				memberIDs = append(memberIDs, result.People[key].ActorID)
			}
		}
		created, err := deps.Chats.Create(ctx, owner, chat.CreateInput{Kind: "group", Visibility: "private", Name: spec.name, Topic: spec.topic, MemberIDs: memberIDs})
		if err != nil {
			return Result{}, fmt.Errorf("create chat %s: %w", spec.name, err)
		}
		result.Chats[spec.key] = created.ID
	}
	if err := seedKnowledge(ctx, deps, options.Now.In(location), &result); err != nil {
		return Result{}, err
	}
	if err := seedMessages(ctx, deps, &result); err != nil {
		return Result{}, err
	}
	for _, place := range agentPlaces {
		recipe, _ := agent.RecipeByID(place.recipe, "ru")
		chatIDs := make([]string, 0, len(place.chats))
		for _, key := range place.chats {
			chatIDs = append(chatIDs, result.Chats[key])
		}
		input := agent.CreateInput{
			DisplayName: recipe.Name, Handle: place.handle, Kind: "builtin", Recipe: place.recipe, Locale: "ru",
			Provider: "openai", Model: "gpt-5-mini", ChatIDs: chatIDs,
		}
		if place.knowledge {
			input.KnowledgeCollectionIDs = []string{result.CollectionID}
		}
		created, err := deps.Agents.Create(ctx, owner, input)
		if err != nil {
			return Result{}, fmt.Errorf("create agent %s: %w", recipe.Name, err)
		}
		result.Agents[place.recipe] = created
	}
	if err := seedHandoverCard(ctx, deps, &result); err != nil {
		return Result{}, err
	}
	return result, nil
}

// seedHandoverCard shows the «Передача» scenario in «Зал 1» without a model:
// the card a handover run posts for the next instructor, with the «Принял
// слот» button only she may press. It is recorded under a completed run whose
// input says it came from the seed, so the activity log stays truthful. The
// agents are drafts, so pressing the button records the answer but starts no
// run until the agent is published.
func seedHandoverCard(ctx context.Context, deps Deps, result *Result) error {
	handover := result.Agents["handoff"]
	runID, err := id.New()
	if err != nil {
		return err
	}
	correlationID, err := id.New()
	if err != nil {
		return err
	}
	if _, err := deps.Pool.Exec(ctx, `INSERT INTO agent_runs(id,org_id,agent_id,chat_id,correlation_id,status,started_at,finished_at,input)
		VALUES($1,$2,$3,$4,$5,'completed',now(),now(),'{"trigger_type":"seed","seed":"pilot-5.3"}')`,
		runID, result.OrgID, handover.ID, result.Chats["hall1"], correlationID); err != nil {
		return fmt.Errorf("record seed run: %w", err)
	}
	vera := result.People["vera"].ActorID
	clientID, err := id.New()
	if err != nil {
		return err
	}
	card, _, err := deps.Messages.CreateForAgentRun(ctx, identity.User{ActorID: handover.ID, OrgID: result.OrgID, OrgRole: "member"}, result.Chats["hall1"], message.CreateInput{
		ClientMsgID: clientID, Body: "Вера, перед вашим слотом 14:00–18:00", MentionedActorIDs: []string{vera},
		Blocks: &message.Blocks{Version: message.BlocksVersion,
			Card: &message.Card{Title: "Вера, перед вашим слотом 14:00–18:00", Status: &message.CardStatus{Label: "Не прочитано", Tone: "warning"},
				Fields: []message.CardField{
					{Label: "От Игоря", Value: "Группа 15:00: двое новеньких, начать с разминки на ковриках"},
					{Label: "Оборудование", Value: "Велотренажёр №3 не использовать"},
					{Label: "Зал", Value: "Течёт кондиционер, под ним ведро. Администраторы в курсе"},
				}},
			Actions: []message.Action{{ID: "accept", Label: "Принял слот", Style: "primary", Limit: "single", Allowed: &message.ActionAudience{ActorIDs: []string{vera}}}},
			Sources: []message.Source{
				{Kind: "message", MessageID: result.Messages["bike"], Title: "Игорь Сомов"},
				{Kind: "message", MessageID: result.Messages["ac_leak"], Title: "Игорь Сомов"},
				{Kind: "document", DocumentID: result.Documents["schedule"], Title: ScheduleTitle},
			},
		},
	}, message.AgentProvenance{RunID: runID})
	if err != nil {
		return fmt.Errorf("post demo handover card: %w", err)
	}
	result.Messages["handover_card"] = card.ID
	return nil
}

func seedPeople(ctx context.Context, deps Deps, options Options, result *Result) error {
	tx, err := deps.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `LOCK TABLE organizations IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		return err
	}
	var orgID string
	existing := false
	err = tx.QueryRow(ctx, `SELECT id FROM organizations ORDER BY created_at, id LIMIT 1`).Scan(&orgID)
	switch {
	case err == nil && !options.AllowNonEmpty:
		return ErrNotEmpty
	case err == nil:
		existing = true
		var taken bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM actors WHERE org_id=$1 AND handle=ANY($2::text[]))`, orgID, handles()).Scan(&taken); err != nil {
			return err
		}
		if taken {
			return fmt.Errorf("the organization already has demo handles (%s); the pilot seed ran here before", strings.Join(handles(), ", "))
		}
	case strings.Contains(err.Error(), "no rows"):
		if orgID, err = id.New(); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO organizations(id,name,slug) VALUES($1,'Реабилитационный центр «Сосновый бор» (демо)','sosnovy-bor-demo')`, orgID); err != nil {
			return fmt.Errorf("create demo organization: %w", err)
		}
	default:
		return err
	}
	passwordHash, err := deps.Hasher.Hash(options.Password)
	if err != nil {
		return err
	}
	for _, person := range People {
		actorID, err := id.New()
		if err != nil {
			return err
		}
		role := person.Role
		if existing {
			// Next to real data, demo accounts with known logins never get
			// administrative rights.
			role = "member"
		}
		if _, err := tx.Exec(ctx, `INSERT INTO actors(id,org_id,type,org_role,display_name,handle,timezone,title) VALUES($1,$2,'user',$3,$4,$5,$6,$7)`,
			actorID, orgID, role, person.Name, person.Handle, options.Timezone, person.Title); err != nil {
			return fmt.Errorf("create demo person %s: %w", person.Name, err)
		}
		email := person.Handle + ".demo@" + options.EmailDomain
		if _, err := tx.Exec(ctx, `INSERT INTO users(actor_id,org_id,email,password_hash,email_verified_at) VALUES($1,$2,$3,$4,now())`, actorID, orgID, email, passwordHash); err != nil {
			return fmt.Errorf("create demo account %s: %w", email, err)
		}
		result.People[person.Key] = identity.User{ActorID: actorID, OrgID: orgID, OrgRole: role, Email: email, DisplayName: person.Name, Handle: person.Handle,
			Timezone: options.Timezone, Status: "active", Permissions: permission.Effective(role, nil)}
	}
	result.Creator = result.People["marina"]
	if existing {
		var ownerID, name, handle, timezone string
		if err := tx.QueryRow(ctx, `SELECT id,display_name,handle,timezone FROM actors WHERE org_id=$1 AND type='user' AND org_role='owner' AND status='active' AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1`, orgID).
			Scan(&ownerID, &name, &handle, &timezone); err != nil {
			return fmt.Errorf("the existing organization has no active owner to create the demo: %w", err)
		}
		result.Creator = identity.User{ActorID: ownerID, OrgID: orgID, OrgRole: "owner", DisplayName: name, Handle: handle, Timezone: timezone, Status: "active", Permissions: permission.Effective("owner", nil)}
	}
	auditID, err := id.New()
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'organization.demo_seed','organization',$2,'{"seed":"pilot-5.3"}')`,
		auditID, orgID, result.Creator.ActorID); err != nil {
		return err
	}
	result.OrgID = orgID
	return tx.Commit(ctx)
}

func handles() []string {
	result := make([]string, 0, len(People)+len(agentPlaces))
	for _, person := range People {
		result = append(result, person.Handle)
	}
	for _, place := range agentPlaces {
		result = append(result, place.handle)
	}
	return result
}

// Policies are markdown pages of the demo knowledge collection.
var Policies = []struct{ Key, Title, Body string }{
	{Key: "substitutions", Title: "Регламент замен", Body: `# Регламент замен

## 1. Плановая замена
1.1. О плановой замене инструктор сообщает дежурному администратору не позднее чем за сутки.
1.2. Администратор публикует слот в чате «Расписание» и подбирает замену из инструкторов того же профиля.

## 2. Замена в день занятия
2.1. Если инструктор заболел в день занятия, он до 08:00 пишет дежурному администратору, какие занятия затронуты.
2.2. Дежурный администратор подбирает замену из списка инструкторов того же профиля.
2.3. Если замены нет, занятие переносят; участников оповещает администратор.

## 3. Передача между слотами
3.1. Уходящий инструктор передаёт заступающему важное о группах, оборудовании и зале.
3.2. Заступающий подтверждает, что принял слот, до его начала.
`},
	{Key: "halls", Title: "Правила работы в залах", Body: `# Правила работы в залах

## 1. Вход
1.1. Инструкторы заходят через служебную дверь со стороны парковки, пропуск обязателен.
1.2. Главный вход — только для посетителей.

## 2. Оборудование
2.1. Неисправный тренажёр отмечают табличкой «Не использовать» и сообщают администратору.
2.2. Инструктаж по оборудованию проводит старший инструктор зала.

## 4. Ключи
4.1. Ключи от залов выдаёт дежурный администратор на стойке, под подпись в журнале.
4.2. Ключи возвращают в тот же день.
`},
	{Key: "owners", Title: "Кто за что отвечает", Body: `# Кто за что отвечает

- Расписание, замены и слоты — Дарья Ким, администратор.
- Кадровые вопросы, отпуска и документы — Марина Орлова, старший администратор.
- Оборудование залов и инструктаж — Игорь Сомов, старший инструктор зала 1.
- Медицинские вопросы по программам ЛФК — Анна Белова, врач-реабилитолог.
`},
}

// ScheduleTitle is the slot table document; the pilot recipes read it with
// query_table.
const ScheduleTitle = "Расписание слотов"

func scheduleCSV(day time.Time) string {
	d0 := day.Format("2006-01-02")
	d1 := day.AddDate(0, 0, 1).Format("2006-01-02")
	d2 := day.AddDate(0, 0, 2).Format("2006-01-02")
	return "Слот;Дата;Начало;Конец;Зал;Инструктор;Занятие;Статус\n" +
		"s-1;" + d0 + ";09:00;13:00;Зал 1;Игорь Сомов;ЛФК;занят\n" +
		"s-2;" + d0 + ";14:00;18:00;Зал 1;Вера Лисина;ЛФК;занят\n" +
		"s-3;" + d0 + ";09:00;13:00;Зал 2;Олег Тарасов;ЛФК;занят\n" +
		"s-4;" + d0 + ";14:00;18:00;Зал 2;Павел Нестеров;ЛФК;занят\n" +
		"s-5;" + d1 + ";09:00;13:00;Зал 1;Игорь Сомов;ЛФК;занят\n" +
		"s-6;" + d1 + ";09:00;13:00;Зал 2;Вера Лисина;ЛФК;занят\n" +
		"s-7;" + d1 + ";14:00;18:00;Зал 1;Олег Тарасов;ЛФК;занят\n" +
		"s-8;" + d1 + ";14:00;18:00;Зал 2;;ЛФК;свободен\n" +
		"s-9;" + d2 + ";09:00;13:00;Зал 1;Павел Нестеров;ЛФК;занят\n" +
		"s-10;" + d2 + ";14:00;18:00;Зал 1;Игорь Сомов;ЛФК;занят\n"
}

func seedKnowledge(ctx context.Context, deps Deps, day time.Time, result *Result) error {
	owner := result.Owner()
	collection, err := deps.Knowledge.CreateCollection(ctx, owner, knowledge.CreateCollectionInput{
		Name: "Регламенты центра", Description: "Регламенты, правила залов, ответственные и расписание слотов (демо)",
	})
	if err != nil {
		return fmt.Errorf("create knowledge collection: %w", err)
	}
	result.CollectionID = collection.ID
	for _, policy := range Policies {
		document, err := deps.Knowledge.CreateDocument(ctx, owner, collection.ID, knowledge.CreateDocumentInput{Kind: "page", Title: policy.Title, Body: policy.Body})
		if err != nil {
			return fmt.Errorf("create policy %s: %w", policy.Title, err)
		}
		if err := deps.Knowledge.IndexDocument(ctx, document.ID, document.ContentVersion); err != nil {
			return fmt.Errorf("index policy %s: %w", policy.Title, err)
		}
		result.Documents[policy.Key] = document.ID
	}
	content := []byte(scheduleCSV(day))
	upload, err := deps.Files.CreateUpload(ctx, owner, files.CreateUploadInput{Name: ScheduleTitle + ".csv", MIME: "text/csv", Size: int64(len(content))})
	if err != nil {
		return fmt.Errorf("upload slot table: %w", err)
	}
	file, err := deps.Files.PutContent(ctx, owner, upload.ID, bytes.NewReader(content))
	if err != nil {
		return fmt.Errorf("store slot table: %w", err)
	}
	document, err := deps.Knowledge.CreateDocument(ctx, owner, collection.ID, knowledge.CreateDocumentInput{Kind: "file", FileID: file.ID, Title: ScheduleTitle})
	if err != nil {
		return fmt.Errorf("create slot table document: %w", err)
	}
	if err := deps.Knowledge.IndexDocument(ctx, document.ID, document.ContentVersion); err != nil {
		return fmt.Errorf("index slot table: %w", err)
	}
	result.Documents["schedule"] = document.ID
	result.ScheduleDay = day.Format("2006-01-02")
	return nil
}

func seedMessages(ctx context.Context, deps Deps, result *Result) error {
	post := func(key, person, chatKey, body string) error {
		clientID, err := id.New()
		if err != nil {
			return err
		}
		created, _, err := deps.Messages.Create(ctx, result.People[person], result.Chats[chatKey], message.CreateInput{ClientMsgID: clientID, Body: body})
		if err != nil {
			return fmt.Errorf("post demo message %s: %w", key, err)
		}
		result.Messages[key] = created.ID
		return nil
	}
	for _, item := range []struct{ key, person, chat, body string }{
		{"entrance", "marina", "instructors", "С понедельника меняется порядок входа. Инструкторы заходят через служебную дверь со стороны парковки, пропуск обязателен. Главный вход — только для посетителей.\n\nПоставьте ✅, когда прочитаете."},
		{"ac_leak", "igor", "hall1", "Кондиционер опять течёт, поставил ведро. Администраторам написал."},
		{"bike", "igor", "hall1", "Третий велотренажёр не трогать — скрипит педаль, ждём мастера."},
		{"thursday", "daria", "schedule", "Павел не сможет послезавтра. Нужен инструктор в зал 2 с 14:00 до 18:00, две группы ЛФК."},
		{"welcome", "marina", "questions", "Здесь можно задать вопрос о регламентах. Агент «Справка» отвечает по базе знаний и зовёт ответственного, если ответа нет."},
	} {
		if err := post(item.key, item.person, item.chat, item.body); err != nil {
			return err
		}
	}
	return nil
}
