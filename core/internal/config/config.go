package config

import (
	"fmt"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

type S3Config struct {
	Endpoint       string
	PublicEndpoint string
	Region         string
	Bucket         string
	AccessKey      string
	SecretKey      string
	Prefix         string
	ForcePathStyle bool
}

type StorageConfig struct {
	Driver             string
	LocalPath          string
	QuotaBytes         uint64
	MinimumFreeBytes   uint64
	MaxFileBytes       uint64
	MultipartThreshold uint64
	UploadTTL          time.Duration
	PresignTTL         time.Duration
}

type AuthConfig struct {
	SigningKey       string
	AccessTokenTTL   time.Duration
	RefreshTokenTTL  time.Duration
	InvitationTTL    time.Duration
	CookieSecure     bool
	ArgonMemoryKiB   uint32
	ArgonIterations  uint32
	ArgonParallelism uint8
}

type MessagingConfig struct {
	MaxBodyBytes uint64
	MaxPageSize  uint64
}

type RealtimeConfig struct {
	AuthTimeout            time.Duration
	MaxFrameBytes          uint64
	MaxConnectionsPerActor uint64
	MaxPendingConnections  uint64
	MaxConcurrentWrites    uint64
	MaxQueuedEvents        uint64
	MaxQueuedBytes         uint64
	MaxUnackedEvents       uint64
	HeartbeatInterval      time.Duration
	PongTimeout            time.Duration
	AckInterval            time.Duration
	AckTimeout             time.Duration
	AckBatchSize           uint64
	TypingTTL              time.Duration
	PresenceTTL            time.Duration
	ActiveSubscriptionTTL  time.Duration
	EphemeralRateLimit     uint64
	EphemeralRateWindow    time.Duration
}

type EventLogConfig struct {
	PollInterval      time.Duration
	WakeCoalesce      time.Duration
	Retention         time.Duration
	RetentionMinCount uint64
	RetentionInterval time.Duration
	RetentionBatch    uint64
}

type RedisConfig struct {
	Mode                string
	URL                 string
	Namespace           string
	EphemeralSigningKey string
	ConnectTimeout      time.Duration
	OperationTimeout    time.Duration
}

type PushConfig struct {
	VAPIDPublicKey  string
	VAPIDPrivateKey string
	VAPIDSubject    string
	PollInterval    time.Duration
}

type AgentConfig struct {
	TriggerShardIndex uint64
	TriggerShardCount uint64
}

type Config struct {
	AppEnv                   string
	HTTPAddr                 string
	DatabaseURL              string
	PublicAppURL             string
	BootstrapToken           string
	IntegrationEncryptionKey string
	TrustedProxyCIDRs        []netip.Prefix
	Storage                  StorageConfig
	S3                       S3Config
	Auth                     AuthConfig
	Messaging                MessagingConfig
	Realtime                 RealtimeConfig
	EventLog                 EventLogConfig
	Redis                    RedisConfig
	Push                     PushConfig
	Agents                   AgentConfig
}

func FromEnvironment() (Config, error) {
	appEnv := valueOrDefault("APP_ENV", "development")
	signingKey := strings.TrimSpace(os.Getenv("AUTH_SIGNING_KEY"))
	integrationEncryptionKey := strings.TrimSpace(os.Getenv("INTEGRATION_ENCRYPTION_KEY"))
	if integrationEncryptionKey == "" {
		integrationEncryptionKey = signingKey
	}
	forcePathStyle, err := boolValueOrDefault("S3_FORCE_PATH_STYLE", false)
	if err != nil {
		return Config{}, err
	}
	cookieSecure, err := boolValueOrDefault("AUTH_COOKIE_SECURE", appEnv != "development")
	if err != nil {
		return Config{}, err
	}
	accessTTL, err := durationValueOrDefault("ACCESS_TOKEN_TTL", 15*time.Minute)
	if err != nil {
		return Config{}, err
	}
	refreshTTL, err := durationValueOrDefault("REFRESH_TOKEN_TTL", 30*24*time.Hour)
	if err != nil {
		return Config{}, err
	}
	invitationTTL, err := durationValueOrDefault("INVITATION_TTL", 7*24*time.Hour)
	if err != nil {
		return Config{}, err
	}
	argonMemory, err := uintValueOrDefault("ARGON2_MEMORY_KIB", 64*1024, 32)
	if err != nil {
		return Config{}, err
	}
	argonIterations, err := uintValueOrDefault("ARGON2_ITERATIONS", 3, 32)
	if err != nil {
		return Config{}, err
	}
	argonParallelism, err := uintValueOrDefault("ARGON2_PARALLELISM", 2, 8)
	if err != nil {
		return Config{}, err
	}
	messaging, err := messagingConfigFromEnvironment()
	if err != nil {
		return Config{}, err
	}
	realtime, err := realtimeConfigFromEnvironment()
	if err != nil {
		return Config{}, err
	}
	if err := realtime.validate(messaging.MaxBodyBytes); err != nil {
		return Config{}, err
	}
	eventLog, err := eventLogConfigFromEnvironment()
	if err != nil {
		return Config{}, err
	}
	redisConfig, err := redisConfigFromEnvironment()
	if err != nil {
		return Config{}, err
	}
	pushInterval, err := durationValueOrDefault("PUSH_POLL_INTERVAL", time.Second)
	if err != nil {
		return Config{}, err
	}
	trustedProxyCIDRs, err := prefixListValue("TRUSTED_PROXY_CIDRS", "127.0.0.1/32,::1/128")
	if err != nil {
		return Config{}, err
	}
	storageConfig, err := storageConfigFromEnvironment()
	if err != nil {
		return Config{}, err
	}
	triggerShardIndex, err := uintValueOrDefault("AGENT_TRIGGER_SHARD_INDEX", 0, 32)
	if err != nil {
		return Config{}, err
	}
	triggerShardCount, err := uintValueOrDefault("AGENT_TRIGGER_SHARD_COUNT", 1, 32)
	if err != nil {
		return Config{}, err
	}
	if triggerShardCount < 1 || triggerShardCount > 1024 || triggerShardIndex >= triggerShardCount {
		return Config{}, fmt.Errorf("AGENT_TRIGGER_SHARD_INDEX must be below AGENT_TRIGGER_SHARD_COUNT (1-1024)")
	}

	cfg := Config{
		AppEnv:                   appEnv,
		HTTPAddr:                 valueOrDefault("HTTP_ADDR", ":8080"),
		DatabaseURL:              strings.TrimSpace(os.Getenv("DATABASE_URL")),
		PublicAppURL:             valueOrDefault("PUBLIC_APP_URL", "http://localhost:5173"),
		BootstrapToken:           strings.TrimSpace(os.Getenv("BOOTSTRAP_TOKEN")),
		IntegrationEncryptionKey: integrationEncryptionKey,
		TrustedProxyCIDRs:        trustedProxyCIDRs,
		Storage:                  storageConfig,
		S3: S3Config{
			Endpoint:       strings.TrimSpace(os.Getenv("S3_ENDPOINT")),
			PublicEndpoint: strings.TrimSpace(os.Getenv("S3_PUBLIC_ENDPOINT")),
			Region:         valueOrDefault("S3_REGION", "us-east-1"),
			Bucket:         strings.TrimSpace(os.Getenv("S3_BUCKET")),
			AccessKey:      strings.TrimSpace(os.Getenv("S3_ACCESS_KEY")),
			SecretKey:      strings.TrimSpace(os.Getenv("S3_SECRET_KEY")),
			Prefix:         strings.Trim(strings.TrimSpace(os.Getenv("S3_PREFIX")), "/"),
			ForcePathStyle: forcePathStyle,
		},
		Auth: AuthConfig{
			SigningKey:       signingKey,
			AccessTokenTTL:   accessTTL,
			RefreshTokenTTL:  refreshTTL,
			InvitationTTL:    invitationTTL,
			CookieSecure:     cookieSecure,
			ArgonMemoryKiB:   uint32(argonMemory),
			ArgonIterations:  uint32(argonIterations),
			ArgonParallelism: uint8(argonParallelism),
		},
		Messaging: messaging,
		Realtime:  realtime,
		EventLog:  eventLog,
		Redis:     redisConfig,
		Push:      PushConfig{VAPIDPublicKey: strings.TrimSpace(os.Getenv("VAPID_PUBLIC_KEY")), VAPIDPrivateKey: strings.TrimSpace(os.Getenv("VAPID_PRIVATE_KEY")), VAPIDSubject: valueOrDefault("VAPID_SUBJECT", "mailto:admin@localhost"), PollInterval: pushInterval},
		Agents:    AgentConfig{TriggerShardIndex: triggerShardIndex, TriggerShardCount: triggerShardCount},
	}

	if cfg.HTTPAddr == "" {
		return Config{}, fmt.Errorf("HTTP_ADDR must not be empty")
	}
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL must not be empty")
	}
	if cfg.PublicAppURL == "" {
		return Config{}, fmt.Errorf("PUBLIC_APP_URL must not be empty")
	}
	if (cfg.S3.AccessKey == "") != (cfg.S3.SecretKey == "") {
		return Config{}, fmt.Errorf("S3_ACCESS_KEY and S3_SECRET_KEY must be set together")
	}
	if cfg.Storage.Driver == "s3" && cfg.S3.Bucket == "" {
		return Config{}, fmt.Errorf("S3_BUCKET must not be empty when STORAGE_DRIVER=s3")
	}
	if len(cfg.Auth.SigningKey) < 32 {
		return Config{}, fmt.Errorf("AUTH_SIGNING_KEY must be at least 32 bytes")
	}
	if len(cfg.IntegrationEncryptionKey) < 32 {
		return Config{}, fmt.Errorf("INTEGRATION_ENCRYPTION_KEY must be at least 32 bytes")
	}
	if cfg.Auth.AccessTokenTTL < time.Minute || cfg.Auth.AccessTokenTTL > time.Hour {
		return Config{}, fmt.Errorf("ACCESS_TOKEN_TTL must be between 1m and 1h")
	}
	if cfg.Auth.RefreshTokenTTL < time.Hour || cfg.Auth.RefreshTokenTTL > 180*24*time.Hour {
		return Config{}, fmt.Errorf("REFRESH_TOKEN_TTL must be between 1h and 4320h")
	}
	if cfg.Auth.InvitationTTL < time.Hour || cfg.Auth.InvitationTTL > 30*24*time.Hour {
		return Config{}, fmt.Errorf("INVITATION_TTL must be between 1h and 720h")
	}
	if cfg.BootstrapToken != "" && len(cfg.BootstrapToken) < 32 {
		return Config{}, fmt.Errorf("BOOTSTRAP_TOKEN must be at least 32 bytes when set")
	}
	if (cfg.Push.VAPIDPublicKey == "") != (cfg.Push.VAPIDPrivateKey == "") {
		return Config{}, fmt.Errorf("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together")
	}
	if cfg.Push.PollInterval < 100*time.Millisecond || cfg.Push.PollInterval > time.Minute {
		return Config{}, fmt.Errorf("PUSH_POLL_INTERVAL must be between 100ms and 1m")
	}
	if cfg.AppEnv != "development" {
		if len(cfg.BootstrapToken) < 32 {
			return Config{}, fmt.Errorf("BOOTSTRAP_TOKEN must be set to at least 32 bytes outside development")
		}
		if cfg.Auth.SigningKey == "comamessenger-local-signing-key-change-me" {
			return Config{}, fmt.Errorf("AUTH_SIGNING_KEY must not use the development default outside development")
		}
		if cfg.IntegrationEncryptionKey == "comamessenger-local-integration-key-change-me" {
			return Config{}, fmt.Errorf("INTEGRATION_ENCRYPTION_KEY must not use the development default outside development")
		}
		if cfg.S3.AccessKey == "comamessenger" && cfg.S3.SecretKey == "comamessenger-local-secret" {
			return Config{}, fmt.Errorf("S3 credentials must not use the development defaults outside development")
		}
		if strings.Contains(cfg.DatabaseURL, "comamessenger:comamessenger@") {
			return Config{}, fmt.Errorf("DATABASE_URL must not use the development password outside development")
		}
		if cfg.Redis.Mode == "required" && strings.Contains(cfg.Redis.URL, "comamessenger-local-redis-secret") {
			return Config{}, fmt.Errorf("REDIS_URL must not use the development password outside development")
		}
		if cfg.Redis.Mode == "required" && cfg.Redis.EphemeralSigningKey == "comamessenger-local-ephemeral-signing-key" {
			return Config{}, fmt.Errorf("REDIS_EPHEMERAL_SIGNING_KEY must not use the development default outside development")
		}
	}
	return cfg, nil
}

