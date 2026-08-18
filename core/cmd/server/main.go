package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/config"
	serverhttp "github.com/comamessenger/comamessenger/core/internal/http"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		client := &http.Client{Timeout: 2 * time.Second}
		response, err := client.Get("http://localhost:8080/healthz")
		if err != nil || response.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		_ = response.Body.Close()
		return
	}

	cfg, err := config.FromEnvironment()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           serverhttp.NewHandler(logger, cfg.PublicAppURL),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	shutdownSignals, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("http server started", "address", cfg.HTTPAddr, "environment", cfg.AppEnv)
		if serveErr := server.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			logger.Error("http server failed", "error", serveErr)
			os.Exit(1)
		}
	}()

	<-shutdownSignals.Done()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
	logger.Info("http server stopped")
}
