package push

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalid = errors.New("invalid push input")

type SubscriptionInput struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}
type Subscription struct {
	ID        string    `json:"id"`
	Endpoint  string    `json:"endpoint"`
	CreatedAt time.Time `json:"created_at"`
}
type Preferences struct {
	Theme        string     `json:"theme"`
	Locale       string     `json:"locale"`
	PushEnabled  bool       `json:"push_enabled"`
	PushPreview  bool       `json:"push_preview"`
	SnoozedUntil *time.Time `json:"snoozed_until"`
}
type OptionalTime struct {
	Set   bool
	Value *time.Time
}

func (value *OptionalTime) UnmarshalJSON(data []byte) error {
	value.Set = true
	if string(data) == "null" {
		value.Value = nil
		return nil
	}
	var parsed time.Time
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	value.Value = &parsed
	return nil
}

type UpdatePreferences struct {
	Theme        *string      `json:"theme"`
	Locale       *string      `json:"locale"`
	PushEnabled  *bool        `json:"push_enabled"`
	PushPreview  *bool        `json:"push_preview"`
	SnoozedUntil OptionalTime `json:"snoozed_until"`
}
type ChatFolder struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Icon    string   `json:"icon"`
	Color   string   `json:"color"`
	ChatIDs []string `json:"chat_ids"`
}
type ChatPreferences struct {
	NotifyLevel string     `json:"notify_level"`
	MutedUntil  *time.Time `json:"muted_until"`
}

type Service struct {
	pool   *pgxpool.Pool
	config config.PushConfig
}

func NewService(pool *pgxpool.Pool, cfg config.PushConfig) *Service {
	return &Service{pool: pool, config: cfg}
}
func (s *Service) Config() map[string]any {
	return map[string]any{"enabled": s.config.VAPIDPublicKey != "", "public_key": s.config.VAPIDPublicKey}
}
func (s *Service) Subscribe(ctx context.Context, user identity.User, sessionID, userAgent string, input SubscriptionInput) (Subscription, error) {
	input.Endpoint = strings.TrimSpace(input.Endpoint)
	input.Keys.P256dh = strings.TrimSpace(input.Keys.P256dh)
	input.Keys.Auth = strings.TrimSpace(input.Keys.Auth)
	if !strings.HasPrefix(input.Endpoint, "https://") || input.Keys.P256dh == "" || input.Keys.Auth == "" {
		return Subscription{}, ErrInvalid
	}
	subscriptionID, err := id.New()
	if err != nil {
		return Subscription{}, err
	}
	var result Subscription
	err = s.pool.QueryRow(ctx, `INSERT INTO web_push_subscriptions(id,org_id,actor_id,session_id,endpoint,p256dh,auth,user_agent) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(actor_id,endpoint) DO UPDATE SET session_id=EXCLUDED.session_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,user_agent=EXCLUDED.user_agent,updated_at=now() RETURNING id,endpoint,created_at`, subscriptionID, user.OrgID, user.ActorID, sessionID, input.Endpoint, input.Keys.P256dh, input.Keys.Auth, userAgent).Scan(&result.ID, &result.Endpoint, &result.CreatedAt)
	return result, err
}
func (s *Service) Unsubscribe(ctx context.Context, user identity.User, subscriptionID string) error {
	command, err := s.pool.Exec(ctx, `DELETE FROM web_push_subscriptions WHERE id=$1 AND org_id=$2 AND actor_id=$3`, subscriptionID, user.OrgID, user.ActorID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrInvalid
	}
	return nil
}
func (s *Service) GetPreferences(ctx context.Context, user identity.User) (Preferences, error) {
	result := Preferences{Theme: "light", Locale: "ru", PushEnabled: true}
	var raw []byte
	if err := s.pool.QueryRow(ctx, `SELECT preferences FROM users WHERE org_id=$1 AND actor_id=$2`, user.OrgID, user.ActorID).Scan(&raw); err != nil {
		return result, err
	}
	_ = json.Unmarshal(raw, &result)
	if result.Theme == "" {
		result.Theme = "light"
	}
	if result.Locale == "" {
		result.Locale = "ru"
	}
	return result, nil
}
func (s *Service) UpdatePreferences(ctx context.Context, user identity.User, input UpdatePreferences) (Preferences, error) {
	if input.Theme == nil && input.Locale == nil && input.PushEnabled == nil && input.PushPreview == nil && !input.SnoozedUntil.Set {
		return Preferences{}, ErrInvalid
	}
	if input.Theme != nil && *input.Theme != "system" && *input.Theme != "light" && *input.Theme != "dark" {
		return Preferences{}, ErrInvalid
	}
	if input.Locale != nil && *input.Locale != "ru" && *input.Locale != "en" {
		return Preferences{}, ErrInvalid
	}
	if input.SnoozedUntil.Value != nil {
		now := time.Now()
		if !input.SnoozedUntil.Value.After(now) || input.SnoozedUntil.Value.After(now.AddDate(1, 0, 0)) {
			return Preferences{}, ErrInvalid
		}
	}
	payload := make(map[string]any, 5)
	if input.Theme != nil {
		payload["theme"] = *input.Theme
	}
	if input.Locale != nil {
		payload["locale"] = *input.Locale
	}
	if input.PushEnabled != nil {
		payload["push_enabled"] = *input.PushEnabled
	}
	if input.PushPreview != nil {
		payload["push_preview"] = *input.PushPreview
	}
	if input.SnoozedUntil.Set {
		payload["snoozed_until"] = input.SnoozedUntil.Value
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return Preferences{}, err
	}
	if _, err = s.pool.Exec(ctx, `UPDATE users SET preferences=preferences||$3::jsonb WHERE org_id=$1 AND actor_id=$2`, user.OrgID, user.ActorID, string(encoded)); err != nil {
		return Preferences{}, err
	}
	return s.GetPreferences(ctx, user)
}

