package interactive

import (
	"testing"
	"time"
)

func TestQuietHoursUseRecipientTimezone(t *testing.T) {
	service := &Service{limits: DefaultLimits()}
	// 19:30 UTC is 22:30 in Moscow: inside the 21:00-08:00 window.
	now := time.Date(2026, 11, 10, 19, 30, 0, 0, time.UTC)
	quiet, ends := service.inQuietHours(now, "Europe/Moscow")
	if !quiet || !ends.Equal(time.Date(2026, 11, 11, 5, 0, 0, 0, time.UTC)) {
		t.Fatalf("Moscow quiet=%v ends=%s", quiet, ends)
	}
	if quiet, _ := service.inQuietHours(now, "UTC"); quiet {
		t.Fatal("19:30 UTC must not be quiet in UTC")
	}
	early := time.Date(2026, 11, 10, 3, 0, 0, 0, time.UTC)
	if quiet, ends := service.inQuietHours(early, "UTC"); !quiet || !ends.Equal(time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)) {
		t.Fatalf("early morning quiet=%v ends=%s", quiet, ends)
	}
	service.limits.QuietStartMinute, service.limits.QuietEndMinute = 0, 0
	if quiet, _ := service.inQuietHours(now, "Europe/Moscow"); quiet {
		t.Fatal("equal bounds must disable quiet hours")
	}
}
