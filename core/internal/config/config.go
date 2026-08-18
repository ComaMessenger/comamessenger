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

type Config struct {
	AppEnv       string
	HTTPAddr     string
	DatabaseURL  string
	PublicAppURL string
	S3           S3Config
	Auth         AuthConfig
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
