import type {
  Chat,
  DurableEvent,
  User,
  UserPreferences,
} from "@comamessenger/core";

let audioContext: AudioContext | null = null;

export function unlockNotificationSound(): void {
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) return;
  audioContext ??= new AudioContextClass();
  if (audioContext.state === "suspended") void audioContext.resume();
}

export function playNotificationSound(): boolean {
  if (!audioContext || audioContext.state !== "running") return false;
  const startedAt = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(660, startedAt);
  oscillator.frequency.exponentialRampToValueAtTime(880, startedAt + 0.09);
  gain.gain.setValueAtTime(0.0001, startedAt);
  gain.gain.exponentialRampToValueAtTime(0.12, startedAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startedAt + 0.16);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(startedAt);
  oscillator.stop(startedAt + 0.17);
  return true;
}

export function shouldPlayNotificationSound(
  event: DurableEvent,
  user: User,
  preferences: UserPreferences | null,
  chat?: Chat,
): boolean {
  if (!preferences?.sound_enabled || event.actor_id === user.id) return false;
  const occurredAt = new Date(event.occurred_at);
  if (
    preferences.snoozed_until &&
    occurredAt < new Date(preferences.snoozed_until)
  )
    return false;
  if (!insideSchedule(occurredAt, user.timezone || "UTC", preferences.schedule))
    return false;
  if (event.type === "reaction.added") return preferences.notify_reactions;
  if (event.type === "member.joined") return preferences.notify_invites;
  if (event.type === "member.updated" || event.type === "member.removed")
    return preferences.notify_system;
  if (event.type !== "message.created" || !chat) return false;
  if (chat.muted_until && occurredAt < new Date(chat.muted_until)) return false;
  const mentioned = Array.isArray(event.data.mentioned_actor_ids)
    ? event.data.mentioned_actor_ids.includes(user.id)
    : false;
  if (chat.notify_level === "none") return false;
  if (chat.notify_level === "mentions") return mentioned;
  if (chat.notify_level === "all") return true;
  const messageAllowed =
    preferences.notify_messages === "all" ||
    (preferences.notify_messages === "direct_and_mentions" &&
      (chat.kind === "direct" || mentioned));
  if (!messageAllowed) return false;
  if (!event.data.thread_root_id) return true;
  return (
    preferences.notify_threads === "all" ||
    (preferences.notify_threads === "mentions" && mentioned)
  );
}

function insideSchedule(
  date: Date,
  timezone: string,
  schedule: UserPreferences["schedule"],
): boolean {
  if (!schedule || schedule.from === schedule.to) return true;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const day = weekdays[parts.weekday];
  if (schedule.days === "weekdays" && (day === 0 || day === 6)) return false;
  if (Array.isArray(schedule.days) && !schedule.days.includes(day))
    return false;
  const current = `${parts.hour}:${parts.minute}`;
  return schedule.from < schedule.to
    ? current >= schedule.from && current < schedule.to
    : current >= schedule.from || current < schedule.to;
}
