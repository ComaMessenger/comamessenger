package config

import (
	"strings"
	"testing"
	"time"
)

func setRequiredEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://test:test@localhost:5432/test")
	t.Setenv("S3_BUCKET", "test")
	t.Setenv("STORAGE_DRIVER", "")
	t.Setenv("LOCAL_STORAGE_PATH", "")
	t.Setenv("LOCAL_STORAGE_QUOTA_BYTES", "")
	t.Setenv("LOCAL_STORAGE_MIN_FREE_BYTES", "")
	t.Setenv("FILE_MAX_BYTES", "")
	t.Setenv("FILE_MULTIPART_THRESHOLD_BYTES", "")
	t.Setenv("FILE_UPLOAD_TTL", "")
	t.Setenv("FILE_PRESIGN_TTL", "")
	t.Setenv("AUTH_SIGNING_KEY", "0123456789abcdef0123456789abcdef")
	t.Setenv("REDIS_MODE", "")
	t.Setenv("REDIS_URL", "")
	t.Setenv("REDIS_NAMESPACE", "")
	t.Setenv("REDIS_CONNECT_TIMEOUT", "")
	t.Setenv("REDIS_OPERATION_TIMEOUT", "")
	t.Setenv("REDIS_EPHEMERAL_SIGNING_KEY", "")
	t.Setenv("BOOTSTRAP_TOKEN", "")
	t.Setenv("TRUSTED_PROXY_CIDRS", "")
	for _, key := range []string{"WS_MAX_PENDING_CONNECTIONS", "WS_MAX_CONCURRENT_WRITES", "WS_TYPING_TTL", "WS_PRESENCE_TTL", "WS_ACTIVE_SUBSCRIPTION_TTL", "WS_EPHEMERAL_RATE_LIMIT", "WS_EPHEMERAL_RATE_WINDOW"} {
		t.Setenv(key, "")
	}
}

func TestFromEnvironmentDefaults(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("APP_ENV", "")
	t.Setenv("HTTP_ADDR", "")
	t.Setenv("PUBLIC_APP_URL", "")

	cfg, err := FromEnvironment()
	if err != nil {
		t.Fatalf("FromEnvironment() error = %v", err)
	}
	if cfg.AppEnv != "development" {
		t.Fatalf("AppEnv = %q, want development", cfg.AppEnv)
	}
	if cfg.HTTPAddr != ":8080" {
		t.Fatalf("HTTPAddr = %q, want :8080", cfg.HTTPAddr)
	}
	if cfg.S3.Region != "us-east-1" {
		t.Fatalf("S3.Region = %q, want us-east-1", cfg.S3.Region)
	}
	if cfg.S3.ForcePathStyle {
		t.Fatal("S3.ForcePathStyle = true, want false")
	}
	if cfg.Storage.Driver != "local" || cfg.Storage.LocalPath != "/var/lib/coma/files" || cfg.Storage.QuotaBytes != 2*1024*1024*1024 {
		t.Fatalf("unexpected storage defaults: %#v", cfg.Storage)
	}
	if cfg.Storage.MaxFileBytes != 100*1024*1024 || cfg.Storage.MultipartThreshold != 16*1024*1024 || cfg.Storage.UploadTTL != 24*time.Hour || cfg.Storage.PresignTTL != 15*time.Minute {
		t.Fatalf("unexpected upload defaults: %#v", cfg.Storage)
	}
	if cfg.Auth.CookieSecure {
		t.Fatal("Auth.CookieSecure = true in development, want false")
	}
	if cfg.Messaging.MaxBodyBytes != 64*1024 || cfg.Messaging.MaxPageSize != 100 {
		t.Fatalf("unexpected messaging defaults: %#v", cfg.Messaging)
	}
	if cfg.Realtime.AuthTimeout != 5*time.Second || cfg.Realtime.MaxFrameBytes != 256*1024 {
		t.Fatalf("unexpected realtime handshake defaults: %#v", cfg.Realtime)
	}
	if cfg.Realtime.MaxPendingConnections != 256 {
		t.Fatalf("MaxPendingConnections = %d, want 256", cfg.Realtime.MaxPendingConnections)
	}
	if cfg.Realtime.MaxConcurrentWrites != 8 {
		t.Fatalf("MaxConcurrentWrites = %d, want 8", cfg.Realtime.MaxConcurrentWrites)
	}
	if cfg.Realtime.MaxQueuedEvents != 256 || cfg.Realtime.MaxQueuedBytes != 1024*1024 || cfg.Realtime.MaxUnackedEvents != 128 {
		t.Fatalf("unexpected realtime queue defaults: %#v", cfg.Realtime)
	}
	if cfg.Realtime.HeartbeatInterval != 25*time.Second || cfg.Realtime.PongTimeout != 10*time.Second {
		t.Fatalf("unexpected realtime heartbeat defaults: %#v", cfg.Realtime)
	}
	if cfg.Realtime.TypingTTL != 6*time.Second || cfg.Realtime.PresenceTTL != 60*time.Second || cfg.Realtime.EphemeralRateLimit != 30 || cfg.Realtime.EphemeralRateWindow != 10*time.Second {
		t.Fatalf("unexpected ephemeral defaults: %#v", cfg.Realtime)
	}
	if cfg.EventLog.PollInterval != 200*time.Millisecond || cfg.EventLog.WakeCoalesce != 5*time.Millisecond || cfg.EventLog.Retention != 72*time.Hour || cfg.EventLog.RetentionMinCount != 100_000 || cfg.EventLog.RetentionInterval != 5*time.Minute || cfg.EventLog.RetentionBatch != 10_000 {
		t.Fatalf("unexpected event log defaults: %#v", cfg.EventLog)
	}
	if cfg.Redis.Mode != "disabled" || cfg.Redis.URL != "" || cfg.Redis.Namespace != "coma:v1" {
		t.Fatalf("unexpected Redis defaults: %#v", cfg.Redis)
	}
	if cfg.Redis.ConnectTimeout != time.Second || cfg.Redis.OperationTimeout != 500*time.Millisecond {
		t.Fatalf("unexpected Redis timeouts: %#v", cfg.Redis)
	}
	if len(cfg.TrustedProxyCIDRs) != 2 {
		t.Fatalf("TrustedProxyCIDRs = %v", cfg.TrustedProxyCIDRs)
	}
}