func storageConfigFromEnvironment() (StorageConfig, error) {
	driver := strings.ToLower(valueOrDefault("STORAGE_DRIVER", "local"))
	if driver != "local" && driver != "s3" {
		return StorageConfig{}, fmt.Errorf("STORAGE_DRIVER must be local or s3")
	}
	quota, err := uintValueOrDefault("LOCAL_STORAGE_QUOTA_BYTES", 2*1024*1024*1024, 64)
	if err != nil {
		return StorageConfig{}, err
	}
	minimumFree, err := uintValueOrDefault("LOCAL_STORAGE_MIN_FREE_BYTES", 256*1024*1024, 64)
	if err != nil {
		return StorageConfig{}, err
	}
	maxFile, err := uintValueOrDefault("FILE_MAX_BYTES", 100*1024*1024, 64)
	if err != nil {
		return StorageConfig{}, err
	}
	multipartThreshold, err := uintValueOrDefault("FILE_MULTIPART_THRESHOLD_BYTES", 16*1024*1024, 64)
	if err != nil {
		return StorageConfig{}, err
	}
	uploadTTL, err := durationValueOrDefault("FILE_UPLOAD_TTL", 24*time.Hour)
	if err != nil {
		return StorageConfig{}, err
	}
	presignTTL, err := durationValueOrDefault("FILE_PRESIGN_TTL", 15*time.Minute)
	if err != nil {
		return StorageConfig{}, err
	}
	if quota == 0 {
		return StorageConfig{}, fmt.Errorf("LOCAL_STORAGE_QUOTA_BYTES must be positive")
	}
	if maxFile == 0 || maxFile > quota {
		return StorageConfig{}, fmt.Errorf("FILE_MAX_BYTES must be positive and not exceed LOCAL_STORAGE_QUOTA_BYTES")
	}
	if multipartThreshold < 5*1024*1024 || multipartThreshold > maxFile {
		return StorageConfig{}, fmt.Errorf("FILE_MULTIPART_THRESHOLD_BYTES must be between 5 MiB and FILE_MAX_BYTES")
	}
	if uploadTTL < time.Hour || uploadTTL > 7*24*time.Hour {
		return StorageConfig{}, fmt.Errorf("FILE_UPLOAD_TTL must be between 1h and 168h")
	}
	if presignTTL < time.Minute || presignTTL > time.Hour {
		return StorageConfig{}, fmt.Errorf("FILE_PRESIGN_TTL must be between 1m and 1h")
	}
	return StorageConfig{
		Driver: driver, LocalPath: valueOrDefault("LOCAL_STORAGE_PATH", "/var/lib/coma/files"),
		QuotaBytes: quota, MinimumFreeBytes: minimumFree, MaxFileBytes: maxFile,
		MultipartThreshold: multipartThreshold, UploadTTL: uploadTTL, PresignTTL: presignTTL,
	}, nil
}

