import type { components } from "@comamessenger/protocol";

export type User = components["schemas"]["User"];
export type Permission = components["schemas"]["Permission"];
export type Chat = components["schemas"]["Chat"];
export type DirectoryChat = components["schemas"]["DirectoryChat"];
export type ChatMember = components["schemas"]["ChatMember"];
export type Message = components["schemas"]["Message"];
export type MessageBlocks = components["schemas"]["MessageBlocks"];
export type MessageCard = components["schemas"]["MessageCard"];
export type MessageAction = components["schemas"]["MessageAction"];
export type MessageActionAudience =
  components["schemas"]["MessageActionAudience"];
export type MessageActionResponse =
  components["schemas"]["MessageActionResponse"];
export type MessageActionResult = components["schemas"]["MessageActionResult"];
export type MessageSource = components["schemas"]["MessageSource"];
export type MessageAgentProvenance =
  components["schemas"]["MessageAgentProvenance"];
export type ChatAgent = components["schemas"]["ChatAgent"];
export type ChatAgentTrigger = components["schemas"]["ChatAgentTrigger"];
export type FileMetadata = components["schemas"]["File"];
export type FileUpload = components["schemas"]["FileUpload"];
export type VoiceInfo = components["schemas"]["VoiceInfo"];
export type CreateFileUploadRequest =
  components["schemas"]["CreateFileUploadRequest"];
export type CompletedFilePart = components["schemas"]["CompletedFilePart"];
export type SearchPage = components["schemas"]["SearchPage"];
export type SearchResult = components["schemas"]["SearchResult"];
export type KnowledgeCollection = components["schemas"]["KnowledgeCollection"];
export type CreateKnowledgeCollectionRequest =
  components["schemas"]["CreateKnowledgeCollectionRequest"];
export type UpdateKnowledgeCollectionRequest =
  components["schemas"]["UpdateKnowledgeCollectionRequest"];
export type KnowledgeDocument = components["schemas"]["KnowledgeDocument"];
export type CreateKnowledgeDocumentRequest =
  components["schemas"]["CreateKnowledgeDocumentRequest"];
export type UpdateKnowledgeDocumentRequest =
  components["schemas"]["UpdateKnowledgeDocumentRequest"];
export type KnowledgeDocumentFragments =
  components["schemas"]["KnowledgeDocumentFragments"];
export type KnowledgeEmbeddingConnection =
  components["schemas"]["KnowledgeEmbeddingConnection"];
export type KnowledgeSearchRequest =
  components["schemas"]["KnowledgeSearchRequest"];
export type KnowledgeSearchResult =
  components["schemas"]["KnowledgeSearchResult"];
export type KnowledgeFragment = components["schemas"]["KnowledgeFragment"];
export type AvatarUpdate = components["schemas"]["AvatarUpdate"];
export type ChatAvatarUpdate = components["schemas"]["ChatAvatarUpdate"];
export type MessagePage = components["schemas"]["MessagePage"];
export type Reaction = components["schemas"]["Reaction"];
export type MessageReceipt = components["schemas"]["MessageReceipt"];
export type MessagePin = components["schemas"]["MessagePin"];
export type ChatSharedCounts = components["schemas"]["ChatSharedCounts"];
export type ChatSharedAttachment =
  components["schemas"]["ChatSharedAttachment"];
export type ChatSharedAttachmentPage =
  components["schemas"]["ChatSharedAttachmentPage"];
export type ChatSharedLink = components["schemas"]["ChatSharedLink"];
export type ChatSharedLinkPage = components["schemas"]["ChatSharedLinkPage"];
export type SavedMessage = components["schemas"]["SavedMessage"];
export type SavedMessagePage = components["schemas"]["SavedMessagePage"];
export type SavedMessageState = components["schemas"]["SavedMessageState"];
export type SavedMessageChatCount =
  components["schemas"]["SavedMessageChatCount"];
export type ThreadSummary = components["schemas"]["ThreadSummary"];
export type ThreadPage = components["schemas"]["ThreadPage"];
export type UnreadSnapshot = components["schemas"]["UnreadSnapshot"];
export type Draft = components["schemas"]["Draft"];
export type ReadMarker = components["schemas"]["ReadMarker"];
export type ActorSummary = components["schemas"]["ActorSummary"];
export type ActorPage = components["schemas"]["ActorPage"];
export type MessageWindow = components["schemas"]["MessageWindow"];
export type PushConfig = components["schemas"]["PushConfig"];
export type MobilePushDeviceRequest =
  components["schemas"]["MobilePushDeviceRequest"];
