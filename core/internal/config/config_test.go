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
	t.Setenv("AUTH_SIGNING_KEY", "0123456789abcdef0123456789abcdef")
	t.Setenv("REDIS_MODE", "")
	t.Setenv("REDIS_URL", "")
	t.Setenv("REDIS_NAMESPACE", "")
	t.Setenv("REDIS_CONNECT_TIMEOUT", "")
	t.Setenv("REDIS_OPERATION_TIMEOUT", "")
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
	if cfg.Auth.CookieSecure {
		t.Fatal("Auth.CookieSecure = true in development, want false")
	}
	if cfg.Messaging.MaxBodyBytes != 64*1024 || cfg.Messaging.MaxPageSize != 100 {
		t.Fatalf("unexpected messaging defaults: %#v", cfg.Messaging)
	}
	if cfg.Realtime.AuthTimeout != 5*time.Second || cfg.Realtime.MaxFrameBytes != 256*1024 {
		t.Fatalf("unexpected realtime handshake defaults: %#v", cfg.Realtime)
	}
	if cfg.Realtime.MaxQueuedEvents != 256 || cfg.Realtime.MaxQueuedBytes != 1024*1024 || cfg.Realtime.MaxUnackedEvents != 128 {
		t.Fatalf("unexpected realtime queue defaults: %#v", cfg.Realtime)
	}
	if cfg.Realtime.HeartbeatInterval != 25*time.Second || cfg.Realtime.PongTimeout != 10*time.Second {
		t.Fatalf("unexpected realtime heartbeat defaults: %#v", cfg.Realtime)
	}
	if cfg.EventLog.PollInterval != 200*time.Millisecond || cfg.EventLog.WakeCoalesce != 5*time.Millisecond || cfg.EventLog.Retention != 72*time.Hour || cfg.EventLog.RetentionMinCount != 100_000 {
		t.Fatalf("unexpected event log defaults: %#v", cfg.EventLog)
	}
	if cfg.Redis.Mode != "disabled" || cfg.Redis.URL != "" || cfg.Redis.Namespace != "coma:v1" {
		t.Fatalf("unexpected Redis defaults: %#v", cfg.Redis)
	}
	if cfg.Redis.ConnectTimeout != time.Second || cfg.Redis.OperationTimeout != 500*time.Millisecond {
		t.Fatalf("unexpected Redis timeouts: %#v", cfg.Redis)
	}
}

func TestFromEnvironmentSupportsRequiredRedis(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("REDIS_MODE", "required")
	t.Setenv("REDIS_URL", "redis://redis:6379/0")
	t.Setenv("REDIS_NAMESPACE", ":coma:test:")
	t.Setenv("REDIS_CONNECT_TIMEOUT", "2s")
	t.Setenv("REDIS_OPERATION_TIMEOUT", "250ms")

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
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setRequiredEnvironment(t)
			t.Setenv("REDIS_MODE", tt.mode)
			t.Setenv("REDIS_URL", tt.redisURL)
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
		{name: "unacked above queue", key: "WS_MAX_UNACKED_EVENTS", value: "300", wantErr: "WS_MAX_UNACKED_EVENTS"},
		{name: "queue bytes below frame", key: "WS_MAX_QUEUED_BYTES", value: "65536", wantErr: "WS_MAX_QUEUED_BYTES"},
		{name: "pong after heartbeat", key: "WS_PONG_TIMEOUT", value: "25s", wantErr: "WS_PONG_TIMEOUT"},
		{name: "ack timeout before interval", key: "WS_ACK_TIMEOUT", value: "500ms", wantErr: "WS_ACK_TIMEOUT"},
		{name: "ack batch above window", key: "WS_ACK_BATCH_SIZE", value: "129", wantErr: "WS_ACK_BATCH_SIZE"},
		{name: "poll too frequent", key: "EVENT_POLL_INTERVAL", value: "1ms", wantErr: "EVENT_POLL_INTERVAL"},
		{name: "coalesce too long", key: "EVENT_WAKE_COALESCE", value: "500ms", wantErr: "EVENT_WAKE_COALESCE"},
		{name: "retention too short", key: "EVENT_RETENTION", value: "30m", wantErr: "EVENT_RETENTION"},
		{name: "retention floor too small", key: "EVENT_RETENTION_MIN_COUNT", value: "999", wantErr: "EVENT_RETENTION_MIN_COUNT"},
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
