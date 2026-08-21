import type { components } from "@comamessenger/protocol";

export type User = components["schemas"]["User"];
export type Permission = components["schemas"]["Permission"];
export type Chat = components["schemas"]["Chat"];
export type DirectoryChat = components["schemas"]["DirectoryChat"];
export type ChatMember = components["schemas"]["ChatMember"];
export type Message = components["schemas"]["Message"];
export type FileMetadata = components["schemas"]["File"];
export type FileUpload = components["schemas"]["FileUpload"];
export type CompletedFilePart = components["schemas"]["CompletedFilePart"];
export type SearchPage = components["schemas"]["SearchPage"];
export type SearchResult = components["schemas"]["SearchResult"];
export type AvatarUpdate = components["schemas"]["AvatarUpdate"];
export type MessagePage = components["schemas"]["MessagePage"];
export type Reaction = components["schemas"]["Reaction"];
export type MessageReceipt = components["schemas"]["MessageReceipt"];
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
export type PushSubscriptionInfo =
  components["schemas"]["PushSubscriptionInfo"];
export type PushTestResult = components["schemas"]["PushTestResult"];
export type UserPreferences = components["schemas"]["UserPreferences"];
export type UpdatePreferencesRequest =
  components["schemas"]["UpdatePreferencesRequest"];
export type ChatFolder = components["schemas"]["ChatFolder"];
export type ChatNotificationPreferences =
  components["schemas"]["ChatNotificationPreferences"];
export type ChatNotificationOverride =
  components["schemas"]["ChatNotificationOverride"];
export type PublicBranding = components["schemas"]["PublicBranding"];
export type OrganizationSettings =
  components["schemas"]["OrganizationSettings"];
export type UpdateOrganizationSettingsRequest =
  components["schemas"]["UpdateOrganizationSettingsRequest"];
export type InfrastructureSettings =
  components["schemas"]["InfrastructureSettings"];
export type UpdateInfrastructureSettingsRequest =
  components["schemas"]["UpdateInfrastructureSettingsRequest"];
export type ConnectionTestResult =
  components["schemas"]["ConnectionTestResult"];
export type OrganizationMember = components["schemas"]["OrganizationMember"];
export type UpdateOrganizationMemberRequest =
  components["schemas"]["UpdateOrganizationMemberRequest"];
export type TransferOwnershipRequest =
  components["schemas"]["TransferOwnershipRequest"];
export type ChangePasswordRequest =
  components["schemas"]["ChangePasswordRequest"];
export type ForgotPasswordRequest =
  components["schemas"]["ForgotPasswordRequest"];
export type ResetPasswordRequest =
  components["schemas"]["ResetPasswordRequest"];
export type SetStatusRequest = components["schemas"]["SetStatusRequest"];
export type CustomStatus = components["schemas"]["CustomStatus"];
export type ChangeEmailRequest = components["schemas"]["ChangeEmailRequest"];
export type ConfirmEmailRequest = components["schemas"]["ConfirmEmailRequest"];
export type EmailChangeResponse = components["schemas"]["EmailChangeResponse"];
export type AuditPage = components["schemas"]["AuditPage"];
export type Agent = components["schemas"]["Agent"];
export type AgentUsageReport = components["schemas"]["AgentUsageReport"];
export type AgentUsageEntry = components["schemas"]["AgentUsageEntry"];
export type AgentScope = components["schemas"]["AgentScope"];
export type AgentApiKey = components["schemas"]["AgentApiKey"];
export type CreatedAgentApiKey = components["schemas"]["CreatedAgentApiKey"];
export type CreateAgentRequest = components["schemas"]["CreateAgentRequest"];
export type DuplicateAgentRequest =
  components["schemas"]["DuplicateAgentRequest"];
export type UpdateAgentRequest = components["schemas"]["UpdateAgentRequest"];
export type CreateAgentKeyRequest =
  components["schemas"]["CreateAgentKeyRequest"];
export type AgentPlatformSettings =
  components["schemas"]["AgentPlatformSettings"];
