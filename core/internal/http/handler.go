package http

import (
	"encoding/json"
	"log/slog"
	standardhttp "net/http"
)

type healthResponse struct {
	Status string `json:"status"`
}

func NewHandler(logger *slog.Logger, allowedOrigin string) standardhttp.Handler {
	mux := standardhttp.NewServeMux()
	mux.HandleFunc("GET /healthz", jsonHandler(logger, healthResponse{Status: "ok"}))
	mux.HandleFunc("GET /readyz", jsonHandler(logger, healthResponse{Status: "ready"}))
	return requestLogger(logger, cors(allowedOrigin, mux))
}

func jsonHandler(logger *slog.Logger, payload healthResponse) standardhttp.HandlerFunc {
	return func(w standardhttp.ResponseWriter, _ *standardhttp.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(payload); err != nil {
			logger.Error("encode response", "error", err)
		}
	}
}

func requestLogger(logger *slog.Logger, next standardhttp.Handler) standardhttp.Handler {
	return standardhttp.HandlerFunc(func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
		logger.Info("http request", "method", r.Method, "path", r.URL.Path)
		next.ServeHTTP(w, r)
	})
}

func cors(allowedOrigin string, next standardhttp.Handler) standardhttp.Handler {
	return standardhttp.HandlerFunc(func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
		if r.Header.Get("Origin") == allowedOrigin {
			w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
			w.Header().Set("Vary", "Origin")
		}
		next.ServeHTTP(w, r)
	})
}