export type MobilePushDevice = components["schemas"]["MobilePushDevice"];
export type ObjectLink = components["schemas"]["ObjectLink"];
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
export type MailDelivery = components["schemas"]["MailDelivery"];
export type ComaMailStatus = components["schemas"]["ComaMailStatus"];
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
export type AgentTone = components["schemas"]["AgentTone"];
export type AgentConfirmationMode =
  components["schemas"]["AgentConfirmationMode"];
export type AgentConfirmationPolicy =
  components["schemas"]["AgentConfirmationPolicy"];
export type AgentVersion = components["schemas"]["AgentVersion"];
export type AgentUsageReport = components["schemas"]["AgentUsageReport"];
export type AgentProductMetrics = components["schemas"]["AgentProductMetrics"];
export type AgentRecipe = components["schemas"]["AgentRecipe"];
export type AgentRecipeId = components["schemas"]["AgentRecipeId"];
export type AgentUsageEntry = components["schemas"]["AgentUsageEntry"];
export type AgentScope = components["schemas"]["AgentScope"];
export type AgentApiKey = components["schemas"]["AgentApiKey"];
export type CreatedAgentApiKey = components["schemas"]["CreatedAgentApiKey"];
export type CreateAgentRequest = components["schemas"]["CreateAgentRequest"];
export type DuplicateAgentRequest =
  components["schemas"]["DuplicateAgentRequest"];
export type UpdateAgentRequest = components["schemas"]["UpdateAgentRequest"];
export type PublishAgentRequest = components["schemas"]["PublishAgentRequest"];
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
export type AgentRunToolCall = components["schemas"]["AgentRunToolCall"];
export type AgentResponseCollection =
  components["schemas"]["AgentResponseCollection"];
export type AgentFollowup = components["schemas"]["AgentFollowup"];
export type KnowledgeRunFragments =
  components["schemas"]["KnowledgeRunFragments"];
export type InvokeAgentRequest = components["schemas"]["InvokeAgentRequest"];
export type AgentTrigger = components["schemas"]["AgentTrigger"];
export type ArchitectSession = components["schemas"]["ArchitectSession"];
export type ArchitectMessage = components["schemas"]["ArchitectMessage"];
export type ArchitectTestExample =
  components["schemas"]["ArchitectTestExample"];
export type StartArchitectSessionRequest =
  components["schemas"]["StartArchitectSessionRequest"];
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
export type AgentLlmConnection = components["schemas"]["AgentLlmConnection"];
export type CreateAgentLlmConnectionRequest =
  components["schemas"]["CreateAgentLlmConnectionRequest"];
export type UpdateAgentLlmConnectionRequest =
  components["schemas"]["UpdateAgentLlmConnectionRequest"];
export type AgentMcpServer = components["schemas"]["AgentMcpServer"];
export type CreateAgentMcpServerRequest =
  components["schemas"]["CreateAgentMcpServerRequest"];
export type UpdateAgentMcpServerRequest =
  components["schemas"]["UpdateAgentMcpServerRequest"];
export type AgentRuntimeMcpServer =
  components["schemas"]["AgentRuntimeMcpServer"];
export type AgentMcpBinding = components["schemas"]["AgentMcpBinding"];
export type McpTool = components["schemas"]["McpTool"];
export type McpConnection = components["schemas"]["McpConnection"];
export type CreateMcpConnectionRequest =
  components["schemas"]["CreateMcpConnectionRequest"];
export type UpdateMcpConnectionRequest =
  components["schemas"]["UpdateMcpConnectionRequest"];
export type McpConnectionUsage = components["schemas"]["McpConnectionUsage"];
export type IntegrationWebhook = components["schemas"]["IntegrationWebhook"];
export type IntegrationWebhookWithSecret =
  components["schemas"]["IntegrationWebhookWithSecret"];
export type CreateIntegrationWebhookRequest =
  components["schemas"]["CreateIntegrationWebhookRequest"];