func prefixListValue(name, fallback string) ([]netip.Prefix, error) {
	raw := valueOrDefault(name, fallback)
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	parts := strings.Split(raw, ",")
	result := make([]netip.Prefix, 0, len(parts))
	for _, part := range parts {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(part))
		if err != nil {
			return nil, fmt.Errorf("%s must contain valid comma-separated CIDRs", name)
		}
		result = append(result, prefix.Masked())
	}
	return result, nil
}

func redisConfigFromEnvironment() (RedisConfig, error) {
	mode := strings.ToLower(valueOrDefault("REDIS_MODE", "disabled"))
	if mode != "required" && mode != "disabled" {
		return RedisConfig{}, fmt.Errorf("REDIS_MODE must be required or disabled")
	}
	redisURL := strings.TrimSpace(os.Getenv("REDIS_URL"))
	signingKey := strings.TrimSpace(os.Getenv("REDIS_EPHEMERAL_SIGNING_KEY"))
	if mode == "required" && redisURL == "" {
		return RedisConfig{}, fmt.Errorf("REDIS_URL must be set when REDIS_MODE=required")
	}
	if mode == "disabled" && redisURL != "" {
		return RedisConfig{}, fmt.Errorf("REDIS_URL must be empty when REDIS_MODE=disabled")
	}
	if mode == "required" && len(signingKey) < 32 {
		return RedisConfig{}, fmt.Errorf("REDIS_EPHEMERAL_SIGNING_KEY must be at least 32 bytes when REDIS_MODE=required")
	}
	if mode == "disabled" && signingKey != "" {
		return RedisConfig{}, fmt.Errorf("REDIS_EPHEMERAL_SIGNING_KEY must be empty when REDIS_MODE=disabled")
	}
	connectTimeout, err := durationValueOrDefault("REDIS_CONNECT_TIMEOUT", time.Second)
	if err != nil {
		return RedisConfig{}, err
	}
	operationTimeout, err := durationValueOrDefault("REDIS_OPERATION_TIMEOUT", 500*time.Millisecond)
	if err != nil {
		return RedisConfig{}, err
	}
	if connectTimeout < 100*time.Millisecond || connectTimeout > 10*time.Second {
		return RedisConfig{}, fmt.Errorf("REDIS_CONNECT_TIMEOUT must be between 100ms and 10s")
	}
	if operationTimeout < 50*time.Millisecond || operationTimeout > 5*time.Second {
		return RedisConfig{}, fmt.Errorf("REDIS_OPERATION_TIMEOUT must be between 50ms and 5s")
	}
	namespace := strings.Trim(strings.TrimSpace(valueOrDefault("REDIS_NAMESPACE", "coma:v1")), ":")
	if namespace == "" || strings.ContainsAny(namespace, " \t\r\n") {
		return RedisConfig{}, fmt.Errorf("REDIS_NAMESPACE must not be empty or contain whitespace")
	}
	return RedisConfig{
		Mode: mode, URL: redisURL, Namespace: namespace, EphemeralSigningKey: signingKey,
		ConnectTimeout: connectTimeout, OperationTimeout: operationTimeout,
	}, nil
}

