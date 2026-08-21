package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/coordination"
	"github.com/comamessenger/comamessenger/core/internal/database"
	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	serverhttp "github.com/comamessenger/comamessenger/core/internal/http"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/password"
	"github.com/comamessenger/comamessenger/core/internal/push"
	"github.com/comamessenger/comamessenger/core/internal/realtime"
	"github.com/comamessenger/comamessenger/core/internal/userstate"
	"github.com/comamessenger/comamessenger/core/internal/workspace"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "vapid" {
		publicKey, privateKey, err := push.GenerateVAPIDKeys()
		if err != nil {
			os.Exit(1)
		}
		_, _ = os.Stdout.WriteString("VAPID_PUBLIC_KEY=" + publicKey + "\nVAPID_PRIVATE_KEY=" + privateKey + "\n")
		return
	}
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
	startupCtx, startupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer startupCancel()

	if err := database.Migrate(startupCtx, cfg.DatabaseURL); err != nil {
		logger.Error("database migration failed", "error", err)
		os.Exit(1)
	}
	if len(os.Args) == 2 && os.Args[1] == "migrate" {
		logger.Info("database migrations applied")
		return
	}

	pool, err := database.NewPool(startupCtx, cfg.DatabaseURL)
	if err != nil {
		logger.Error("database connection failed", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	passwordHasher, err := password.NewHasher(password.Params{
		MemoryKiB: cfg.Auth.ArgonMemoryKiB, Iterations: cfg.Auth.ArgonIterations, Parallelism: cfg.Auth.ArgonParallelism,
	})
	if err != nil {
		logger.Error("password configuration failed", "error", err)
		os.Exit(1)
	}
	accessManager, err := access.NewManager(cfg.Auth.SigningKey, cfg.Auth.AccessTokenTTL)
	if err != nil {
		logger.Error("access token configuration failed", "error", err)
		os.Exit(1)
	}
	workspaceService, err := workspace.NewService(workspace.NewRepository(pool), cfg.IntegrationEncryptionKey, nil)
	if err != nil {
		logger.Error("workspace service initialization failed", "error", err)
		os.Exit(1)
	}
	identityService, err := identity.NewService(
		identity.NewRepository(pool), passwordHasher, accessManager,
		cfg.Auth.RefreshTokenTTL, cfg.Auth.InvitationTTL, cfg.PublicAppURL, cfg.AppEnv == "development", workspaceService,
	)
	if err != nil {
		logger.Error("identity service initialization failed", "error", err)
		os.Exit(1)
	}
	if len(os.Args) > 1 && os.Args[1] == "admin" {
		if err := runAdminCommand(startupCtx, identityService, os.Args[2:]); err != nil {
			logger.Error("admin command failed", "error", err)
			os.Exit(1)
		}
		return
	}
	eventStore := eventlog.NewStore(pool)
	retentionWorker := eventlog.NewRetentionWorker(
		logger, eventStore, cfg.EventLog.Retention, cfg.EventLog.RetentionInterval,
		cfg.EventLog.RetentionMinCount, cfg.EventLog.RetentionBatch,
	)
	realtimeHub := realtime.NewHub(int(cfg.Realtime.MaxConnectionsPerActor), int(cfg.Realtime.MaxQueuedEvents), int(cfg.Realtime.MaxQueuedBytes))
	dispatcher := realtime.NewDispatcher(logger, eventStore, realtimeHub, cfg.EventLog.PollInterval, cfg.EventLog.WakeCoalesce)
	ephemeralService, err := realtime.NewEphemeral(logger, pool, realtimeHub, cfg.Realtime, cfg.Redis)
	if err != nil {
		logger.Error("ephemeral realtime initialization failed", "error", err)
		os.Exit(1)
	}
	defer ephemeralService.Close()
	realtimeServer := realtime.NewServer(logger, cfg.PublicAppURL, eventStore, realtimeHub, identityService.Authenticate, cfg.Realtime, ephemeralService)
	realtimeCtx, stopRealtime := context.WithCancel(context.Background())
	defer realtimeServer.Shutdown()
	go ephemeralService.Run(realtimeCtx)

	var redisCoordinator *coordination.Redis
	if cfg.Redis.Mode == "required" {
		redisCoordinator, err = coordination.NewRedis(logger, cfg.Redis)
		if err != nil {
			logger.Error("Redis coordinator initialization failed", "error", err)
			os.Exit(1)
		}
		defer redisCoordinator.Close()
		if err := redisCoordinator.Ping(startupCtx); err != nil {
			logger.Warn("Redis unavailable at startup; PostgreSQL polling fallback remains active", "error", err)
		}
		go redisCoordinator.Run(realtimeCtx, func(coordination.Wakeup) { dispatcher.WakeRedis() })
	} else {
		logger.Warn("Redis coordination disabled; only single-core realtime is supported")
	}
	defer stopRealtime()
	go dispatcher.Run(realtimeCtx)
	go retentionWorker.Run(realtimeCtx)
	afterCommit := func(orgID string, highWatermark int64) {
		dispatcher.WakeLocal()
		if redisCoordinator != nil {
			redisCoordinator.Notify(orgID, highWatermark)
		}
	}
	identityService.SetAfterCommit(afterCommit)
	go identityService.RunStatusExpiry(realtimeCtx, time.Minute)
	messageService := message.NewService(
		pool, int(cfg.Messaging.MaxBodyBytes), int(cfg.Messaging.MaxPageSize), afterCommit,
	)
	userStateService := userstate.NewService(pool, int(cfg.Messaging.MaxBodyBytes), afterCommit)
	pushService := push.NewService(pool, cfg.Push)
	pushWorker := push.NewWorker(logger, pool, cfg.Push, realtimeHub.ActorActiveIn)
	go pushWorker.Run(realtimeCtx)
	server := &http.Server{
		Addr: cfg.HTTPAddr,
		Handler: serverhttp.NewHandler(logger, cfg.PublicAppURL, pool.Ping, serverhttp.Dependencies{
			Identity: identityService, Chats: chat.NewService(pool, afterCommit),
			Messages: messageService, UserState: userStateService, Push: pushService, Workspace: workspaceService, Realtime: realtimeServer,
			CookieSecure: cfg.Auth.CookieSecure, RefreshTokenTTL: cfg.Auth.RefreshTokenTTL,
			BootstrapToken: cfg.BootstrapToken, RequireBootstrapToken: cfg.AppEnv != "development",
			TrustedProxyCIDRs: cfg.TrustedProxyCIDRs, RevokeRealtimeSession: realtimeServer.RevokeSession,
		}),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	shutdownSignals, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	serveErrors := make(chan error, 1)
	go func() {
		logger.Info("http server started", "address", cfg.HTTPAddr, "environment", cfg.AppEnv)
		serveErrors <- server.ListenAndServe()
	}()

	select {
	case serveErr := <-serveErrors:
		if !errors.Is(serveErr, http.ErrServerClosed) {
			logger.Error("http server failed", "error", serveErr)
			os.Exit(1)
		}
		return
	case <-shutdownSignals.Done():
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	realtimeServer.Shutdown()
	stopRealtime()
	if err := server.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
	logger.Info("realtime dispatcher stopped", "stats", dispatcher.Stats())
	logger.Info("event retention worker stopped", "stats", retentionWorker.Stats())
	if redisCoordinator != nil {
		logger.Info("Redis coordinator stopped", "stats", redisCoordinator.Stats())
	}
	logger.Info("http server stopped")
}

func runAdminCommand(ctx context.Context, service *identity.Service, args []string) error {
	if len(args) < 1 || args[0] != "issue-password-reset" {
		return fmt.Errorf("usage: comamessenger admin issue-password-reset --email user@example.com")
	}
	flags := flag.NewFlagSet("issue-password-reset", flag.ContinueOnError)
	email := flags.String("email", "", "account email")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if *email == "" || flags.NArg() != 0 {
		return fmt.Errorf("usage: comamessenger admin issue-password-reset --email user@example.com")
	}
	resetURL, err := service.IssueOperatorPasswordReset(ctx, *email)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(os.Stdout, resetURL)
	return err
}