export type UpdateIntegrationWebhookRequest =
  components["schemas"]["UpdateIntegrationWebhookRequest"];
export type IntegrationWebhookDelivery =
  components["schemas"]["IntegrationWebhookDelivery"];
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
export type ScheduledMessage = components["schemas"]["ScheduledMessage"];
/** data of scheduled_message.* realtime events: no text, fetch the record. */
export type ScheduledMessageEvent =
  components["schemas"]["ScheduledMessageEvent"];
export type ScheduledMessageFailureReason =
  components["schemas"]["ScheduledMessageFailureReason"];
export type CreateScheduledMessageRequest =
  components["schemas"]["CreateScheduledMessageRequest"];
export type UpdateScheduledMessageRequest =
  components["schemas"]["UpdateScheduledMessageRequest"];
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
  /**
   * Who caused the event; null when nobody may know (poll.updated, a poll
   * closed by its due date) or the server did it.
   */
  actor_id: string | null;
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

// Requests («Запрос») and personal reminders («Напомнить мне»), phase 6.4.
export type MessageRequest = components["schemas"]["MessageRequest"];
export type MessageRequestViewer =
  components["schemas"]["MessageRequestViewer"];
export type MessageRequestViewerAnswer =
  components["schemas"]["MessageRequestViewerAnswer"];
export type RequestState = components["schemas"]["RequestState"];
export type RequestAnswerPreset = components["schemas"]["RequestAnswerPreset"];
export type RequestAnswerSpec = components["schemas"]["RequestAnswerSpec"];
export type RequestAudience = components["schemas"]["RequestAudience"];
export type RequestAudienceKind = components["schemas"]["RequestAudienceKind"];
export type RequestAudienceInput =
  components["schemas"]["RequestAudienceInput"];
export type CreateRequestRequest =
  components["schemas"]["CreateRequestRequest"];
export type AnswerRequestRequest =
  components["schemas"]["AnswerRequestRequest"];
export type RequestAnswer = components["schemas"]["RequestAnswer"];
export type RequestAnswerCounts = components["schemas"]["RequestAnswerCounts"];
export type RequestAnswerPage = components["schemas"]["RequestAnswerPage"];
export type RequestRemindResult = components["schemas"]["RequestRemindResult"];
export type RequestInboxItem = components["schemas"]["RequestInboxItem"];
export type RequestInboxPage = components["schemas"]["RequestInboxPage"];
export type SetReminderRequest = components["schemas"]["SetReminderRequest"];
export type Reminder = components["schemas"]["Reminder"];
export type ReminderMessage = components["schemas"]["ReminderMessage"];
export type ReminderPage = components["schemas"]["ReminderPage"];
export type ReminderIdEntry = components["schemas"]["ReminderIdEntry"];
export type ChatUnread = components["schemas"]["ChatUnread"];
/** data of request.* realtime events: counts and versions, never text. */
export type RequestAssignedEvent =
  components["schemas"]["RealtimeRequestAssignedEventV1"];
export type RequestUpdatedEvent =
  components["schemas"]["RealtimeRequestUpdatedEventV1"];
export type RequestTallyUpdatedEvent =
  components["schemas"]["RealtimeRequestTallyUpdatedEventV1"];
export type RequestAnswerUpdatedEvent =
  components["schemas"]["RealtimeRequestAnswerUpdatedEventV1"];
export type RequestRemindedEvent =
  components["schemas"]["RealtimeRequestRemindedEventV1"];
export type RequestAutoRemindedEvent =
  components["schemas"]["RealtimeRequestAutoRemindedEventV1"];
/** data of reminder.created/updated/deleted: no note, no text. */
export type ReminderEvent = components["schemas"]["RealtimeReminderEventV1"];
export type ReminderFiredEvent =
  components["schemas"]["RealtimeReminderFiredEventV1"];

// Org structure (phase 6.5 wave 2): departments, positions, who is where.
export type OrgStructure = components["schemas"]["OrgStructure"];
export type OrgDepartment = components["schemas"]["OrgDepartment"];
export type OrgPosition = components["schemas"]["OrgPosition"];
export type OrgPerson = components["schemas"]["OrgPerson"];
export type MessageDepartmentMention =
  components["schemas"]["MessageDepartmentMention"];
