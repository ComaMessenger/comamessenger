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
var ErrUnavailable = errors.New("web push is not configured")

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
type SubscriptionInfo struct {
	ID        string    `json:"id"`
	UserAgent string    `json:"user_agent"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Current   bool      `json:"current"`
}
type TestResult struct {
	Sent   int `json:"sent"`
	Failed int `json:"failed"`
}
type Preferences struct {
	Theme           string                `json:"theme"`
	Locale          string                `json:"locale"`
	InAppEnabled    bool                  `json:"in_app_enabled"`
	PushEnabled     bool                  `json:"push_enabled"`
	PushPreview     bool                  `json:"push_preview"`
	NotifyMessages  string                `json:"notify_messages"`
	NotifyThreads   string                `json:"notify_threads"`
	NotifyReactions bool                  `json:"notify_reactions"`
	NotifyInvites   bool                  `json:"notify_invites"`
	NotifySystem    bool                  `json:"notify_system"`
	SoundEnabled    bool                  `json:"sound_enabled"`
	SoundID         string                `json:"sound_id"`
	Schedule        *NotificationSchedule `json:"schedule"`
	SnoozedUntil    *time.Time            `json:"snoozed_until"`
	EmailDigest     bool                  `json:"email_digest"`
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
	Theme           *string          `json:"theme"`
	Locale          *string          `json:"locale"`
	InAppEnabled    *bool            `json:"in_app_enabled"`
	PushEnabled     *bool            `json:"push_enabled"`
	PushPreview     *bool            `json:"push_preview"`
	NotifyMessages  *string          `json:"notify_messages"`
	NotifyThreads   *string          `json:"notify_threads"`
	NotifyReactions *bool            `json:"notify_reactions"`
	NotifyInvites   *bool            `json:"notify_invites"`
	NotifySystem    *bool            `json:"notify_system"`
	SoundEnabled    *bool            `json:"sound_enabled"`
	SoundID         *string          `json:"sound_id"`
	Schedule        OptionalSchedule `json:"schedule"`
	SnoozedUntil    OptionalTime     `json:"snoozed_until"`
	EmailDigest     *bool            `json:"email_digest"`
}
type NotificationSchedule struct {
	Days any    `json:"days"`
	From string `json:"from"`
	To   string `json:"to"`
}
type OptionalSchedule struct {
	Set   bool
	Value *NotificationSchedule
}

func (value *OptionalSchedule) UnmarshalJSON(data []byte) error {
	value.Set = true
	if string(data) == "null" {
		value.Value = nil
		return nil
	}
	var parsed NotificationSchedule
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	value.Value = &parsed
	return nil
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
type ChatOverride struct {
	ChatID      string     `json:"chat_id"`
	Name        string     `json:"name"`
	Kind        string     `json:"kind"`
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
func (s *Service) ListSubscriptions(ctx context.Context, user identity.User, currentSessionID string) ([]SubscriptionInfo, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,user_agent,created_at,updated_at,session_id=$3 FROM web_push_subscriptions WHERE org_id=$1 AND actor_id=$2 ORDER BY updated_at DESC,id`, user.OrgID, user.ActorID, currentSessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []SubscriptionInfo{}
	for rows.Next() {
		var item SubscriptionInfo
		if err := rows.Scan(&item.ID, &item.UserAgent, &item.CreatedAt, &item.UpdatedAt, &item.Current); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}
func (s *Service) Test(ctx context.Context, user identity.User) (TestResult, error) {
	if s.config.VAPIDPublicKey == "" || s.config.VAPIDPrivateKey == "" {
		return TestResult{}, ErrUnavailable
	}
	rows, err := s.pool.Query(ctx, `SELECT id,endpoint,p256dh,auth FROM web_push_subscriptions WHERE org_id=$1 AND actor_id=$2 ORDER BY id`, user.OrgID, user.ActorID)
	if err != nil {
		return TestResult{}, err
	}
	type target struct{ id, endpoint, p256dh, auth string }
	targets := []target{}
	for rows.Next() {
		var item target
		if err := rows.Scan(&item.id, &item.endpoint, &item.p256dh, &item.auth); err != nil {
			rows.Close()
			return TestResult{}, err
		}
		targets = append(targets, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return TestResult{}, err
	}
	if len(targets) == 0 {
		return TestResult{}, ErrInvalid
	}
	payload, _ := json.Marshal(map[string]any{
		"title": "Coma", "body": "Test notification", "url": "/settings/notifications",
	})
	result := TestResult{}
	for _, item := range targets {
		response, sendErr := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{
			Endpoint: item.endpoint, Keys: webpush.Keys{P256dh: item.p256dh, Auth: item.auth},
		}, &webpush.Options{
			Subscriber: s.config.VAPIDSubject, VAPIDPublicKey: s.config.VAPIDPublicKey,
			VAPIDPrivateKey: s.config.VAPIDPrivateKey, TTL: 120,
		})
		status := 0
		if response != nil {
			status = response.StatusCode
			response.Body.Close()
		}
		if sendErr == nil && status >= 200 && status < 300 {
			result.Sent++
			continue
		}
		result.Failed++
		if status == http.StatusNotFound || status == http.StatusGone {
			_, _ = s.pool.Exec(ctx, `DELETE FROM web_push_subscriptions WHERE id=$1 AND org_id=$2 AND actor_id=$3`, item.id, user.OrgID, user.ActorID)
		}
	}
	return result, nil
}
func (s *Service) GetPreferences(ctx context.Context, user identity.User) (Preferences, error) {
	result := Preferences{
		Theme: "light", Locale: "ru", InAppEnabled: true, PushEnabled: true,
		NotifyMessages: "all", NotifyThreads: "all",
		NotifyReactions: true, NotifyInvites: true, NotifySystem: true,
		SoundEnabled: true, SoundID: "default",
	}
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
	if result.NotifyMessages == "" {
		result.NotifyMessages = "all"
	}
	if result.NotifyThreads == "" {
		result.NotifyThreads = "all"
	}
	if result.SoundID == "" {
		result.SoundID = "default"
	}
	// Boolean defaults for rows created before notification preferences existed.
	var stored map[string]json.RawMessage
	if json.Unmarshal(raw, &stored) == nil {
		if _, ok := stored["in_app_enabled"]; !ok {
			result.InAppEnabled = true
		}
		if _, ok := stored["notify_reactions"]; !ok {
			result.NotifyReactions = true
		}
		if _, ok := stored["notify_invites"]; !ok {
			result.NotifyInvites = true
		}
		if _, ok := stored["notify_system"]; !ok {
			result.NotifySystem = true
		}
		if _, ok := stored["sound_enabled"]; !ok {
			result.SoundEnabled = true
		}
	}
	return result, nil
}
func (s *Service) UpdatePreferences(ctx context.Context, user identity.User, input UpdatePreferences) (Preferences, error) {
	if input.empty() {
		return Preferences{}, ErrInvalid
	}
	if input.Theme != nil && *input.Theme != "system" && *input.Theme != "light" && *input.Theme != "dark" {
		return Preferences{}, ErrInvalid
	}
	if input.Locale != nil && *input.Locale != "ru" && *input.Locale != "en" {
		return Preferences{}, ErrInvalid
	}
	if input.NotifyMessages != nil && *input.NotifyMessages != "all" && *input.NotifyMessages != "direct_and_mentions" && *input.NotifyMessages != "none" {
		return Preferences{}, ErrInvalid
	}
	if input.NotifyThreads != nil && *input.NotifyThreads != "all" && *input.NotifyThreads != "mentions" && *input.NotifyThreads != "none" {
		return Preferences{}, ErrInvalid
	}
	if input.SoundID != nil && *input.SoundID != "default" {
		return Preferences{}, ErrInvalid
	}
	if input.Schedule.Value != nil && !validSchedule(*input.Schedule.Value) {
		return Preferences{}, ErrInvalid
	}
	if input.SnoozedUntil.Value != nil {
		now := time.Now()
		if !input.SnoozedUntil.Value.After(now) || input.SnoozedUntil.Value.After(now.AddDate(1, 0, 0)) {
			return Preferences{}, ErrInvalid
		}
	}
	payload := make(map[string]any, 15)
	if input.Theme != nil {
		payload["theme"] = *input.Theme
	}
	if input.Locale != nil {
		payload["locale"] = *input.Locale
	}
	if input.InAppEnabled != nil {
		payload["in_app_enabled"] = *input.InAppEnabled
	}
	if input.PushEnabled != nil {
		payload["push_enabled"] = *input.PushEnabled
	}
	if input.PushPreview != nil {
		payload["push_preview"] = *input.PushPreview
	}
	if input.NotifyMessages != nil {
		payload["notify_messages"] = *input.NotifyMessages
	}
	if input.NotifyThreads != nil {
		payload["notify_threads"] = *input.NotifyThreads
	}
	if input.NotifyReactions != nil {
		payload["notify_reactions"] = *input.NotifyReactions
	}
	if input.NotifyInvites != nil {
		payload["notify_invites"] = *input.NotifyInvites
	}
	if input.NotifySystem != nil {
		payload["notify_system"] = *input.NotifySystem
	}
	if input.SoundEnabled != nil {
		payload["sound_enabled"] = *input.SoundEnabled
	}
	if input.SoundID != nil {
		payload["sound_id"] = *input.SoundID
	}
	if input.Schedule.Set {
		payload["schedule"] = input.Schedule.Value
	}
	if input.SnoozedUntil.Set {
		payload["snoozed_until"] = input.SnoozedUntil.Value
	}
	if input.EmailDigest != nil {
		payload["email_digest"] = *input.EmailDigest
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return Preferences{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Preferences{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE users SET preferences=preferences||$3::jsonb WHERE org_id=$1 AND actor_id=$2`, user.OrgID, user.ActorID, string(encoded)); err != nil {
		return Preferences{}, err
	}
	if input.SnoozedUntil.Set {
		if input.SnoozedUntil.Value == nil {
			if _, err = tx.Exec(ctx, `UPDATE notification_snoozes SET ends_at=GREATEST(now(),starts_at+interval '1 microsecond') WHERE org_id=$1 AND actor_id=$2 AND starts_at<=now() AND ends_at>now()`, user.OrgID, user.ActorID); err != nil {
				return Preferences{}, err
			}
		} else {
			command, updateErr := tx.Exec(ctx, `UPDATE notification_snoozes SET ends_at=$3 WHERE org_id=$1 AND actor_id=$2 AND starts_at<=now() AND ends_at>now()`, user.OrgID, user.ActorID, *input.SnoozedUntil.Value)
			if updateErr != nil {
				return Preferences{}, updateErr
			}
			if command.RowsAffected() == 0 {
				if _, err = tx.Exec(ctx, `INSERT INTO notification_snoozes(org_id,actor_id,starts_at,ends_at) VALUES($1,$2,now(),$3)`, user.OrgID, user.ActorID, *input.SnoozedUntil.Value); err != nil {
					return Preferences{}, err
				}
			}
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Preferences{}, err
	}
	return s.GetPreferences(ctx, user)
}

func (input UpdatePreferences) empty() bool {
	return input.Theme == nil && input.Locale == nil && input.InAppEnabled == nil && input.PushEnabled == nil && input.PushPreview == nil &&
		input.NotifyMessages == nil && input.NotifyThreads == nil && input.NotifyReactions == nil && input.NotifyInvites == nil &&
		input.NotifySystem == nil && input.SoundEnabled == nil && input.SoundID == nil && !input.Schedule.Set &&
		!input.SnoozedUntil.Set && input.EmailDigest == nil
}

func validSchedule(schedule NotificationSchedule) bool {
	if !validClock(schedule.From) || !validClock(schedule.To) {
		return false
	}
	switch days := schedule.Days.(type) {
	case string:
		return days == "all" || days == "weekdays"
	case []any:
		if len(days) == 0 || len(days) > 7 {
			return false
		}
		seen := map[int]bool{}
		for _, raw := range days {
			value, ok := raw.(float64)
			day := int(value)
			if !ok || value != float64(day) || day < 0 || day > 6 || seen[day] {
				return false
			}
			seen[day] = true
		}
		return true
	default:
		return false
	}
}

func validClock(value string) bool {
	if len(value) != 5 || value[2] != ':' {
		return false
	}
	hour := int(value[0]-'0')*10 + int(value[1]-'0')
	minute := int(value[3]-'0')*10 + int(value[4]-'0')
	return value[0] >= '0' && value[0] <= '9' && value[1] >= '0' && value[1] <= '9' && value[3] >= '0' && value[3] <= '9' && value[4] >= '0' && value[4] <= '9' && hour < 24 && minute < 60
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
	if input.NotifyLevel != "default" && input.NotifyLevel != "all" && input.NotifyLevel != "mentions" && input.NotifyLevel != "none" {
		return ChatPreferences{}, ErrInvalid
	}
	err := s.pool.QueryRow(ctx, `UPDATE chat_members SET notify_level=$4,muted_until=$5 WHERE org_id=$1 AND actor_id=$2 AND chat_id=$3 RETURNING notify_level,muted_until`, user.OrgID, user.ActorID, chatID, input.NotifyLevel, input.MutedUntil).Scan(&input.NotifyLevel, &input.MutedUntil)
	if errors.Is(err, pgx.ErrNoRows) {
		return ChatPreferences{}, ErrInvalid
	}
	return input, err
}

func (s *Service) ResetChatPreferences(ctx context.Context, user identity.User, chatID string) (ChatPreferences, error) {
	return s.UpdateChatPreferences(ctx, user, chatID, ChatPreferences{NotifyLevel: "default"})
}

func (s *Service) ListChatOverrides(ctx context.Context, user identity.User) ([]ChatOverride, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.id,
		       COALESCE(c.name,peer.display_name,'Direct chat'),
		       c.kind,cm.notify_level,cm.muted_until
		FROM chat_members cm
		JOIN chats c ON c.org_id=cm.org_id AND c.id=cm.chat_id
		LEFT JOIN LATERAL (
		  SELECT a.display_name
		  FROM chat_members other
		  JOIN actors a ON a.org_id=other.org_id AND a.id=other.actor_id
		  WHERE other.org_id=cm.org_id AND other.chat_id=cm.chat_id AND other.actor_id<>cm.actor_id
		  ORDER BY a.display_name LIMIT 1
		) peer ON c.kind='direct'
		WHERE cm.org_id=$1 AND cm.actor_id=$2
		  AND (cm.notify_level<>'default' OR (cm.muted_until IS NOT NULL AND cm.muted_until>now()))
		ORDER BY COALESCE(c.name,peer.display_name,'Direct chat'),c.id`, user.OrgID, user.ActorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []ChatOverride{}
	for rows.Next() {
		var item ChatOverride
		if err := rows.Scan(&item.ChatID, &item.Name, &item.Kind, &item.NotifyLevel, &item.MutedUntil); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

type ActiveCheck func(orgID, actorID, chatID string) bool
type EmailSender interface {
	EmailConfigured(context.Context, string) (bool, error)
	SendEmail(context.Context, string, string, string, string) error
}
type Worker struct {
	logger      *slog.Logger
	pool        *pgxpool.Pool
	config      config.PushConfig
	active      ActiveCheck
	emailSender EmailSender
	client      *http.Client
}

func NewWorker(logger *slog.Logger, pool *pgxpool.Pool, cfg config.PushConfig, active ActiveCheck, emailSenders ...EmailSender) *Worker {
	var emailSender EmailSender
	if len(emailSenders) > 0 {
		emailSender = emailSenders[0]
	}
	return &Worker{logger: logger, pool: pool, config: cfg, active: active, emailSender: emailSender, client: &http.Client{Timeout: 10 * time.Second}}
}
func (w *Worker) Run(ctx context.Context) {
	if w.config.VAPIDPrivateKey == "" {
		w.logger.Info("web push disabled; VAPID keys are not configured")
	}
	if w.config.VAPIDPrivateKey == "" && w.emailSender == nil {
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
	if w.config.VAPIDPrivateKey != "" {
		if err := w.deliver(ctx); err != nil {
			return err
		}
	}
	if w.emailSender != nil {
		return w.deliverDigests(ctx)
	}
	return nil
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
		_, err = tx.Exec(ctx, `
			WITH event AS (
			  SELECT * FROM events WHERE org_id=$1 AND seq=$2
			), recipients AS (
			  SELECT cm.actor_id AS recipient_id,cm.notify_level,cm.muted_until,c.kind,m.mentioned_actor_ids,m.thread_root_id,'message'::text AS category
			  FROM event e JOIN messages m ON m.org_id=e.org_id AND m.id=e.subject_id
			  JOIN chats c ON c.org_id=m.org_id AND c.id=m.chat_id
			  JOIN chat_members cm ON cm.org_id=e.org_id AND cm.chat_id=e.chat_id
			  WHERE e.type='message.created' AND cm.actor_id<>e.actor_id
			  UNION ALL
			  SELECT m.actor_id,'default',NULL,c.kind,'{}'::uuid[],NULL::uuid,'reaction'
			  FROM event e JOIN messages m ON m.org_id=e.org_id AND m.id=e.subject_id
			  JOIN chats c ON c.org_id=m.org_id AND c.id=m.chat_id
			  WHERE e.type='reaction.added' AND m.actor_id<>e.actor_id
			  UNION ALL
			  SELECT (e.data->>'actor_id')::uuid,'default',NULL,c.kind,'{}'::uuid[],NULL::uuid,
			    CASE WHEN e.type='member.joined' THEN 'invite' ELSE 'system' END
			  FROM event e JOIN chats c ON c.org_id=e.org_id AND c.id=e.chat_id
			  WHERE e.type IN ('member.joined','member.updated','member.removed')
			    AND e.data ? 'actor_id' AND (e.data->>'actor_id')::uuid<>e.actor_id
			), eligible AS (
			SELECT e.org_id,e.seq,e.occurred_at,r.*,u.preferences
			FROM event e JOIN recipients r ON true
			JOIN users u ON u.org_id=e.org_id AND u.actor_id=r.recipient_id
			JOIN actors recipient ON recipient.org_id=e.org_id AND recipient.id=r.recipient_id
			WHERE (r.muted_until IS NULL OR r.muted_until<=e.occurred_at)
			  AND NOT EXISTS (
			    SELECT 1 FROM notification_snoozes ns
			    WHERE ns.org_id=e.org_id AND ns.actor_id=r.recipient_id
			      AND e.occurred_at>=ns.starts_at AND e.occurred_at<ns.ends_at
			  )
			  AND CASE r.category
			    WHEN 'reaction' THEN COALESCE((u.preferences->>'notify_reactions')::boolean,true)
			    WHEN 'invite' THEN COALESCE((u.preferences->>'notify_invites')::boolean,true)
			    WHEN 'system' THEN COALESCE((u.preferences->>'notify_system')::boolean,true)
			    ELSE CASE r.notify_level
			      WHEN 'all' THEN true
			      WHEN 'mentions' THEN r.recipient_id=ANY(r.mentioned_actor_ids)
			      WHEN 'none' THEN false
			      ELSE CASE COALESCE(u.preferences->>'notify_messages','all')
			        WHEN 'all' THEN true
			        WHEN 'direct_and_mentions' THEN r.kind='direct' OR r.recipient_id=ANY(r.mentioned_actor_ids)
			        ELSE false
			      END
			      AND (r.thread_root_id IS NULL OR CASE COALESCE(u.preferences->>'notify_threads','all')
			        WHEN 'all' THEN true
			        WHEN 'mentions' THEN r.recipient_id=ANY(r.mentioned_actor_ids)
			        ELSE false
			      END)
			    END
			  END
			  AND (
			    u.preferences->'schedule' IS NULL OR jsonb_typeof(u.preferences->'schedule')='null' OR (
			      CASE
			        WHEN u.preferences#>>'{schedule,from}' = u.preferences#>>'{schedule,to}' THEN true
			        WHEN u.preferences#>>'{schedule,from}' < u.preferences#>>'{schedule,to}'
			          THEN to_char(timezone(COALESCE(NULLIF(recipient.timezone,''),'UTC'),e.occurred_at),'HH24:MI') >= u.preferences#>>'{schedule,from}'
			           AND to_char(timezone(COALESCE(NULLIF(recipient.timezone,''),'UTC'),e.occurred_at),'HH24:MI') < u.preferences#>>'{schedule,to}'
			        ELSE to_char(timezone(COALESCE(NULLIF(recipient.timezone,''),'UTC'),e.occurred_at),'HH24:MI') >= u.preferences#>>'{schedule,from}'
			          OR to_char(timezone(COALESCE(NULLIF(recipient.timezone,''),'UTC'),e.occurred_at),'HH24:MI') < u.preferences#>>'{schedule,to}'
			      END
			      AND (
			        u.preferences#>>'{schedule,days}'='all'
			        OR (u.preferences#>>'{schedule,days}'='weekdays' AND extract(isodow FROM timezone(COALESCE(NULLIF(recipient.timezone,''),'UTC'),e.occurred_at)) BETWEEN 1 AND 5)
			        OR (jsonb_typeof(u.preferences#>'{schedule,days}')='array' AND EXISTS (
			          SELECT 1 FROM jsonb_array_elements_text(u.preferences#>'{schedule,days}') configured(day)
			          WHERE configured.day::int=extract(dow FROM timezone(COALESCE(NULLIF(recipient.timezone,''),'UTC'),e.occurred_at))::int
			        ))
			      )
			    )
			  )
			), email_items AS (
			  INSERT INTO email_digest_items(org_id,event_seq,actor_id,available_at)
			  SELECT org_id,seq,recipient_id,occurred_at+interval '15 minutes'
			  FROM eligible
			  WHERE COALESCE((preferences->>'email_digest')::boolean,false)
			  ON CONFLICT DO NOTHING
			  RETURNING 1
			)
			INSERT INTO notification_deliveries(org_id,event_seq,subscription_id)
			SELECT e.org_id,e.seq,s.id
			FROM eligible e
			JOIN web_push_subscriptions s ON s.org_id=e.org_id AND s.actor_id=e.recipient_id
			WHERE COALESCE((e.preferences->>'push_enabled')::boolean,true)
			ON CONFLICT DO NOTHING`, j.org, j.seq)
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
	rows, err := w.pool.Query(ctx, `SELECT d.org_id,d.event_seq,d.subscription_id,s.actor_id,s.endpoint,s.p256dh,s.auth,e.type,e.data,e.chat_id,m.thread_root_id,m.body,c.name,a.display_name,COALESCE((u.preferences->>'push_preview')::boolean,false),COALESCE(u.preferences->>'locale','ru') FROM notification_deliveries d JOIN web_push_subscriptions s ON s.id=d.subscription_id JOIN events e ON e.org_id=d.org_id AND e.seq=d.event_seq LEFT JOIN messages m ON m.org_id=e.org_id AND m.id=e.subject_id LEFT JOIN chats c ON c.org_id=e.org_id AND c.id=e.chat_id JOIN actors a ON a.org_id=e.org_id AND a.id=e.actor_id JOIN users u ON u.org_id=s.org_id AND u.actor_id=s.actor_id WHERE d.lease_token=$1 ORDER BY d.event_seq`, leaseToken)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var org, subID, actor, endpoint, p256dh, auth, eventType, author, locale string
		var seq int64
		var chatID, threadID, body, name *string
		var eventData []byte
		var preview bool
		if err := rows.Scan(&org, &seq, &subID, &actor, &endpoint, &p256dh, &auth, &eventType, &eventData, &chatID, &threadID, &body, &name, &author, &preview, &locale); err != nil {
			return err
		}
		if chatID != nil && w.active != nil && w.active(org, actor, *chatID) {
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
		payload := map[string]any{"title": title, "body": genericBody}
		if chatID != nil {
			payload["chat_id"] = *chatID
			payload["url"] = "/chat/" + *chatID
		}
		if eventType == "message.created" && preview && body != nil {
			payload["body"] = truncate(*body, 180)
		} else if eventType != "message.created" {
			payload["body"] = categoryBody(eventType, eventData, author, locale)
		}
		if threadID != nil && chatID != nil {
			payload["url"] = "/chat/" + *chatID + "/thread/" + *threadID
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

type digestItem struct {
	orgID, actorID, email, locale, eventType, author string
	seq                                              int64
	eventData                                        []byte
	chatID, body, chatName                           *string
	preview                                          bool
}

func (w *Worker) deliverDigests(ctx context.Context) error {
	leaseToken, err := id.New()
	if err != nil {
		return err
	}
	_, err = w.pool.Exec(ctx, `WITH candidates AS (
		SELECT org_id,event_seq,actor_id FROM email_digest_items
		WHERE sent_at IS NULL AND available_at<=now() AND (lease_until IS NULL OR lease_until<now())
		ORDER BY available_at,event_seq LIMIT 200 FOR UPDATE SKIP LOCKED
	) UPDATE email_digest_items i SET lease_token=$1,lease_until=now()+interval '30 seconds'
	FROM candidates c WHERE i.org_id=c.org_id AND i.event_seq=c.event_seq AND i.actor_id=c.actor_id`, leaseToken)
	if err != nil {
		return err
	}
	rows, err := w.pool.Query(ctx, `
		SELECT i.org_id,i.event_seq,i.actor_id,u.email,COALESCE(u.preferences->>'locale','ru'),
		       e.type,e.data,e.chat_id,m.body,c.name,a.display_name,
		       COALESCE((u.preferences->>'push_preview')::boolean,false)
		FROM email_digest_items i
		JOIN users u ON u.org_id=i.org_id AND u.actor_id=i.actor_id
		JOIN events e ON e.org_id=i.org_id AND e.seq=i.event_seq
		JOIN actors a ON a.org_id=e.org_id AND a.id=e.actor_id
		LEFT JOIN messages m ON m.org_id=e.org_id AND m.id=e.subject_id
		LEFT JOIN chats c ON c.org_id=e.org_id AND c.id=e.chat_id
		WHERE i.lease_token=$1 ORDER BY i.org_id,i.actor_id,i.event_seq`, leaseToken)
	if err != nil {
		return err
	}
	items := []digestItem{}
	for rows.Next() {
		var item digestItem
		if err := rows.Scan(&item.orgID, &item.seq, &item.actorID, &item.email, &item.locale, &item.eventType, &item.eventData, &item.chatID, &item.body, &item.chatName, &item.author, &item.preview); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	groups := map[string][]digestItem{}
	for _, item := range items {
		if item.chatID != nil && w.active != nil && w.active(item.orgID, item.actorID, *item.chatID) {
			_, _ = w.pool.Exec(ctx, `UPDATE email_digest_items SET sent_at=now(),last_error='suppressed_active',lease_token=NULL,lease_until=NULL WHERE org_id=$1 AND event_seq=$2 AND actor_id=$3 AND lease_token=$4`, item.orgID, item.seq, item.actorID, leaseToken)
			continue
		}
		groups[item.orgID+":"+item.actorID] = append(groups[item.orgID+":"+item.actorID], item)
	}
	for _, group := range groups {
		configured, checkErr := w.emailSender.EmailConfigured(ctx, group[0].orgID)
		if checkErr != nil {
			w.retryDigest(ctx, leaseToken, group, checkErr)
			continue
		}
		if !configured {
			_, _ = w.pool.Exec(ctx, `UPDATE email_digest_items SET sent_at=now(),last_error='smtp_unavailable',lease_token=NULL,lease_until=NULL WHERE org_id=$1 AND actor_id=$2 AND lease_token=$3`, group[0].orgID, group[0].actorID, leaseToken)
			continue
		}
		subject, body := digestMessage(group)
		if sendErr := w.emailSender.SendEmail(ctx, group[0].orgID, group[0].email, subject, body); sendErr != nil {
			w.retryDigest(ctx, leaseToken, group, sendErr)
			continue
		}
		_, _ = w.pool.Exec(ctx, `UPDATE email_digest_items SET sent_at=now(),attempts=attempts+1,last_error=NULL,lease_token=NULL,lease_until=NULL WHERE org_id=$1 AND actor_id=$2 AND lease_token=$3`, group[0].orgID, group[0].actorID, leaseToken)
	}
	return nil
}

func (w *Worker) retryDigest(ctx context.Context, leaseToken string, group []digestItem, sendErr error) {
	_, _ = w.pool.Exec(ctx, `UPDATE email_digest_items SET attempts=attempts+1,last_error=$4,available_at=now()+LEAST(interval '6 hours',interval '1 minute'*power(2,LEAST(attempts,8))),lease_token=NULL,lease_until=NULL WHERE org_id=$1 AND actor_id=$2 AND lease_token=$3`, group[0].orgID, group[0].actorID, leaseToken, sendErr.Error())
}

func digestMessage(items []digestItem) (string, string) {
	english := items[0].locale == "en"
	subject := fmt.Sprintf("ComaMessenger — %d notifications", len(items))
	heading := "Notifications you missed:"
	if !english {
		subject = fmt.Sprintf("ComaMessenger — %d уведомлений", len(items))
		heading = "Пропущенные уведомления:"
	}
	var body strings.Builder
	body.WriteString(heading)
	body.WriteString("\n\n")
	for _, item := range items {
		chatName := "Chat"
		if !english {
			chatName = "Чат"
		}
		if item.chatName != nil && *item.chatName != "" {
			chatName = *item.chatName
		}
		description := categoryBody(item.eventType, item.eventData, item.author, item.locale)
		if item.eventType == "message.created" {
			description = "New message"
			if !english {
				description = "Новое сообщение"
			}
			if item.preview && item.body != nil {
				description = truncate(*item.body, 180)
			}
		}
		fmt.Fprintf(&body, "• %s · %s: %s\n", item.author, chatName, description)
	}
	return subject, strings.TrimSpace(body.String())
}

func categoryBody(eventType string, raw []byte, author, locale string) string {
	data := map[string]any{}
	_ = json.Unmarshal(raw, &data)
	if locale == "en" {
		switch eventType {
		case "reaction.added":
			return fmt.Sprintf("%s reacted %v to your message", author, data["emoji"])
		case "member.joined":
			return fmt.Sprintf("%s added you to the chat", author)
		case "member.updated":
			return fmt.Sprintf("%s changed your chat role to %v", author, data["role"])
		default:
			return fmt.Sprintf("%s removed you from the chat", author)
		}
	}
	switch eventType {
	case "reaction.added":
		return fmt.Sprintf("%s отреагировал(а) %v на ваше сообщение", author, data["emoji"])
	case "member.joined":
		return fmt.Sprintf("%s добавил(а) вас в чат", author)
	case "member.updated":
		return fmt.Sprintf("%s изменил(а) вашу роль в чате на %v", author, data["role"])
	default:
		return fmt.Sprintf("%s удалил(а) вас из чата", author)
	}
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
