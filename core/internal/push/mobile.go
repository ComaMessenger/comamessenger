package push

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
)

// ErrMobileUnavailable is returned when the instance has no push relay.
var ErrMobileUnavailable = errors.New("mobile push is not configured")

// ErrUnknownHandle means the relay no longer knows the device; it is removed.
var ErrUnknownHandle = errors.New("push relay does not know the device")

type MobileDeviceInput struct {
	Platform        string `json:"platform"`
	RelayHandle     string `json:"relay_handle"`
	NotificationKey string `json:"notification_key"`
	AppVersion      string `json:"app_version"`
	Locale          string `json:"locale"`
}

type MobileDevice struct {
	ID        string    `json:"id"`
	Platform  string    `json:"platform"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// RegisterMobileDevice binds a relay handle and its notification key to the
// caller's session family. Registering the same handle again moves it to the
// current account and rotates the key.
func (s *Service) RegisterMobileDevice(ctx context.Context, user identity.User, sessionID string, input MobileDeviceInput) (MobileDevice, error) {
	if s.config.RelayURL == "" {
		return MobileDevice{}, ErrMobileUnavailable
	}
	input.RelayHandle = strings.TrimSpace(input.RelayHandle)
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(input.NotificationKey))
	if (input.Platform != "ios" && input.Platform != "android") ||
		len(input.RelayHandle) < 32 || len(input.RelayHandle) > 256 ||
		err != nil || len(key) != 32 ||
		len(input.AppVersion) > 64 || len(input.Locale) > 16 {
		return MobileDevice{}, ErrInvalid
	}
	deviceID, err := id.New()
	if err != nil {
		return MobileDevice{}, err
	}
	var result MobileDevice
	err = s.pool.QueryRow(ctx, `
		INSERT INTO mobile_push_devices(id,org_id,actor_id,session_family_id,platform,relay_handle,notification_key,app_version,locale)
		SELECT $1,$2,$3,family_id,$5,$6,$7,$8,$9 FROM sessions WHERE id=$4 AND actor_id=$3 AND revoked_at IS NULL
		ON CONFLICT(org_id,relay_handle) DO UPDATE SET actor_id=EXCLUDED.actor_id,session_family_id=EXCLUDED.session_family_id,
		  platform=EXCLUDED.platform,notification_key=EXCLUDED.notification_key,app_version=EXCLUDED.app_version,
		  locale=EXCLUDED.locale,updated_at=now()
		RETURNING id,platform,created_at,updated_at`,
		deviceID, user.OrgID, user.ActorID, sessionID, input.Platform, input.RelayHandle, key, input.AppVersion, input.Locale,
	).Scan(&result.ID, &result.Platform, &result.CreatedAt, &result.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return MobileDevice{}, ErrInvalid
	}
	return result, err
}

func (s *Service) DeleteMobileDevice(ctx context.Context, user identity.User, deviceID string) error {
	command, err := s.pool.Exec(ctx, `DELETE FROM mobile_push_devices WHERE id=$1 AND org_id=$2 AND actor_id=$3`, deviceID, user.OrgID, user.ActorID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrInvalid
	}
	return nil
}

// RelayMessage is everything the relay learns about a notification: the
// opaque device handle, the encrypted content and a neutral fallback text.
type RelayMessage struct {
	Handle        string `json:"handle"`
	Ciphertext    string `json:"ciphertext"`
	FallbackTitle string `json:"fallback_title"`
	FallbackBody  string `json:"fallback_body"`
	CollapseID    string `json:"collapse_id,omitempty"`
}

type RelayClient interface {
	Send(ctx context.Context, message RelayMessage) error
}

type httpRelay struct {
	baseURL string
	client  *http.Client
}

func NewHTTPRelay(baseURL string, client *http.Client) RelayClient {
	return &httpRelay{baseURL: strings.TrimRight(baseURL, "/"), client: client}
}

func (r *httpRelay) Send(ctx context.Context, message RelayMessage) error {
	encoded, err := json.Marshal(message)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+"/v1/send", bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := r.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	switch {
	case response.StatusCode >= 200 && response.StatusCode < 300:
		return nil
	case response.StatusCode == http.StatusGone || response.StatusCode == http.StatusNotFound:
		return ErrUnknownHandle
	default:
		return fmt.Errorf("push relay responded %d", response.StatusCode)
	}
}

// mobilePayload is encrypted with the device key; only the app can read it.
type mobilePayload struct {
	Version int `json:"v"`
	notificationContent
	EventSeq int64 `json:"event_seq"`
	// Badge is the recipient's unread chat messages, as the app counts them.
	Badge int64 `json:"badge"`
}

// unreadTotal matches the app icon badge: unread top-level messages from
// others across the recipient's active chats.
const unreadTotal = `SELECT count(m.id)
	FROM chat_members cm
	JOIN chats c ON c.org_id=cm.org_id AND c.id=cm.chat_id AND c.archived_at IS NULL
	LEFT JOIN chat_reads cr ON cr.org_id=cm.org_id AND cr.chat_id=cm.chat_id AND cr.actor_id=cm.actor_id
	JOIN messages m ON m.org_id=cm.org_id AND m.chat_id=cm.chat_id AND m.thread_root_id IS NULL
	  AND m.created_seq>COALESCE(cr.last_read_seq,0) AND m.actor_id<>cm.actor_id AND m.deleted_at IS NULL
	WHERE cm.org_id=$1 AND cm.actor_id=$2`

// sealPayload encrypts with AES-256-GCM and returns base64(nonce || ciphertext).
func sealPayload(key []byte, plaintext []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(aead.Seal(nonce, nonce, plaintext, nil)), nil
}

// liveFamily is true while the device's session family still has a usable session.
const liveFamily = `EXISTS (SELECT 1 FROM sessions s WHERE s.family_id=d.session_family_id AND s.revoked_at IS NULL AND s.expires_at>now())`

// liveSubscription is the same rule for a browser subscription. It keeps the
// session row it was created with; refresh rotation revokes that row but
// leaves it in the family, so the family is found through it.
const liveSubscription = `EXISTS (SELECT 1 FROM sessions origin JOIN sessions live ON live.family_id=origin.family_id
	WHERE origin.id=ws.session_id AND live.revoked_at IS NULL AND live.expires_at>now())`

func (w *Worker) deliverMobile(ctx context.Context) error {
	if _, err := w.pool.Exec(ctx, `DELETE FROM mobile_push_devices d WHERE NOT `+liveFamily); err != nil {
		return err
	}
	leaseToken, err := id.New()
	if err != nil {
		return err
	}
	_, err = w.pool.Exec(ctx, `WITH candidates AS (
		SELECT org_id,event_seq,device_id FROM mobile_push_deliveries
		WHERE sent_at IS NULL AND available_at<=now() AND (lease_until IS NULL OR lease_until<now())
		ORDER BY event_seq LIMIT 50 FOR UPDATE SKIP LOCKED
	) UPDATE mobile_push_deliveries p SET lease_token=$1,lease_until=now()+interval '30 seconds'
	FROM candidates c WHERE p.org_id=c.org_id AND p.event_seq=c.event_seq AND p.device_id=c.device_id`, leaseToken)
	if err != nil {
		return err
	}
	rows, err := w.pool.Query(ctx, `SELECT p.org_id,p.event_seq,p.device_id,d.actor_id,d.relay_handle,d.notification_key,
		e.type,e.data,e.chat_id,m.thread_root_id,m.body,c.name,a.display_name,
		COALESCE((u.preferences->>'push_preview')::boolean,false),COALESCE(NULLIF(d.locale,''),u.preferences->>'locale','ru')
		FROM mobile_push_deliveries p JOIN mobile_push_devices d ON d.id=p.device_id
		JOIN events e ON e.org_id=p.org_id AND e.seq=p.event_seq
		LEFT JOIN messages m ON m.org_id=e.org_id AND m.id=e.subject_id
		LEFT JOIN chats c ON c.org_id=e.org_id AND c.id=e.chat_id
		JOIN actors a ON a.org_id=e.org_id AND a.id=e.actor_id
		JOIN users u ON u.org_id=d.org_id AND u.actor_id=d.actor_id
		WHERE p.lease_token=$1 ORDER BY p.event_seq`, leaseToken)
	if err != nil {
		return err
	}
	type delivery struct {
		org, device, actor, handle, eventType, author, locale string
		seq                                                   int64
		key, eventData                                        []byte
		chatID, threadID, body, chatName                      *string
		preview                                               bool
	}
	deliveries := []delivery{}
	for rows.Next() {
		var item delivery
		if err := rows.Scan(&item.org, &item.seq, &item.device, &item.actor, &item.handle, &item.key,
			&item.eventType, &item.eventData, &item.chatID, &item.threadID, &item.body, &item.chatName, &item.author,
			&item.preview, &item.locale); err != nil {
			rows.Close()
			return err
		}
		deliveries = append(deliveries, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	finish := func(item delivery, query string, args ...any) {
		_, _ = w.pool.Exec(ctx, query, append([]any{item.org, item.seq, item.device, leaseToken}, args...)...)
	}
	for _, item := range deliveries {
		if item.chatID != nil && w.active != nil && w.active(item.org, item.actor, *item.chatID) {
			finish(item, `UPDATE mobile_push_deliveries SET sent_at=now(),last_error='suppressed_active',lease_token=NULL,lease_until=NULL WHERE org_id=$1 AND event_seq=$2 AND device_id=$3 AND lease_token=$4`)
			continue
		}
		content := buildNotification(item.eventType, item.eventData, item.author, item.locale, item.preview, item.chatID, item.threadID, item.body, item.chatName)
		var badge int64
		if err := w.pool.QueryRow(ctx, unreadTotal, item.org, item.actor).Scan(&badge); err != nil {
			return err
		}
		plaintext, _ := json.Marshal(mobilePayload{Version: 1, notificationContent: content, EventSeq: item.seq, Badge: badge})
		ciphertext, err := sealPayload(item.key, plaintext)
		if err != nil {
			return err
		}
		fallbackTitle, fallbackBody := "Coma", "Новое сообщение"
		if item.locale == "en" {
			fallbackBody = "New message"
		}
		sendErr := w.relay.Send(ctx, RelayMessage{
			Handle: item.handle, Ciphertext: ciphertext,
			FallbackTitle: fallbackTitle, FallbackBody: fallbackBody, CollapseID: content.ChatID,
		})
		switch {
		case sendErr == nil:
			finish(item, `UPDATE mobile_push_deliveries SET sent_at=now(),attempts=attempts+1,last_error=NULL,lease_token=NULL,lease_until=NULL WHERE org_id=$1 AND event_seq=$2 AND device_id=$3 AND lease_token=$4`)
		case errors.Is(sendErr, ErrUnknownHandle):
			_, _ = w.pool.Exec(ctx, `DELETE FROM mobile_push_devices WHERE id=$1`, item.device)
		default:
			finish(item, `UPDATE mobile_push_deliveries SET attempts=attempts+1,last_error=$5,available_at=now()+LEAST(interval '1 hour',interval '5 seconds'*power(2,LEAST(attempts,8))),lease_token=NULL,lease_until=NULL WHERE org_id=$1 AND event_seq=$2 AND device_id=$3 AND lease_token=$4`, sendErr.Error())
		}
	}
	return nil
}
