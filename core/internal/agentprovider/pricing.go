package agentprovider

// EstimateCost prices a provider call with the same table the runtime
// provider gateway uses, so every server-side model call is accounted alike.
// It returns the cost in USD with eight decimals and its price source.
func EstimateCost(provider, model string, inputTokens, outputTokens int64) (string, string) {
	return estimateCost(provider, model, inputTokens, outputTokens)
}
