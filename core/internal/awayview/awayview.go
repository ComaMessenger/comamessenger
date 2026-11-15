// Package awayview is the read side of «Отсутствую» (phase 6.7 wave 4)
// shared by every package that shows people: identity, chat, workspace,
// orgstructure. It has no dependencies, so those packages can use it
// without importing package away.
//
// Readers use the SQL functions of migration 00062 directly:
//   - actor_away_public(org, actor, now()) is the AwayPublic everyone in the
//     workspace sees, as jsonb (NULL without one); scan it into *Public. It
//     never carries the auto-reply text, mute_push or a substitute others
//     must not see.
//   - actor_shown_status_emoji / _text / _expires_at(org, actor, now(), own)
//     are what others see as the custom status of a person: the away status
//     while it is active (decision 12, so older clients show it), otherwise
//     own — the custom status the reader computed. getMe never uses them:
//     the person sees their own custom status.
package awayview

import "time"

// Public is AwayPublic (packages/protocol, realtime schema $defs/AwayPublic).
type Public struct {
	Kind             string    `json:"kind"`
	Label            string    `json:"label"`
	StartsAt         time.Time `json:"starts_at"`
	EndsAt           time.Time `json:"ends_at"`
	Active           bool      `json:"active"`
	SubstituteID     *string   `json:"substitute_id"`
	NotificationsOff bool      `json:"notifications_off"`
}

// ActiveNow is a condition true while the person's away status is active,
// for filters such as presence=away on the list of people. org and actor
// are SQL expressions.
func ActiveNow(org, actor string) string {
	return "EXISTS (SELECT 1 FROM actor_away awn JOIN actors awa ON awa.org_id=awn.org_id AND awa.id=awn.actor_id AND awa.status='active' AND awa.deleted_at IS NULL WHERE awn.org_id=" + org + " AND awn.actor_id=" + actor + " AND awn.starts_at<=now() AND awn.ends_at>now())"
}
