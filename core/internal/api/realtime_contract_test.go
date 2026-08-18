package api

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func TestRealtimeV1FixturesMatchSchemaAndGeneratedTypes(t *testing.T) {
	protocolRoot := protocolPackageRoot(t)
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	schema, err := compiler.Compile(filepath.Join(protocolRoot, "schemas", "realtime", "v1.schema.json"))
	if err != nil {
		t.Fatalf("compile realtime schema: %v", err)
	}

	fixturePaths, err := filepath.Glob(filepath.Join(protocolRoot, "fixtures", "realtime", "v1", "*.json"))
	if err != nil {
		t.Fatalf("list realtime fixtures: %v", err)
	}
	sort.Strings(fixturePaths)
	if len(fixturePaths) == 0 {
		t.Fatal("no realtime v1 fixtures found")
	}

	for _, fixturePath := range fixturePaths {
		fixturePath := fixturePath
		name := filepath.Base(fixturePath)
		t.Run(name, func(t *testing.T) {
			payload, err := os.ReadFile(fixturePath)
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}

			var document any
			if err := json.Unmarshal(payload, &document); err != nil {
				t.Fatalf("decode fixture JSON: %v", err)
			}
			if err := schema.Validate(document); err != nil {
				t.Fatalf("validate fixture against JSON Schema: %v", err)
			}

			target := generatedFixtureTarget(t, name)
			decoder := json.NewDecoder(bytes.NewReader(payload))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(target); err != nil {
				t.Fatalf("decode fixture into generated Go type: %v", err)
			}
		})
	}
}

func TestRealtimeV1SchemaRejectsUnknownFields(t *testing.T) {
	compiler := jsonschema.NewCompiler()
	schema, err := compiler.Compile(filepath.Join(protocolPackageRoot(t), "schemas", "realtime", "v1.schema.json"))
	if err != nil {
		t.Fatalf("compile realtime schema: %v", err)
	}

	invalid := map[string]any{
		"op":         "ack",
		"seq":        42,
		"unexpected": true,
	}
	if err := schema.Validate(invalid); err == nil {
		t.Fatal("schema accepted a frame with an unknown field")
	}
}

func generatedFixtureTarget(t *testing.T, name string) any {
	t.Helper()
	switch name {
	case "ack.json":
		return &RealtimeAckFrameV1{}
	case "auth.json":
		return &RealtimeAuthFrameV1{}
	case "event.json":
		return &RealtimeDurableEventFrameV1{}
	case "hello.json":
		return &RealtimeHelloFrameV1{}
	case "resync-required.json":
		return &RealtimeResyncRequiredFrameV1{}
	case "typing.json":
		return &RealtimeTypingEventFrameV1{}
	default:
		t.Fatalf("fixture %s has no generated Go type mapping", name)
		return nil
	}
}

func protocolPackageRoot(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve realtime contract test path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "..", "..", "packages", "protocol"))
}
