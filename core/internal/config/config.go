package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
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

type Config struct {
	AppEnv       string
	HTTPAddr     string
	DatabaseURL  string
	PublicAppURL string
	S3           S3Config
}

func FromEnvironment() (Config, error) {
	forcePathStyle, err := boolValueOrDefault("S3_FORCE_PATH_STYLE", false)
	if err != nil {
		return Config{}, err
	}

	cfg := Config{
		AppEnv:       valueOrDefault("APP_ENV", "development"),
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