func (s *Service) GetChatFolders(ctx context.Context, user identity.User) ([]ChatFolder, error) {
	result := []ChatFolder{}
	var raw []byte
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(preferences->'chat_folders','[]'::jsonb) FROM users WHERE org_id=$1 AND actor_id=$2`, user.OrgID, user.ActorID).Scan(&raw); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	for index := range result {
		if result[index].Color == "" {
			result[index].Color = "blue"
		}
	}
	return result, nil
}

func (s *Service) PutChatFolders(ctx context.Context, user identity.User, input []ChatFolder) ([]ChatFolder, error) {
	if !validChatFolders(input) {
		return nil, ErrInvalid
	}
	payload, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	_, err = s.pool.Exec(ctx, `UPDATE users SET preferences=jsonb_set(preferences,'{chat_folders}',$3::jsonb,true) WHERE org_id=$1 AND actor_id=$2`, user.OrgID, user.ActorID, string(payload))
	return input, err
}

func (s *Service) GetPinnedChats(ctx context.Context, user identity.User) ([]string, error) {
	result := []string{}
	var raw []byte
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(preferences->'pinned_chat_ids','[]'::jsonb) FROM users WHERE org_id=$1 AND actor_id=$2`, user.OrgID, user.ActorID).Scan(&raw); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) PutPinnedChats(ctx context.Context, user identity.User, input []string) ([]string, error) {
	if !validPinnedChats(input) {
		return nil, ErrInvalid
	}
	payload, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	_, err = s.pool.Exec(ctx, `UPDATE users SET preferences=jsonb_set(preferences,'{pinned_chat_ids}',$3::jsonb,true) WHERE org_id=$1 AND actor_id=$2`, user.OrgID, user.ActorID, string(payload))
	return input, err
}

func validChatFolders(folders []ChatFolder) bool {
	if len(folders) > 12 {
		return false
	}
	icons := map[string]bool{
		"folder": true, "briefcase": true, "heart": true, "star": true, "users": true, "hash": true,
		"bookmark": true, "home": true, "rocket": true, "zap": true, "flame": true, "sun": true,
		"moon": true, "cloud": true, "umbrella": true, "coffee": true, "music": true, "camera": true,
		"image": true, "gamepad": true, "dumbbell": true, "trophy": true, "target": true, "gift": true,
		"shopping-bag": true, "wallet": true, "plane": true, "car": true, "map": true, "globe": true,
		"book": true, "graduation": true, "code": true, "terminal": true, "database": true, "chart": true,
		"calendar": true, "clock": true, "check": true, "lightbulb": true, "palette": true, "smile": true,
		"bot": true, "cat": true, "dog": true, "leaf": true, "flower": true, "mountain": true,
		"waves": true, "party": true,
	}
	colors := map[string]bool{"blue": true, "violet": true, "pink": true, "red": true, "orange": true, "amber": true, "green": true, "teal": true, "cyan": true, "slate": true}
	seenFolders := make(map[string]bool, len(folders))
	for index := range folders {
		folder := &folders[index]
		folder.Name = strings.TrimSpace(folder.Name)
		if _, err := uuid.Parse(folder.ID); err != nil || seenFolders[folder.ID] || len([]rune(folder.Name)) < 1 || len([]rune(folder.Name)) > 40 || !icons[folder.Icon] || !colors[folder.Color] || len(folder.ChatIDs) > 200 {
			return false
		}
		seenFolders[folder.ID] = true
		seenChats := make(map[string]bool, len(folder.ChatIDs))
		for _, chatID := range folder.ChatIDs {
			if _, err := uuid.Parse(chatID); err != nil || seenChats[chatID] {
				return false
			}
			seenChats[chatID] = true
		}
	}
	return true
}

