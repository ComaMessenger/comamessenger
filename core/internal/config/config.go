package config

import (
	"fmt"
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
	MaxQueuedEvents        uint64
	MaxQueuedBytes         uint64
	MaxUnackedEvents       uint64
	HeartbeatInterval      time.Duration
	PongTimeout            time.Duration
	AckInterval            time.Duration
	AckTimeout             time.Duration
	AckBatchSize           uint64
}

type EventLogConfig struct {
	PollInterval      time.Duration
	WakeCoalesce      time.Duration
	Retention         time.Duration
	RetentionMinCount uint64
}

type RedisConfig struct {
	Mode             string
	URL              string
	Namespace        string
	ConnectTimeout   time.Duration
	OperationTimeout time.Duration
}

type Config struct {
	AppEnv       string
	HTTPAddr     string
	DatabaseURL  string
	PublicAppURL string
	S3           S3Config
	Auth         AuthConfig
	Messaging    MessagingConfig
	Realtime     RealtimeConfig
	EventLog     EventLogConfig
	Redis        RedisConfig
}

func FromEnvironment() (Config, error) {
	appEnv := valueOrDefault("APP_ENV", "development")
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

	cfg := Config{
		AppEnv:       appEnv,
		HTTPAddr:     valueOrDefault("HTTP_ADDR", ":8080"),
		DatabaseURL:  strings.TrimSpace(os.Getenv("DATABASE_URL")),
		PublicAppURL: valueOrDefault("PUBLIC_APP_URL", "http://localhost:5173"),
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
			SigningKey:       strings.TrimSpace(os.Getenv("AUTH_SIGNING_KEY")),
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
	if cfg.S3.Bucket == "" {
		return Config{}, fmt.Errorf("S3_BUCKET must not be empty")
	}
	if (cfg.S3.AccessKey == "") != (cfg.S3.SecretKey == "") {
		return Config{}, fmt.Errorf("S3_ACCESS_KEY and S3_SECRET_KEY must be set together")
	}
	if len(cfg.Auth.SigningKey) < 32 {
		return Config{}, fmt.Errorf("AUTH_SIGNING_KEY must be at least 32 bytes")
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
	return cfg, nil
}

func redisConfigFromEnvironment() (RedisConfig, error) {
	mode := strings.ToLower(valueOrDefault("REDIS_MODE", "disabled"))
	if mode != "required" && mode != "disabled" {
		return RedisConfig{}, fmt.Errorf("REDIS_MODE must be required or disabled")
	}
	redisURL := strings.TrimSpace(os.Getenv("REDIS_URL"))
	if mode == "required" && redisURL == "" {
		return RedisConfig{}, fmt.Errorf("REDIS_URL must be set when REDIS_MODE=required")
	}
	if mode == "disabled" && redisURL != "" {
		return RedisConfig{}, fmt.Errorf("REDIS_URL must be empty when REDIS_MODE=disabled")
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
		Mode: mode, URL: redisURL, Namespace: namespace,
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
	return EventLogConfig{PollInterval: pollInterval, WakeCoalesce: wakeCoalesce, Retention: retention, RetentionMinCount: retentionMinCount}, nil
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
