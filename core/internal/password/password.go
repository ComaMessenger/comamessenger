package password

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

const (
	SaltLength = 16
	KeyLength  = 32
)

var ErrInvalidHash = errors.New("invalid password hash")

type Params struct {
	MemoryKiB   uint32
	Iterations  uint32
	Parallelism uint8
}

func (p Params) Validate() error {
	if p.MemoryKiB < 19*1024 || p.MemoryKiB > 256*1024 {
		return fmt.Errorf("argon2 memory must be between 19456 and 262144 KiB")
	}
	if p.Iterations < 2 || p.Iterations > 10 {
		return fmt.Errorf("argon2 iterations must be between 2 and 10")
	}
	if p.Parallelism < 1 || p.Parallelism > 16 {
		return fmt.Errorf("argon2 parallelism must be between 1 and 16")
	}
	return nil
}

type Hasher struct {
	params Params
}

func NewHasher(params Params) (*Hasher, error) {
	if err := params.Validate(); err != nil {
		return nil, err
	}
	return &Hasher{params: params}, nil
}

func (h *Hasher) Hash(value string) (string, error) {
	if len(value) < 10 || len(value) > 1024 {
		return "", fmt.Errorf("password length must be between 10 and 1024 bytes")
	}
	salt := make([]byte, SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate password salt: %w", err)
	}
	key := argon2.IDKey([]byte(value), salt, h.params.Iterations, h.params.MemoryKiB, h.params.Parallelism, KeyLength)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version,
		h.params.MemoryKiB,
		h.params.Iterations,
		h.params.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

func (h *Hasher) Verify(encoded, value string) (bool, error) {
	params, salt, expected, err := decode(encoded)
	if err != nil {
		return false, err
	}
	actual := argon2.IDKey([]byte(value), salt, params.Iterations, params.MemoryKiB, params.Parallelism, uint32(len(expected)))
	return subtle.ConstantTimeCompare(actual, expected) == 1, nil
}

func decode(encoded string) (Params, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return Params{}, nil, nil, ErrInvalidHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return Params{}, nil, nil, ErrInvalidHash
	}
	var params Params
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &params.MemoryKiB, &params.Iterations, &params.Parallelism); err != nil {
		return Params{}, nil, nil, ErrInvalidHash
	}
	if err := params.Validate(); err != nil {
		return Params{}, nil, nil, ErrInvalidHash
	}
	salt, err := base64.RawStdEncoding.Strict().DecodeString(parts[4])
	if err != nil || len(salt) != SaltLength {
		return Params{}, nil, nil, ErrInvalidHash
	}
	key, err := base64.RawStdEncoding.Strict().DecodeString(parts[5])
	if err != nil || len(key) != KeyLength {
		return Params{}, nil, nil, ErrInvalidHash
	}
	return params, salt, key, nil
}
