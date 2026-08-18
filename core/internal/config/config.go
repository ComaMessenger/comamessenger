package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	AppEnv       string
	HTTPAddr     string
	DatabaseURL  string
	PublicAppURL string
}

func FromEnvironment() (Config, error) {
	cfg := Config{
		AppEnv:       valueOrDefault("APP_ENV", "development"),
		HTTPAddr:     valueOrDefault("HTTP_ADDR", ":8080"),
		DatabaseURL:  strings.TrimSpace(os.Getenv("DATABASE_URL")),
		PublicAppURL: valueOrDefault("PUBLIC_APP_URL", "http://localhost:5173"),
	}

	if cfg.HTTPAddr == "" {
		return Config{}, fmt.Errorf("HTTP_ADDR must not be empty")
	}

	return cfg, nil
}

func valueOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