func validPinnedChats(chatIDs []string) bool {
	if len(chatIDs) > 10 {
		return false
	}
	seen := make(map[string]bool, len(chatIDs))
	for _, chatID := range chatIDs {
		if _, err := uuid.Parse(chatID); err != nil || seen[chatID] {
			return false
		}
		seen[chatID] = true
	}
	return true
}
func (s *Service) GetChatPreferences(ctx context.Context, user identity.User, chatID string) (ChatPreferences, error) {
	var result ChatPreferences
	err := s.pool.QueryRow(ctx, `SELECT notify_level,muted_until FROM chat_members WHERE org_id=$1 AND actor_id=$2 AND chat_id=$3`, user.OrgID, user.ActorID, chatID).Scan(&result.NotifyLevel, &result.MutedUntil)
	if errors.Is(err, pgx.ErrNoRows) {
		return ChatPreferences{}, ErrInvalid
	}
	return result, err
}
func (s *Service) UpdateChatPreferences(ctx context.Context, user identity.User, chatID string, input ChatPreferences) (ChatPreferences, error) {
	if input.NotifyLevel != "all" && input.NotifyLevel != "mentions" && input.NotifyLevel != "none" {
		return ChatPreferences{}, ErrInvalid
	}
	err := s.pool.QueryRow(ctx, `UPDATE chat_members SET notify_level=$4,muted_until=$5 WHERE org_id=$1 AND actor_id=$2 AND chat_id=$3 RETURNING notify_level,muted_until`, user.OrgID, user.ActorID, chatID, input.NotifyLevel, input.MutedUntil).Scan(&input.NotifyLevel, &input.MutedUntil)
	if errors.Is(err, pgx.ErrNoRows) {
		return ChatPreferences{}, ErrInvalid
	}
	return input, err
}

type ActiveCheck func(orgID, actorID, chatID string) bool
type Worker struct {
	logger *slog.Logger
	pool   *pgxpool.Pool
	config config.PushConfig
	active ActiveCheck
	client *http.Client
}

