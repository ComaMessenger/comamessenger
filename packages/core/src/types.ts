import type { components } from "@comamessenger/protocol";

export type User = components["schemas"]["User"];
export type Chat = components["schemas"]["Chat"];
export type DirectoryChat = components["schemas"]["DirectoryChat"];
export type ChatMember = components["schemas"]["ChatMember"];
export type Message = components["schemas"]["Message"];
export type MessagePage = components["schemas"]["MessagePage"];
export type Reaction = components["schemas"]["Reaction"];
export type MessagePin = components["schemas"]["MessagePin"];
export type ThreadSummary = components["schemas"]["ThreadSummary"];
export type ThreadPage = components["schemas"]["ThreadPage"];
export type UnreadSnapshot = components["schemas"]["UnreadSnapshot"];
export type Draft = components["schemas"]["Draft"];
export type ReadMarker = components["schemas"]["ReadMarker"];
export type ActorSummary = components["schemas"]["ActorSummary"];
export type ActorPage = components["schemas"]["ActorPage"];
export type MessageWindow = components["schemas"]["MessageWindow"];
export type PushConfig = components["schemas"]["PushConfig"];
export type PushSubscriptionRecord = components["schemas"]["PushSubscription"];
export type UserPreferences = components["schemas"]["UserPreferences"];
export type ChatNotificationPreferences =
  components["schemas"]["ChatNotificationPreferences"];
export type BootstrapRequest = components["schemas"]["BootstrapRequest"];
export type LoginRequest = components["schemas"]["LoginRequest"];
export type CreateChatRequest = components["schemas"]["CreateChatRequest"];
export type CreateMessageRequest =
  components["schemas"]["CreateMessageRequest"];
export type UpdateMessageRequest =
  components["schemas"]["UpdateMessageRequest"];
export type AcceptInvitationRequest =
  components["schemas"]["AcceptInvitationRequest"];
export type TokenResponse = components["schemas"]["TokenResponse"];
export type ServiceHealth = { status: "checking" | "ok" | "unavailable" };
export type DeliveryState = "sending" | "sent" | "failed" | "retrying";
export type ClientMessage = Message & {
  delivery?: DeliveryState;
  errorCode?: string;
};
export type DurableEvent = {
  op: "event";
  seq: number;
  type: string;
  occurred_at: string;
  actor_id: string;
  chat_id?: string | null;
  subject_id: string;
  data: Record<string, unknown>;
};
export type RealtimeState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "backlog"
  | "live"
  | "reconnecting"
  | "resync_required"
  | "session_expired";
