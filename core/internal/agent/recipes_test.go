package agent

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestRecipeFixturesMatchCatalog keeps the web e2e mock API on the Core
// catalog: the fixture files are generated from it, never edited by hand.
// Regenerate with UPDATE_RECIPE_FIXTURES=1 go test ./internal/agent -run Fixtures.
func TestRecipeFixturesMatchCatalog(t *testing.T) {
	for _, locale := range RecipeLocales {
		encoded, err := json.MarshalIndent(Recipes(locale), "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		encoded = append(encoded, '\n')
		path := filepath.Join("..", "..", "..", "apps", "web", "e2e", "fixtures", "agent-recipes."+locale+".json")
		if os.Getenv("UPDATE_RECIPE_FIXTURES") == "1" {
			if err := os.WriteFile(path, encoded, 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		current, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(current, encoded) {
			t.Fatalf("%s is out of date with the recipe catalog; run UPDATE_RECIPE_FIXTURES=1 go test ./internal/agent -run Fixtures (err=%v)", path, err)
		}
	}
}

func TestRecipeLocaleFallback(t *testing.T) {
	for input, want := range map[string]string{"ru": "ru", "ru-RU,ru;q=0.9": "ru", "en-US": "en", "de": "en", "": "en", "fr;q=1, ru;q=0.5": "ru"} {
		if got := NormalizeRecipeLocale(input); got != want {
			t.Errorf("NormalizeRecipeLocale(%q) = %q, want %q", input, got, want)
		}
	}
	if guessRecipeLocale("Ты — «Справка»") != "ru" || guessRecipeLocale("You are") != "en" {
		t.Fatal("locale guess")
	}
}