func messagingConfigFromEnvironment() (MessagingConfig, error) {
	maxBodyBytes, err := uintValueOrDefault("MESSAGE_MAX_BODY_BYTES", 64*1024, 64)
	if err != nil {
		return MessagingConfig{}, err
	}
	maxPageSize, err := uintValueOrDefault("MESSAGE_MAX_PAGE_SIZE", 100, 16)
	if err != nil {
		return MessagingConfig{}, err
	}
	if maxBodyBytes < 1024 || maxBodyBytes > 1024*1024 {
		return MessagingConfig{}, fmt.Errorf("MESSAGE_MAX_BODY_BYTES must be between 1024 and 1048576")
	}
	if maxPageSize < 1 || maxPageSize > 500 {
		return MessagingConfig{}, fmt.Errorf("MESSAGE_MAX_PAGE_SIZE must be between 1 and 500")
	}
	return MessagingConfig{MaxBodyBytes: maxBodyBytes, MaxPageSize: maxPageSize}, nil
}

func realtimeConfigFromEnvironment() (RealtimeConfig, error) {
	cfg := RealtimeConfig{}
	var err error
	if cfg.AuthTimeout, err = durationValueOrDefault("WS_AUTH_TIMEOUT", 5*time.Second); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.MaxFrameBytes, err = uintValueOrDefault("WS_MAX_FRAME_BYTES", 256*1024, 64); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.MaxConnectionsPerActor, err = uintValueOrDefault("WS_MAX_CONNECTIONS_PER_ACTOR", 10, 16); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.MaxPendingConnections, err = uintValueOrDefault("WS_MAX_PENDING_CONNECTIONS", 256, 32); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.MaxConcurrentWrites, err = uintValueOrDefault("WS_MAX_CONCURRENT_WRITES", 8, 32); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.MaxQueuedEvents, err = uintValueOrDefault("WS_MAX_QUEUED_EVENTS", 256, 32); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.MaxQueuedBytes, err = uintValueOrDefault("WS_MAX_QUEUED_BYTES", 1024*1024, 64); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.MaxUnackedEvents, err = uintValueOrDefault("WS_MAX_UNACKED_EVENTS", 128, 32); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.HeartbeatInterval, err = durationValueOrDefault("WS_HEARTBEAT_INTERVAL", 25*time.Second); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.PongTimeout, err = durationValueOrDefault("WS_PONG_TIMEOUT", 10*time.Second); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.AckInterval, err = durationValueOrDefault("WS_ACK_INTERVAL", time.Second); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.AckTimeout, err = durationValueOrDefault("WS_ACK_TIMEOUT", 30*time.Second); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.AckBatchSize, err = uintValueOrDefault("WS_ACK_BATCH_SIZE", 50, 16); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.TypingTTL, err = durationValueOrDefault("WS_TYPING_TTL", 6*time.Second); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.PresenceTTL, err = durationValueOrDefault("WS_PRESENCE_TTL", 60*time.Second); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.ActiveSubscriptionTTL, err = durationValueOrDefault("WS_ACTIVE_SUBSCRIPTION_TTL", 60*time.Second); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.EphemeralRateLimit, err = uintValueOrDefault("WS_EPHEMERAL_RATE_LIMIT", 30, 16); err != nil {
		return RealtimeConfig{}, err
	}
	if cfg.EphemeralRateWindow, err = durationValueOrDefault("WS_EPHEMERAL_RATE_WINDOW", 10*time.Second); err != nil {
		return RealtimeConfig{}, err
	}
	return cfg, nil
}

