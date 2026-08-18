package config

import "testing"

func TestFromEnvironmentDefaults(t *testing.T) {
	t.Setenv("APP_ENV", "")
	t.Setenv("HTTP_ADDR", "")
	t.Setenv("DATABASE_URL", "postgres://test:test@localhost:5432/test")
	t.Setenv("PUBLIC_APP_URL", "")
	t.Setenv("S3_BUCKET", "test")

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
}

func TestFromEnvironmentRequiresDatabaseURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("S3_BUCKET", "test")

	if _, err := FromEnvironment(); err == nil {
		t.Fatal("FromEnvironment() error = nil, want DATABASE_URL validation error")
	}
}

func TestFromEnvironmentSupportsCustomS3Endpoint(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://test:test@localhost:5432/test")
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
	t.Setenv("DATABASE_URL", "postgres://test:test@localhost:5432/test")
	t.Setenv("S3_BUCKET", "messages")
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")

	if _, err := FromEnvironment(); err != nil {
		t.Fatalf("FromEnvironment() error = %v", err)
	}
}

func TestFromEnvironmentRejectsPartialS3Credentials(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://test:test@localhost:5432/test")
	t.Setenv("S3_BUCKET", "messages")
	t.Setenv("S3_ACCESS_KEY", "access")
	t.Setenv("S3_SECRET_KEY", "")

	if _, err := FromEnvironment(); err == nil {
		t.Fatal("FromEnvironment() error = nil, want partial S3 credentials validation error")
	}
}

func TestFromEnvironmentRejectsInvalidPathStyle(t *testing.T) {
	t.Setenv("S3_FORCE_PATH_STYLE", "sometimes")

	if _, err := FromEnvironment(); err == nil {
		t.Fatal("FromEnvironment() error = nil, want boolean validation error")
	}
}
