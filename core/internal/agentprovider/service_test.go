package agentprovider

import "testing"

func TestUsageObserverAndPricing(t *testing.T) {
	observer := usageObserver{provider: "openai"}
	observer.observe([]byte("data: {\"usage\":{\"prompt_tokens\":1000,"))
	observer.observe([]byte("\"completion_tokens\":500}}\n\ndata: [DONE]\n\n"))
	input, output := observer.usage()
	if input != 1000 || output != 500 {
		t.Fatalf("usage=%d/%d", input, output)
	}
	cost, source := estimateCost("openai", "gpt-5-mini", input, output)
	if cost != "0.00125000" || source != "configured" {
		t.Fatalf("cost=%s source=%s", cost, source)
	}
}

func TestProviderTargetRejectsArbitraryProvider(t *testing.T) {
	if _, _, err := providerTarget("unknown", "https://example.com", "secret"); err == nil {
		t.Fatal("unknown provider accepted")
	}
}