func eventLogConfigFromEnvironment() (EventLogConfig, error) {
	pollInterval, err := durationValueOrDefault("EVENT_POLL_INTERVAL", 200*time.Millisecond)
	if err != nil {
		return EventLogConfig{}, err
	}
	wakeCoalesce, err := durationValueOrDefault("EVENT_WAKE_COALESCE", 5*time.Millisecond)
	if err != nil {
		return EventLogConfig{}, err
	}
	retention, err := durationValueOrDefault("EVENT_RETENTION", 72*time.Hour)
	if err != nil {
		return EventLogConfig{}, err
	}
	retentionMinCount, err := uintValueOrDefault("EVENT_RETENTION_MIN_COUNT", 100_000, 64)
	if err != nil {
		return EventLogConfig{}, err
	}
	retentionInterval, err := durationValueOrDefault("EVENT_RETENTION_INTERVAL", 5*time.Minute)
	if err != nil {
		return EventLogConfig{}, err
	}
	retentionBatch, err := uintValueOrDefault("EVENT_RETENTION_BATCH_SIZE", 10_000, 64)
	if err != nil {
		return EventLogConfig{}, err
	}
	if pollInterval < 10*time.Millisecond || pollInterval > 5*time.Second {
		return EventLogConfig{}, fmt.Errorf("EVENT_POLL_INTERVAL must be between 10ms and 5s")
	}
	if wakeCoalesce < time.Millisecond || wakeCoalesce > 100*time.Millisecond {
		return EventLogConfig{}, fmt.Errorf("EVENT_WAKE_COALESCE must be between 1ms and 100ms")
	}
	if retention < time.Hour || retention > 30*24*time.Hour {
		return EventLogConfig{}, fmt.Errorf("EVENT_RETENTION must be between 1h and 720h")
	}
	if retentionMinCount < 1000 || retentionMinCount > 10_000_000 {
		return EventLogConfig{}, fmt.Errorf("EVENT_RETENTION_MIN_COUNT must be between 1000 and 10000000")
	}
	if retentionInterval < 10*time.Second || retentionInterval > 24*time.Hour {
		return EventLogConfig{}, fmt.Errorf("EVENT_RETENTION_INTERVAL must be between 10s and 24h")
	}
	if retentionBatch < 100 || retentionBatch > 100_000 {
		return EventLogConfig{}, fmt.Errorf("EVENT_RETENTION_BATCH_SIZE must be between 100 and 100000")
	}
	return EventLogConfig{
		PollInterval: pollInterval, WakeCoalesce: wakeCoalesce,
		Retention: retention, RetentionMinCount: retentionMinCount,
		RetentionInterval: retentionInterval, RetentionBatch: retentionBatch,
	}, nil
}

