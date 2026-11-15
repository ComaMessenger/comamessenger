// Command mail-relay sends Coma letters for self-hosted installations
// through RuSender (docs/decisions/0013-mail-relay.md).
//
//	mail-relay                       serve the API
//	mail-relay installations         list installations
//	mail-relay revoke <id> <reason>  stop an installation and block its host
//	mail-relay restore <id>          re-enable an installation
//	mail-relay set-limit <id> <n|default>
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/mailrelay"
	"github.com/comamessenger/comamessenger/core/internal/relay"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger, os.Args[1:]); err != nil {
		logger.Error("mail relay stopped", "error", err)
		os.Exit(1)
	}
}

// secret reads NAME or NAME_FILE; values are never logged.
func secret(name string) (string, error) {
	if path := os.Getenv(name + "_FILE"); path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("read %s_FILE: %w", name, err)
		}
		return strings.TrimSpace(string(raw)), nil
	}
	return strings.TrimSpace(os.Getenv(name)), nil
}

func run(logger *slog.Logger, args []string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	databaseURL := os.Getenv("MAIL_RELAY_DATABASE_URL")
	if databaseURL == "" {
		return errors.New("MAIL_RELAY_DATABASE_URL is required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	store := mailrelay.NewStore(pool)
	if err := store.EnsureSchema(ctx); err != nil {
		return err
	}
	if len(args) > 0 {
		return command(ctx, store, args)
	}
	return serve(ctx, logger, store)
}

func serve(ctx context.Context, logger *slog.Logger, store *mailrelay.Store) error {
	token, err := secret("RUSENDER_API_KEY")
	if err != nil {
		return err
	}
	if !strings.HasPrefix(token, "rs_") {
		return errors.New("RUSENDER_API_KEY (or RUSENDER_API_KEY_FILE) must hold a RuSender API token")
	}
	var keyID int64
	if raw := strings.TrimSpace(os.Getenv("RUSENDER_KEY_ID")); raw != "" {
		keyID, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || keyID <= 0 {
			return errors.New("RUSENDER_KEY_ID must be the numeric id of a RuSender sending key")
		}
	}
	hashSecret, err := secret("MAIL_RELAY_HASH_SECRET")
	if err != nil {
		return err
	}
	if len(hashSecret) < 32 {
		return errors.New("MAIL_RELAY_HASH_SECRET must hold at least 32 characters")
	}
	webhookSecret, err := secret("MAIL_RELAY_WEBHOOK_SECRET")
	if err != nil {
		return err
	}
	if webhookSecret != "" && len(webhookSecret) < 24 {
		return errors.New("MAIL_RELAY_WEBHOOK_SECRET must hold at least 24 characters")
	}
	from := strings.TrimSpace(os.Getenv("MAIL_RELAY_FROM_ADDRESS"))
	if from == "" {
		from = "no-reply@coma-chat.com"
	}
	insecure := os.Getenv("MAIL_RELAY_ALLOW_INSECURE_ORIGINS") == "true"
	if insecure {
		logger.Warn("MAIL_RELAY_ALLOW_INSECURE_ORIGINS is on: http and private installation addresses are accepted; never use this in production")
	}
	address := os.Getenv("MAIL_RELAY_LISTEN")
	if address == "" {
		address = ":8091"
	}
	trusted, err := relay.ParseTrustedProxies(os.Getenv("MAIL_RELAY_TRUSTED_PROXY_CIDRS"))
	if err != nil {
		return errors.New("MAIL_RELAY_TRUSTED_PROXY_CIDRS must be a comma-separated list of CIDR prefixes")
	}
	provider := mailrelay.NewRuSender(&http.Client{Timeout: 20 * time.Second}, os.Getenv("RUSENDER_API_URL"), token, keyID)
	api := mailrelay.NewServer(logger, mailrelay.Options{
		Store: store, Provider: provider, Verifier: mailrelay.HTTPVerifier{Insecure: insecure},
		Limits: mailrelay.DefaultLimits(), HashSecret: []byte(hashSecret), WebhookSecret: webhookSecret,
		FromAddress: from, AllowInsecureOrigins: insecure,
	})
	api.TrustProxies(trusted)
	server := &http.Server{
		Addr:              address,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      40 * time.Second,
	}
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			if err := store.Cleanup(ctx); err != nil && ctx.Err() == nil {
				logger.Error("cleanup", "error", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	logger.Info("mail relay listening", "address", address, "from", from, "webhooks", webhookSecret != "", "key_id_set", keyID != 0)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func command(ctx context.Context, store *mailrelay.Store, args []string) error {
	switch args[0] {
	case "installations":
		items, err := store.ListInstallations(ctx)
		if err != nil {
			return err
		}
		writer := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(writer, "ID\tHOST\tSTATUS\tREASON\tLIMIT\tSENT_24H\tBOUNCES_7D\tCOMPLAINTS_7D\tCREATED")
		for _, item := range items {
			limit := "default"
			if item.DailyLimit != nil {
				limit = strconv.Itoa(*item.DailyLimit)
			}
			fmt.Fprintf(writer, "%s\t%s\t%s\t%s\t%s\t%d\t%d\t%d\t%s\n", item.ID, item.AppHost, item.Status, item.Reason, limit, item.Sent24h, item.Bounces7d, item.Complaints7d, item.CreatedAt.UTC().Format(time.RFC3339))
		}
		return writer.Flush()
	case "revoke":
		if len(args) < 3 {
			return errors.New("usage: mail-relay revoke <installation-id> <reason>")
		}
		return store.SetStatus(ctx, args[1], "revoked", strings.Join(args[2:], " "))
	case "restore":
		if len(args) != 2 {
			return errors.New("usage: mail-relay restore <installation-id>")
		}
		return store.SetStatus(ctx, args[1], "active", "")
	case "set-limit":
		if len(args) != 3 {
			return errors.New("usage: mail-relay set-limit <installation-id> <letters per day|default>")
		}
		if args[2] == "default" {
			return store.SetLimit(ctx, args[1], nil)
		}
		limit, err := strconv.Atoi(args[2])
		if err != nil || limit < 0 || limit > 100000 {
			return errors.New("limit must be a number from 0 to 100000 or default")
		}
		return store.SetLimit(ctx, args[1], &limit)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}