func NewWorker(logger *slog.Logger, pool *pgxpool.Pool, cfg config.PushConfig, active ActiveCheck) *Worker {
	return &Worker{logger: logger, pool: pool, config: cfg, active: active, client: &http.Client{Timeout: 10 * time.Second}}
}
func (w *Worker) Run(ctx context.Context) {
	if w.config.VAPIDPrivateKey == "" {
		w.logger.Info("web push disabled; VAPID keys are not configured")
		return
	}
	ticker := time.NewTicker(w.config.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.tick(ctx); err != nil {
				w.logger.Warn("web push worker tick failed", "error", err)
			}
		}
	}
}
func (w *Worker) tick(ctx context.Context) error {
	if err := w.materialize(ctx); err != nil {
		return err
	}
	return w.deliver(ctx)
}
func (w *Worker) materialize(ctx context.Context) error {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT org_id,event_seq FROM notification_jobs WHERE available_at<=now() ORDER BY event_seq LIMIT 50 FOR UPDATE SKIP LOCKED`)
	if err != nil {
		return err
	}
	type job struct {
		org string
		seq int64
	}
	jobs := []job{}
	for rows.Next() {
		var j job
		if err := rows.Scan(&j.org, &j.seq); err != nil {
			return err
		}
		jobs = append(jobs, j)
	}
	rows.Close()
	for _, j := range jobs {
		_, err = tx.Exec(ctx, `INSERT INTO notification_deliveries(org_id,event_seq,subscription_id) SELECT e.org_id,e.seq,s.id FROM events e JOIN messages m ON m.org_id=e.org_id AND m.id=e.subject_id JOIN chat_members cm ON cm.org_id=e.org_id AND cm.chat_id=e.chat_id JOIN web_push_subscriptions s ON s.org_id=cm.org_id AND s.actor_id=cm.actor_id JOIN users u ON u.org_id=cm.org_id AND u.actor_id=cm.actor_id WHERE e.org_id=$1 AND e.seq=$2 AND e.type='message.created' AND cm.actor_id<>e.actor_id AND (cm.muted_until IS NULL OR cm.muted_until<=now()) AND COALESCE((u.preferences->>'push_enabled')::boolean,true) AND (NULLIF(u.preferences->>'snoozed_until','') IS NULL OR (u.preferences->>'snoozed_until')::timestamptz<=now()) AND (cm.notify_level='all' OR (cm.notify_level='mentions' AND cm.actor_id=ANY(m.mentioned_actor_ids))) ON CONFLICT DO NOTHING`, j.org, j.seq)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM notification_jobs WHERE org_id=$1 AND event_seq=$2`, j.org, j.seq); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func (w *Worker) deliver(ctx context.Context) error {
	leaseToken, err := id.New()
	if err != nil {
		return err
	}
	_, err = w.pool.Exec(ctx, `WITH candidates AS (
		SELECT org_id,event_seq,subscription_id FROM notification_deliveries
		WHERE sent_at IS NULL AND available_at<=now() AND (lease_until IS NULL OR lease_until<now())
		ORDER BY event_seq LIMIT 50 FOR UPDATE SKIP LOCKED
	) UPDATE notification_deliveries d SET lease_token=$1,lease_until=now()+interval '30 seconds'
	FROM candidates c WHERE d.org_id=c.org_id AND d.event_seq=c.event_seq AND d.subscription_id=c.subscription_id`, leaseToken)
	if err != nil {
		return err
	}
	rows, err := w.pool.Query(ctx, `SELECT d.org_id,d.event_seq,d.subscription_id,s.actor_id,s.endpoint,s.p256dh,s.auth,e.chat_id,m.thread_root_id,m.body,c.name,a.display_name,COALESCE((u.preferences->>'push_preview')::boolean,false),COALESCE(u.preferences->>'locale','ru') FROM notification_deliveries d JOIN web_push_subscriptions s ON s.id=d.subscription_id JOIN events e ON e.org_id=d.org_id AND e.seq=d.event_seq JOIN messages m ON m.org_id=e.org_id AND m.id=e.subject_id JOIN chats c ON c.org_id=m.org_id AND c.id=m.chat_id JOIN actors a ON a.org_id=m.org_id AND a.id=m.actor_id JOIN users u ON u.org_id=s.org_id AND u.actor_id=s.actor_id WHERE d.lease_token=$1 ORDER BY d.event_seq`, leaseToken)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var org, subID, actor, endpoint, p256dh, auth, chatID, body, author, locale string
		var seq int64
		var threadID, name *string
		var preview bool
		if err := rows.Scan(&org, &seq, &subID, &actor, &endpoint, &p256dh, &auth, &chatID, &threadID, &body, &name, &author, &preview, &locale); err != nil {
			return err
		}
		if w.active != nil && w.active(org, actor, chatID) {
			_, _ = w.pool.Exec(ctx, `UPDATE notification_deliveries SET sent_at=now(),last_error='suppressed_active',lease_token=NULL,lease_until=NULL WHERE org_id=$1 AND event_seq=$2 AND subscription_id=$3 AND lease_token=$4`, org, seq, subID, leaseToken)
			continue
		}
		title := author
		if name != nil && *name != "" {
			title += " · " + *name
		}
		genericBody := "Новое сообщение"
		if locale == "en" {
			genericBody = "New message"
		}
		payload := map[string]any{"title": title, "body": genericBody, "chat_id": chatID, "url": "/chat/" + chatID}
		if preview {
			payload["body"] = truncate(body, 180)
		}
		if threadID != nil {
			payload["url"] = "/chat/" + chatID + "/thread/" + *threadID
		}
		encoded, _ := json.Marshal(payload)
		response, sendErr := webpush.SendNotificationWithContext(ctx, encoded, &webpush.Subscription{Endpoint: endpoint, Keys: webpush.Keys{P256dh: p256dh, Auth: auth}}, &webpush.Options{Subscriber: w.config.VAPIDSubject, VAPIDPublicKey: w.config.VAPIDPublicKey, VAPIDPrivateKey: w.config.VAPIDPrivateKey, TTL: 120})
		if response != nil {
			response.Body.Close()
		}
		if sendErr == nil && response != nil && response.StatusCode >= 200 && response.StatusCode < 300 {
			_, _ = w.pool.Exec(ctx, `UPDATE notification_deliveries SET sent_at=now(),attempts=attempts+1,last_error=NULL,lease_token=NULL,lease_until=NULL WHERE org_id=$1 AND event_seq=$2 AND subscription_id=$3 AND lease_token=$4`, org, seq, subID, leaseToken)
			continue
		}
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		if status == http.StatusNotFound || status == http.StatusGone {
			_, _ = w.pool.Exec(ctx, `DELETE FROM web_push_subscriptions WHERE id=$1`, subID)
			continue
		}
		message := fmt.Sprint(sendErr)
		_, _ = w.pool.Exec(ctx, `UPDATE notification_deliveries SET attempts=attempts+1,last_error=$4,available_at=now()+LEAST(interval '1 hour',interval '5 seconds'*power(2,LEAST(attempts,8))),lease_token=NULL,lease_until=NULL WHERE org_id=$1 AND event_seq=$2 AND subscription_id=$3 AND lease_token=$5`, org, seq, subID, message, leaseToken)
	}
	return rows.Err()
}
func truncate(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max]) + "…"
}

func GenerateVAPIDKeys() (string, string, error) {
	privateKey, publicKey, err := webpush.GenerateVAPIDKeys()
	return publicKey, privateKey, err
}
