package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/database"
	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/knowledge"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/password"
	"github.com/comamessenger/comamessenger/core/internal/pilotseed"
	"github.com/comamessenger/comamessenger/core/internal/storage"
)

// runSeedPilot implements `comamessenger seed-pilot`: it fills an empty
// database with the fictional rehabilitation centre of the phase 5.3 pilot.
// A database that already has an organization is refused unless
// --allow-non-empty is given.
func runSeedPilot(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("seed-pilot", flag.ContinueOnError)
	allowNonEmpty := flags.Bool("allow-non-empty", false, "seed into the existing organization of a non-empty database")
	demoPassword := flags.String("password", os.Getenv("SEED_PILOT_PASSWORD"), "password of every demo account (or SEED_PILOT_PASSWORD), at least 12 characters")
	timezone := flags.String("timezone", "Europe/Moscow", "timezone of the demo people and the slot table")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(*demoPassword) < 12 {
		return fmt.Errorf("set --password or SEED_PILOT_PASSWORD to at least 12 characters")
	}
	cfg, err := config.FromEnvironment()
	if err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := database.Migrate(ctx, cfg.DatabaseURL); err != nil {
		return fmt.Errorf("database migration failed: %w", err)
	}
	pool, err := database.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	hasher, err := password.NewHasher(password.Params{MemoryKiB: cfg.Auth.ArgonMemoryKiB, Iterations: cfg.Auth.ArgonIterations, Parallelism: cfg.Auth.ArgonParallelism})
	if err != nil {
		return err
	}
	var blobStore storage.BlobStore
	if cfg.Storage.Driver == "local" {
		blobStore, err = storage.NewLocalBlobStore(cfg.Storage.LocalPath, cfg.Storage.MinimumFreeBytes)
	} else {
		blobStore, err = storage.NewS3BlobStore(ctx, storage.S3Options{
			Endpoint: cfg.S3.Endpoint, PublicEndpoint: cfg.S3.PublicEndpoint, Region: cfg.S3.Region,
			Bucket: cfg.S3.Bucket, AccessKey: cfg.S3.AccessKey, SecretKey: cfg.S3.SecretKey,
			Prefix: cfg.S3.Prefix, ForcePathStyle: cfg.S3.ForcePathStyle,
		})
	}
	if err != nil {
		return fmt.Errorf("blob storage: %w", err)
	}
	fileService, err := files.NewService(pool, blobStore, cfg.S3.Bucket, cfg.Storage.QuotaBytes, cfg.Storage.MaxFileBytes, cfg.Storage.MultipartThreshold, cfg.Storage.UploadTTL, cfg.Storage.PresignTTL)
	if err != nil {
		return err
	}
	knowledgeService := knowledge.NewService(pool, fileService, nil, nil)
	if _, err := knowledge.NewIndexingClient(pool, knowledgeService, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		return err
	}
	result, err := pilotseed.Seed(ctx, pilotseed.Deps{
		Pool: pool, Hasher: hasher, Files: fileService, Knowledge: knowledgeService,
		Chats: chat.NewService(pool), Messages: message.NewService(pool, int(cfg.Messaging.MaxBodyBytes), int(cfg.Messaging.MaxPageSize), nil), Agents: agent.NewService(pool),
	}, pilotseed.Options{AllowNonEmpty: *allowNonEmpty, Password: *demoPassword, Timezone: *timezone})
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Pilot demo centre created in organization %s.\nAccounts (password from --password):\n", result.OrgID)
	for _, person := range pilotseed.People {
		user := result.People[person.Key]
		fmt.Fprintf(stdout, "  %-16s %-8s %s\n", user.DisplayName, user.OrgRole, user.Email)
	}
	fmt.Fprintf(stdout, "Six pilot agents are drafts: choose a model connection, approve external data sharing and publish them in Agents.\n")
	return nil
}
