// Command push-relay forwards encrypted notifications from self-hosted Coma
// instances to APNs and FCM (docs/decisions/0012-mobile-push-relay.md).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/relay"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("push relay stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	databaseURL := os.Getenv("RELAY_DATABASE_URL")
	if databaseURL == "" {
		return errors.New("RELAY_DATABASE_URL is required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	store := relay.NewStore(pool)
	if err := store.EnsureSchema(ctx); err != nil {
		return err
	}
	senders, err := sendersFromEnvironment()
	if err != nil {
		return err
	}
	if len(senders) == 0 {
		return errors.New("configure APNs (APNS_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC) and/or FCM (FCM_CREDENTIALS_FILE)")
	}
	address := os.Getenv("RELAY_LISTEN")
	if address == "" {
		address = ":8090"
	}
	server := &http.Server{
		Addr:              address,
		Handler:           relay.NewServer(logger, store, senders).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      20 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	platforms := []string{}
	for platform := range senders {
		platforms = append(platforms, platform)
	}
	logger.Info("push relay listening", "address", address, "platforms", platforms)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func sendersFromEnvironment() (map[string]relay.Sender, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	senders := map[string]relay.Sender{}
	if path := os.Getenv("APNS_KEY_FILE"); path != "" {
		pemBytes, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		key, err := relay.ParseAPNsKey(pemBytes)
		if err != nil {
			return nil, err
		}
		keyID, teamID, topic := os.Getenv("APNS_KEY_ID"), os.Getenv("APNS_TEAM_ID"), os.Getenv("APNS_TOPIC")
		if keyID == "" || teamID == "" || topic == "" {
			return nil, errors.New("APNS_KEY_ID, APNS_TEAM_ID and APNS_TOPIC are required with APNS_KEY_FILE")
		}
		endpoint := relay.APNsProduction
		if os.Getenv("APNS_SANDBOX") == "true" {
			endpoint = relay.APNsSandbox
		}
		senders["ios"] = relay.NewAPNs(client, endpoint, keyID, teamID, topic, key)
	}
	if path := os.Getenv("FCM_CREDENTIALS_FILE"); path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var account relay.ServiceAccount
		if err := json.Unmarshal(raw, &account); err != nil {
			return nil, err
		}
		fcm, err := relay.NewFCM(client, relay.FCMEndpoint, account)
		if err != nil {
			return nil, err
		}
		senders["android"] = fcm
	}
	return senders, nil
}
