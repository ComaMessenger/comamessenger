package chat

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

func TestNameAndTopicLimitsCountCharacters(t *testing.T) {
	cases := []struct {
		name  string
		value string
		valid bool
	}{
		{"80 Cyrillic letters", strings.Repeat("ж", 80), true},
		{"81 Cyrillic letters", strings.Repeat("ж", 81), false},
		{"80 Latin letters", strings.Repeat("a", 80), true},
		{"81 Latin letters", strings.Repeat("a", 81), false},
		// One code point each: 80 emoji fit, 81 do not.
		{"80 emoji", strings.Repeat("🚀", 80), true},
		{"81 emoji", strings.Repeat("🚀", 81), false},
		// A flag is two code points, a ZWJ family five: counted as such.
		{"40 flags", strings.Repeat("🇷🇺", 40), true},
		{"41 flags", strings.Repeat("🇷🇺", 41), false},
		{"16 families", strings.Repeat("👨‍👩‍👧", 16), true},
		{"empty", "", false},
	}
	for _, item := range cases {
		err := validateName(item.value)
		if (err == nil) != item.valid {
			t.Fatalf("%s: validateName() = %v, want valid=%v", item.name, err, item.valid)
		}
		if err != nil && (!errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "name must contain 1 to 80 characters")) {
			t.Fatalf("%s: error = %q", item.name, err)
		}
	}
	if err := validateTopic(strings.Repeat("ж", 500)); err != nil {
		t.Fatalf("500 Cyrillic topic: %v", err)
	}
	if err := validateTopic(strings.Repeat("ж", 501)); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "topic must contain at most 500 characters") {
		t.Fatalf("501 Cyrillic topic: %v", err)
	}
}

func TestLongCyrillicChatNameIsAccepted(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	orgID, ownerID, legacyID := chatTestID(t), chatTestID(t), chatTestID(t)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO organizations(id,name,slug) VALUES($1,'Names','names')`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'user','owner','Owner','owner')`, ownerID, orgID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: ownerID, OrgID: orgID, OrgRole: "owner", Status: "active"}
	service := NewService(pool)

	name := strings.Repeat("Ж", 80)
	created, err := service.Create(ctx, owner, CreateInput{Kind: "group", Name: name, Topic: strings.Repeat("т", 500)})
	if err != nil {
		t.Fatalf("Create(80 Cyrillic letters) error = %v", err)
	}
	if created.Name == nil || *created.Name != name {
		t.Fatalf("created name = %v", created.Name)
	}
	if _, err := service.Create(ctx, owner, CreateInput{Kind: "group", Name: name + "Ж"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Create(81 letters) error = %v, want ErrInvalid", err)
	}
	renamed := strings.Repeat("ё", 80)
	if updated, err := service.Update(ctx, owner, created.ID, UpdateInput{Name: &renamed}); err != nil || *updated.Name != renamed {
		t.Fatalf("Update(80 letters) = %+v, %v", updated.Name, err)
	}
	tooLong := renamed + "ё"
	if _, err := service.Update(ctx, owner, created.ID, UpdateInput{Name: &tooLong}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Update(81 letters) error = %v, want ErrInvalid", err)
	}

	// A chat named under the old limit (120 bytes) keeps working: its topic
	// can still change without a rename.
	legacyName := strings.Repeat("n", 120)
	legacy, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer legacy.Rollback(ctx)
	if _, err := legacy.Exec(ctx, `INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($1,$2,'group','private',$3,$4)`, legacyID, orgID, legacyName, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(ctx, `INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'owner')`, legacyID, ownerID, orgID); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	topic := "новое описание"
	if updated, err := service.Update(ctx, owner, legacyID, UpdateInput{Topic: &topic}); err != nil || updated.Topic != topic {
		t.Fatalf("legacy Update(topic) = %+v, %v", updated, err)
	}
	// The web sends the name it shows along with the new topic.
	unchanged, other := legacyName, "ещё описание"
	if updated, err := service.Update(ctx, owner, legacyID, UpdateInput{Name: &unchanged, Topic: &other}); err != nil || updated.Topic != other || *updated.Name != legacyName {
		t.Fatalf("legacy Update(same name, topic) = %+v, %v", updated, err)
	}
	// Renaming it still has to fit the limit.
	longer := legacyName + "n"
	if _, err := service.Update(ctx, owner, legacyID, UpdateInput{Name: &longer}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("legacy rename to 121 characters error = %v, want ErrInvalid", err)
	}
}