func (c RealtimeConfig) validate(messageMaxBodyBytes uint64) error {
	if c.AuthTimeout < time.Second || c.AuthTimeout > 30*time.Second {
		return fmt.Errorf("WS_AUTH_TIMEOUT must be between 1s and 30s")
	}
	if c.MaxFrameBytes < messageMaxBodyBytes*2+4096 || c.MaxFrameBytes > 16*1024*1024 {
		return fmt.Errorf("WS_MAX_FRAME_BYTES must allow MESSAGE_MAX_BODY_BYTES plus JSON envelope and be at most 16777216")
	}
	if c.MaxConnectionsPerActor < 1 || c.MaxConnectionsPerActor > 100 {
		return fmt.Errorf("WS_MAX_CONNECTIONS_PER_ACTOR must be between 1 and 100")
	}
	if c.MaxPendingConnections < 1 || c.MaxPendingConnections > 10000 {
		return fmt.Errorf("WS_MAX_PENDING_CONNECTIONS must be between 1 and 10000")
	}
	if c.MaxConcurrentWrites < 1 || c.MaxConcurrentWrites > 4096 {
		return fmt.Errorf("WS_MAX_CONCURRENT_WRITES must be between 1 and 4096")
	}
	if c.MaxUnackedEvents < 1 || c.MaxUnackedEvents > c.MaxQueuedEvents {
		return fmt.Errorf("WS_MAX_UNACKED_EVENTS must be between 1 and WS_MAX_QUEUED_EVENTS")
	}
	if c.MaxQueuedEvents > 4096 {
		return fmt.Errorf("WS_MAX_QUEUED_EVENTS must be at most 4096")
	}
	if c.MaxQueuedBytes < c.MaxFrameBytes || c.MaxQueuedBytes > 64*1024*1024 {
		return fmt.Errorf("WS_MAX_QUEUED_BYTES must be at least WS_MAX_FRAME_BYTES and at most 67108864")
	}
	if c.HeartbeatInterval < 5*time.Second || c.HeartbeatInterval > 5*time.Minute {
		return fmt.Errorf("WS_HEARTBEAT_INTERVAL must be between 5s and 5m")
	}
	if c.PongTimeout < time.Second || c.PongTimeout >= c.HeartbeatInterval {
		return fmt.Errorf("WS_PONG_TIMEOUT must be at least 1s and shorter than WS_HEARTBEAT_INTERVAL")
	}
	if c.AckInterval < 100*time.Millisecond || c.AckInterval > 10*time.Second {
		return fmt.Errorf("WS_ACK_INTERVAL must be between 100ms and 10s")
	}
	if c.AckTimeout <= c.AckInterval || c.AckTimeout > 5*time.Minute {
		return fmt.Errorf("WS_ACK_TIMEOUT must be longer than WS_ACK_INTERVAL and at most 5m")
	}
	if c.AckBatchSize < 1 || c.AckBatchSize > c.MaxUnackedEvents {
		return fmt.Errorf("WS_ACK_BATCH_SIZE must be between 1 and WS_MAX_UNACKED_EVENTS")
	}
	if c.TypingTTL < time.Second || c.TypingTTL > 30*time.Second {
		return fmt.Errorf("WS_TYPING_TTL must be between 1s and 30s")
	}
	if c.PresenceTTL < 10*time.Second || c.PresenceTTL > 5*time.Minute {
		return fmt.Errorf("WS_PRESENCE_TTL must be between 10s and 5m")
	}
	if c.ActiveSubscriptionTTL < 10*time.Second || c.ActiveSubscriptionTTL > 5*time.Minute {
		return fmt.Errorf("WS_ACTIVE_SUBSCRIPTION_TTL must be between 10s and 5m")
	}
	if c.EphemeralRateLimit < 1 || c.EphemeralRateLimit > 1000 {
		return fmt.Errorf("WS_EPHEMERAL_RATE_LIMIT must be between 1 and 1000")
	}
	if c.EphemeralRateWindow < time.Second || c.EphemeralRateWindow > time.Minute {
		return fmt.Errorf("WS_EPHEMERAL_RATE_WINDOW must be between 1s and 1m")
	}
	return nil
}

func valueOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func boolValueOrDefault(key string, fallback bool) (bool, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return parsed, nil
}

func durationValueOrDefault(key string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be a duration", key)
	}
	return parsed, nil
}

func uintValueOrDefault(key string, fallback uint64, bitSize int) (uint64, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseUint(value, 10, bitSize)
	if err != nil {
		return 0, fmt.Errorf("%s must be an unsigned integer", key)
	}
	return parsed, nil
}