func TestFromEnvironmentSupportsRequiredRedis(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("REDIS_MODE", "required")
	t.Setenv("REDIS_URL", "redis://redis:6379/0")
	t.Setenv("REDIS_NAMESPACE", ":coma:test:")
	t.Setenv("REDIS_CONNECT_TIMEOUT", "2s")
	t.Setenv("REDIS_OPERATION_TIMEOUT", "250ms")
	t.Setenv("REDIS_EPHEMERAL_SIGNING_KEY", "0123456789abcdef0123456789abcdef")

	cfg, err := FromEnvironment()
	if err != nil {
		t.Fatalf("FromEnvironment() error = %v", err)
	}
	if cfg.Redis.Mode != "required" || cfg.Redis.URL != "redis://redis:6379/0" || cfg.Redis.Namespace != "coma:test" {
		t.Fatalf("unexpected Redis configuration: %#v", cfg.Redis)
	}
	if cfg.Redis.ConnectTimeout != 2*time.Second || cfg.Redis.OperationTimeout != 250*time.Millisecond {
		t.Fatalf("unexpected Redis timeouts: %#v", cfg.Redis)
	}
}

func TestFromEnvironmentRejectsInvalidRedisConfiguration(t *testing.T) {
	tests := []struct {
		name, mode, redisURL, key, value string
	}{
		{name: "unknown mode", mode: "optional"},
		{name: "required without URL", mode: "required"},
		{name: "disabled with URL", mode: "disabled", redisURL: "redis://localhost:6379"},
		{name: "short connect timeout", mode: "required", redisURL: "redis://localhost:6379", key: "REDIS_CONNECT_TIMEOUT", value: "10ms"},
		{name: "long operation timeout", mode: "required", redisURL: "redis://localhost:6379", key: "REDIS_OPERATION_TIMEOUT", value: "10s"},
		{name: "invalid namespace", mode: "required", redisURL: "redis://localhost:6379", key: "REDIS_NAMESPACE", value: "coma test"},
		{name: "missing ephemeral signing key", mode: "required", redisURL: "redis://localhost:6379", key: "REDIS_EPHEMERAL_SIGNING_KEY", value: ""},
		{name: "short ephemeral signing key", mode: "required", redisURL: "redis://localhost:6379", key: "REDIS_EPHEMERAL_SIGNING_KEY", value: "short"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setRequiredEnvironment(t)
			t.Setenv("REDIS_MODE", tt.mode)
			t.Setenv("REDIS_URL", tt.redisURL)
			if tt.mode == "required" {
				t.Setenv("REDIS_EPHEMERAL_SIGNING_KEY", "0123456789abcdef0123456789abcdef")
			}
			if tt.key != "" {
				t.Setenv(tt.key, tt.value)
			}
			if _, err := FromEnvironment(); err == nil {
				t.Fatal("FromEnvironment() error = nil, want Redis configuration error")
			}
		})
	}
}

func TestFromEnvironmentRequiresDatabaseURL(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("DATABASE_URL", "")

	if _, err := FromEnvironment(); err == nil {
		t.Fatal("FromEnvironment() error = nil, want DATABASE_URL validation error")
	}
}

