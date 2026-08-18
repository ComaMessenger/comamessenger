package http

import (
	"context"
	"encoding/json"
	"log/slog"
	standardhttp "net/http"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type ReadinessCheck func(context.Context) error

func NewHandler(logger *slog.Logger, allowedOrigin string, readiness ReadinessCheck) standardhttp.Handler {
	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	router.Use(middleware.Recoverer)
	router.Use(requestLogger(logger))
	router.Use(cors(allowedOrigin))

	router.Get("/healthz", healthHandler(logger))
	router.Get("/readyz", readinessHandler(logger, readiness))

	return router
}

func healthHandler(logger *slog.Logger) standardhttp.HandlerFunc {
	return func(w standardhttp.ResponseWriter, _ *standardhttp.Request) {
		writeJSON(logger, w, standardhttp.StatusOK, api.Health{Status: "ok"})
	}
}

func readinessHandler(logger *slog.Logger, readiness ReadinessCheck) standardhttp.HandlerFunc {
	return func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()

		if readiness == nil || readiness(ctx) != nil {
			writeJSON(logger, w, standardhttp.StatusServiceUnavailable, api.Error{
				Code:      "service_not_ready",
				Message:   "A required service dependency is unavailable.",
				RequestId: middleware.GetReqID(r.Context()),
			})
			return
		}

		writeJSON(logger, w, standardhttp.StatusOK, api.Health{Status: "ready"})
	}
}

func writeJSON(logger *slog.Logger, w standardhttp.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		logger.Error("encode response", "error", err)
	}
}

func requestLogger(logger *slog.Logger) func(standardhttp.Handler) standardhttp.Handler {
	return func(next standardhttp.Handler) standardhttp.Handler {
		return standardhttp.HandlerFunc(func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
			startedAt := time.Now()
			next.ServeHTTP(w, r)
			logger.Info("http request",
				"method", r.Method,
				"path", r.URL.Path,
				"request_id", middleware.GetReqID(r.Context()),
				"duration", time.Since(startedAt),
			)
		})
	}
}

func cors(allowedOrigin string) func(standardhttp.Handler) standardhttp.Handler {
	return func(next standardhttp.Handler) standardhttp.Handler {
		return standardhttp.HandlerFunc(func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && origin == allowedOrigin {
				w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-ID")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
				w.Header().Set("Vary", "Origin")
			}
			if r.Method == standardhttp.MethodOptions {
				w.WriteHeader(standardhttp.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
