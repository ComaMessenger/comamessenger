// Package relay is the push relay run by the Coma project (ADR-0012). It maps
// opaque device handles to APNs/FCM tokens and forwards encrypted
// notifications from self-hosted instances without learning their content.
package relay

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrUnknownHandle = errors.New("unknown device handle")

type Device struct {
	Platform string
	Token    string
}

type Store struct{ pool *pgxpool.Pool }

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// EnsureSchema creates the single relay table; the relay owns its database.
func (s *Store) EnsureSchema(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS relay_devices (
		handle text PRIMARY KEY,
		platform text NOT NULL CHECK (platform IN ('ios', 'android')),
		token text NOT NULL CHECK (length(token) BETWEEN 8 AND 4096),
		created_at timestamptz NOT NULL DEFAULT now(),
		updated_at timestamptz NOT NULL DEFAULT now(),
		last_sent_at timestamptz
	)`)
	return err
}

func newHandle() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func (s *Store) Create(ctx context.Context, device Device) (string, error) {
	handle, err := newHandle()
	if err != nil {
		return "", err
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO relay_devices(handle,platform,token) VALUES($1,$2,$3)`, handle, device.Platform, device.Token)
	return handle, err
}

func (s *Store) UpdateToken(ctx context.Context, handle, token string) error {
	command, err := s.pool.Exec(ctx, `UPDATE relay_devices SET token=$2,updated_at=now() WHERE handle=$1`, handle, token)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrUnknownHandle
	}
	return nil
}

func (s *Store) Delete(ctx context.Context, handle string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM relay_devices WHERE handle=$1`, handle)
	return err
}

func (s *Store) Lookup(ctx context.Context, handle string) (Device, error) {
	var device Device
	err := s.pool.QueryRow(ctx, `UPDATE relay_devices SET last_sent_at=now() WHERE handle=$1 RETURNING platform,token`, handle).Scan(&device.Platform, &device.Token)
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, ErrUnknownHandle
	}
	return device, err
}