func TestFromEnvironmentSupportsCustomS3Endpoint(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("STORAGE_DRIVER", "s3")
	t.Setenv("S3_ENDPOINT", "https://storage.example.test")
	t.Setenv("S3_PUBLIC_ENDPOINT", "https://cdn.example.test")
	t.Setenv("S3_REGION", "ru-1")
	t.Setenv("S3_BUCKET", "messages")
	t.Setenv("S3_ACCESS_KEY", "access")
	t.Setenv("S3_SECRET_KEY", "secret")
	t.Setenv("S3_PREFIX", "/tenant-a/")
	t.Setenv("S3_FORCE_PATH_STYLE", "true")

	cfg, err := FromEnvironment()
	if err != nil {
		t.Fatalf("FromEnvironment() error = %v", err)
	}
	if cfg.S3.Endpoint != "https://storage.example.test" || cfg.S3.PublicEndpoint != "https://cdn.example.test" {
		t.Fatalf("unexpected S3 endpoints: %#v", cfg.S3)
	}
	if cfg.S3.Region != "ru-1" || cfg.S3.Bucket != "messages" || cfg.S3.Prefix != "tenant-a" {
		t.Fatalf("unexpected S3 provider configuration: %#v", cfg.S3)
	}
	if !cfg.S3.ForcePathStyle {
		t.Fatal("S3.ForcePathStyle = false, want true")
	}
}

func TestFromEnvironmentAllowsLocalStorageWithoutS3Bucket(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("S3_BUCKET", "")
	t.Setenv("LOCAL_STORAGE_PATH", "/srv/coma/blobs")
	t.Setenv("LOCAL_STORAGE_QUOTA_BYTES", "1073741824")
	t.Setenv("FILE_MAX_BYTES", "104857600")

	cfg, err := FromEnvironment()
	if err != nil {
		t.Fatalf("FromEnvironment() error = %v", err)
	}
	if cfg.Storage.Driver != "local" || cfg.Storage.LocalPath != "/srv/coma/blobs" || cfg.Storage.QuotaBytes != 1073741824 {
		t.Fatalf("unexpected local storage configuration: %#v", cfg.Storage)
	}
}

func TestFromEnvironmentRejectsInvalidStorageConfiguration(t *testing.T) {
	tests := []struct{ key, value string }{
		{key: "STORAGE_DRIVER", value: "elastic"},
		{key: "LOCAL_STORAGE_QUOTA_BYTES", value: "0"},
		{key: "FILE_MAX_BYTES", value: "0"},
		{key: "FILE_MULTIPART_THRESHOLD_BYTES", value: "1024"},
		{key: "FILE_UPLOAD_TTL", value: "30m"},
		{key: "FILE_PRESIGN_TTL", value: "2h"},
	}
	for _, test := range tests {
		t.Run(test.key, func(t *testing.T) {
			setRequiredEnvironment(t)
			t.Setenv(test.key, test.value)
			if _, err := FromEnvironment(); err == nil {
				t.Fatalf("FromEnvironment() error = nil for %s", test.key)
			}
		})
	}
}

func TestFromEnvironmentAllowsCredentialChain(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("S3_BUCKET", "messages")
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")

	if _, err := FromEnvironment(); err != nil {
		t.Fatalf("FromEnvironment() error = %v", err)
	}
}

func TestFromEnvironmentRejectsPartialS3Credentials(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("S3_BUCKET", "messages")
	t.Setenv("S3_ACCESS_KEY", "access")
	t.Setenv("S3_SECRET_KEY", "")

	if _, err := FromEnvironment(); err == nil {
		t.Fatal("FromEnvironment() error = nil, want partial S3 credentials validation error")
	}
}

func TestFromEnvironmentRejectsInvalidPathStyle(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("S3_FORCE_PATH_STYLE", "sometimes")

	if _, err := FromEnvironment(); err == nil {
		t.Fatal("FromEnvironment() error = nil, want boolean validation error")
	}
}

func TestFromEnvironmentRequiresLongSigningKey(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("AUTH_SIGNING_KEY", "short")

	if _, err := FromEnvironment(); err == nil {
		t.Fatal("FromEnvironment() error = nil, want signing key validation error")
	}
}

func TestFromEnvironmentUsesSecureCookiesOutsideDevelopment(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("APP_ENV", "production")
	t.Setenv("AUTH_COOKIE_SECURE", "")
	t.Setenv("BOOTSTRAP_TOKEN", "0123456789abcdef0123456789abcdef")

	cfg, err := FromEnvironment()
	if err != nil {
		t.Fatalf("FromEnvironment() error = %v", err)
	}
	if !cfg.Auth.CookieSecure {
		t.Fatal("Auth.CookieSecure = false in production, want true")
	}
}