/** data of org.updated: the new org_version and why; no content. */
export type OrgUpdatedEvent =
  components["schemas"]["RealtimeOrgUpdatedEventV1"];

// Tasks («Задача»), phase 6.6 wave 3.
export type MessageTask = components["schemas"]["MessageTask"];
export type MessageTaskAssignee = components["schemas"]["MessageTaskAssignee"];
export type MessageTaskItem = components["schemas"]["MessageTaskItem"];
export type MessageTaskSource = components["schemas"]["MessageTaskSource"];
export type TaskStatus = components["schemas"]["TaskStatus"];
export type TaskAssigneeKind = components["schemas"]["TaskAssigneeKind"];
export type TaskAssigneeInput = components["schemas"]["TaskAssigneeInput"];
export type TaskItemInput = components["schemas"]["TaskItemInput"];
export type CreateTaskRequest = components["schemas"]["CreateTaskRequest"];
export type UpdateTaskRequest = components["schemas"]["UpdateTaskRequest"];
export type SetTaskStatusRequest =
  components["schemas"]["SetTaskStatusRequest"];
export type AddTaskItemRequest = components["schemas"]["AddTaskItemRequest"];
export type UpdateTaskItemRequest =
  components["schemas"]["UpdateTaskItemRequest"];
export type TaskRole = components["schemas"]["TaskRole"];
export type ChatTaskCounts = components["schemas"]["ChatTaskCounts"];
export type ChatTaskPage = components["schemas"]["ChatTaskPage"];
export type MyTaskItem = components["schemas"]["MyTaskItem"];
export type MyTaskPage = components["schemas"]["MyTaskPage"];
export type TaskNudgeResult = components["schemas"]["TaskNudgeResult"];
export type WaitingInboxItem = components["schemas"]["WaitingInboxItem"];
export type WaitingInboxPage = components["schemas"]["WaitingInboxPage"];
/** data of task.updated: the whole task, the same for everyone. */
export type TaskUpdatedEvent = components["schemas"]["TaskUpdatedEvent"];
/** data of task.notified: a reason for push and toast, no task text. */
export type TaskNotifiedEvent =
  components["schemas"]["RealtimeTaskNotifiedEventV1"];

// Polls («Опрос») and «Отсутствую», phase 6.7 wave 4.
export type MessagePoll = components["schemas"]["MessagePoll"];
export type PollViewer = components["schemas"]["PollViewer"];
export type PollState = components["schemas"]["PollState"];
export type CreatePollRequest = components["schemas"]["CreatePollRequest"];
export type VotePollRequest = components["schemas"]["VotePollRequest"];
export type PollVoter = components["schemas"]["PollVoter"];
export type PollVoterPage = components["schemas"]["PollVoterPage"];
export type PollRemindResult = components["schemas"]["PollRemindResult"];
/** data of poll.updated: counters every member may see, never a choice. */
export type PollUpdatedEvent =
  components["schemas"]["RealtimePollUpdatedEventV1"];
/** data of poll.vote.updated: the reader's own vote; no choice when anonymous. */
export type PollVoteUpdatedEvent =
  components["schemas"]["RealtimePollVoteUpdatedEventV1"];
export type PollNotifiedEvent =
  components["schemas"]["RealtimePollNotifiedEventV1"];
export type AwayKind = components["schemas"]["AwayKind"];
/** The away status as everyone in the workspace sees it. */
export type AwayPublic = components["schemas"]["AwayPublic"];
export type AwayAutoreply = components["schemas"]["AwayAutoreply"];
/** The own away status with the private settings (getAway, setAway). */
export type AwayStatus = components["schemas"]["AwayStatus"];
export type SetAwayRequest = components["schemas"]["SetAwayRequest"];
export type SubstitutingEntry = components["schemas"]["SubstitutingEntry"];
export type SubstitutingList = components["schemas"]["SubstitutingList"];
export type ActorAwayUpdatedEvent =
  components["schemas"]["RealtimeActorAwayUpdatedEventV1"];
export type AwaySubstituteAssignedEvent =
  components["schemas"]["RealtimeAwaySubstituteAssignedEventV1"];
export type AwaySubstituteRemovedEvent =
  components["schemas"]["RealtimeAwaySubstituteRemovedEventV1"];