export type UpdateAgentPlatformSettingsRequest =
  components["schemas"]["UpdateAgentPlatformSettingsRequest"];
export type AgentToolDefinition = components["schemas"]["AgentToolDefinition"];
export type InvokeAgentToolRequest =
  components["schemas"]["InvokeAgentToolRequest"];
export type AgentToolConfirmation =
  components["schemas"]["AgentToolConfirmation"];
export type AgentRun = components["schemas"]["AgentRun"];
export type AgentRunPage = components["schemas"]["AgentRunPage"];
export type InvokeAgentRequest = components["schemas"]["InvokeAgentRequest"];
export type AgentTrigger = components["schemas"]["AgentTrigger"];
export type CreateAgentTriggerRequest =
  components["schemas"]["CreateAgentTriggerRequest"];
export type UpdateAgentTriggerRequest =
  components["schemas"]["UpdateAgentTriggerRequest"];
export type ClaimedAgentRun = components["schemas"]["ClaimedAgentRun"];
export type ClaimAgentRunRequest =
  components["schemas"]["ClaimAgentRunRequest"];
export type AgentRunLeaseRequest =
  components["schemas"]["AgentRunLeaseRequest"];
export type PublishAgentRunRequest =
  components["schemas"]["PublishAgentRunRequest"];
export type CompleteAgentRunRequest =
  components["schemas"]["CompleteAgentRunRequest"];
export type FailAgentRunRequest = components["schemas"]["FailAgentRunRequest"];
export type AgentRuntimeCheckpoint =
  components["schemas"]["AgentRuntimeCheckpoint"];
export type UpdateAgentRuntimeCheckpointRequest =
  components["schemas"]["UpdateAgentRuntimeCheckpointRequest"];
export type AgentProviderCredentialView =
  components["schemas"]["AgentProviderCredentialView"];
export type UpdateAgentProviderCredentialRequest =
  components["schemas"]["UpdateAgentProviderCredentialRequest"];
export type AgentMcpServer = components["schemas"]["AgentMcpServer"];
export type CreateAgentMcpServerRequest =
  components["schemas"]["CreateAgentMcpServerRequest"];
export type UpdateAgentMcpServerRequest =
  components["schemas"]["UpdateAgentMcpServerRequest"];
export type AgentRuntimeMcpServer =
  components["schemas"]["AgentRuntimeMcpServer"];
export type AgentRuntimeRunLeaseRequest =
  components["schemas"]["AgentRuntimeRunLeaseRequest"];
export type AgentMcpToolCall = components["schemas"]["AgentMcpToolCall"];
export type StartAgentMcpToolCallRequest =
  components["schemas"]["StartAgentMcpToolCallRequest"];
export type FinishAgentMcpToolCallRequest =
  components["schemas"]["FinishAgentMcpToolCallRequest"];
export type AgentProviderCall = components["schemas"]["AgentProviderCall"];
export type AgentProviderProxyRequest =
  components["schemas"]["AgentProviderProxyRequest"];
export type StartAgentProviderCallRequest =
  components["schemas"]["StartAgentProviderCallRequest"];
export type FinishAgentProviderCallRequest =
  components["schemas"]["FinishAgentProviderCallRequest"];
export type Session = components["schemas"]["Session"];
export type BootstrapRequest = components["schemas"]["BootstrapRequest"];
export type LoginRequest = components["schemas"]["LoginRequest"];
export type CreateChatRequest = components["schemas"]["CreateChatRequest"];
export type CreateMessageRequest =
  components["schemas"]["CreateMessageRequest"];
export type UpdateMessageRequest =
  components["schemas"]["UpdateMessageRequest"];
export type AcceptInvitationRequest =
  components["schemas"]["AcceptInvitationRequest"];
export type CreateInvitationRequest =
  components["schemas"]["CreateInvitationRequest"];
export type Invitation = components["schemas"]["Invitation"];
export type InvitationSummary = components["schemas"]["InvitationSummary"];
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
  | "password_change_required"
  | "session_expired";