func TestFromEnvironmentRejectsInvalidMessagingAndRealtimeLimits(t *testing.T) {
	tests := []struct {
		name    string
		key     string
		value   string
		wantErr string
	}{
		{name: "body too small", key: "MESSAGE_MAX_BODY_BYTES", value: "100", wantErr: "MESSAGE_MAX_BODY_BYTES"},
		{name: "page too large", key: "MESSAGE_MAX_PAGE_SIZE", value: "501", wantErr: "MESSAGE_MAX_PAGE_SIZE"},
		{name: "frame below body", key: "WS_MAX_FRAME_BYTES", value: "1024", wantErr: "WS_MAX_FRAME_BYTES"},
		{name: "no connections", key: "WS_MAX_CONNECTIONS_PER_ACTOR", value: "0", wantErr: "WS_MAX_CONNECTIONS_PER_ACTOR"},
		{name: "no concurrent writes", key: "WS_MAX_CONCURRENT_WRITES", value: "0", wantErr: "WS_MAX_CONCURRENT_WRITES"},
		{name: "unacked above queue", key: "WS_MAX_UNACKED_EVENTS", value: "300", wantErr: "WS_MAX_UNACKED_EVENTS"},
		{name: "queue bytes below frame", key: "WS_MAX_QUEUED_BYTES", value: "65536", wantErr: "WS_MAX_QUEUED_BYTES"},
		{name: "pong after heartbeat", key: "WS_PONG_TIMEOUT", value: "25s", wantErr: "WS_PONG_TIMEOUT"},
		{name: "ack timeout before interval", key: "WS_ACK_TIMEOUT", value: "500ms", wantErr: "WS_ACK_TIMEOUT"},
		{name: "ack batch above window", key: "WS_ACK_BATCH_SIZE", value: "129", wantErr: "WS_ACK_BATCH_SIZE"},
		{name: "typing ttl too long", key: "WS_TYPING_TTL", value: "31s", wantErr: "WS_TYPING_TTL"},
		{name: "presence ttl too short", key: "WS_PRESENCE_TTL", value: "5s", wantErr: "WS_PRESENCE_TTL"},
		{name: "ephemeral limit zero", key: "WS_EPHEMERAL_RATE_LIMIT", value: "0", wantErr: "WS_EPHEMERAL_RATE_LIMIT"},
		{name: "poll too frequent", key: "EVENT_POLL_INTERVAL", value: "1ms", wantErr: "EVENT_POLL_INTERVAL"},
		{name: "coalesce too long", key: "EVENT_WAKE_COALESCE", value: "500ms", wantErr: "EVENT_WAKE_COALESCE"},
		{name: "retention too short", key: "EVENT_RETENTION", value: "30m", wantErr: "EVENT_RETENTION"},
		{name: "retention floor too small", key: "EVENT_RETENTION_MIN_COUNT", value: "999", wantErr: "EVENT_RETENTION_MIN_COUNT"},
		{name: "retention interval too short", key: "EVENT_RETENTION_INTERVAL", value: "1s", wantErr: "EVENT_RETENTION_INTERVAL"},
		{name: "retention batch too large", key: "EVENT_RETENTION_BATCH_SIZE", value: "100001", wantErr: "EVENT_RETENTION_BATCH_SIZE"},
		{name: "bootstrap token too short", key: "BOOTSTRAP_TOKEN", value: "short", wantErr: "BOOTSTRAP_TOKEN"},
		{name: "invalid trusted proxy", key: "TRUSTED_PROXY_CIDRS", value: "not-a-cidr", wantErr: "TRUSTED_PROXY_CIDRS"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setRequiredEnvironment(t)
			t.Setenv(tt.key, tt.value)
			_, err := FromEnvironment()
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("FromEnvironment() error = %v, want error containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestFromEnvironmentRejectsDevelopmentSecretsInProduction(t *testing.T) {
	tests := []struct {
		name, key, value, wantErr string
	}{
		{name: "signing key", key: "AUTH_SIGNING_KEY", value: "comamessenger-local-signing-key-change-me", wantErr: "AUTH_SIGNING_KEY"},
		{name: "integration key", key: "INTEGRATION_ENCRYPTION_KEY", value: "comamessenger-local-integration-key-change-me", wantErr: "INTEGRATION_ENCRYPTION_KEY"},
		{name: "database password", key: "DATABASE_URL", value: "postgres://comamessenger:comamessenger@postgres:5432/comamessenger", wantErr: "DATABASE_URL"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setRequiredEnvironment(t)
			t.Setenv("APP_ENV", "production")
			t.Setenv("BOOTSTRAP_TOKEN", "0123456789abcdef0123456789abcdef")
			t.Setenv(tt.key, tt.value)
			_, err := FromEnvironment()
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("FromEnvironment() error = %v, want %q", err, tt.wantErr)
			}
		})
	}
}
