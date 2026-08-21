import type { components } from "@comamessenger/protocol";
import type {
  AcceptInvitationRequest,
  ActorPage,
  BootstrapRequest,
  Chat,
  ChatFolder,
  ChatMember,
  ChatNotificationPreferences,
  ChatNotificationOverride,
  ConnectionTestResult,
  CreateChatRequest,
  CreateInvitationRequest,
  CreateMessageRequest,
  DirectoryChat,
  Draft,
  LoginRequest,
  Message,
  MessagePage,
  MessagePin,
  MessageReceipt,
  MessageWindow,
  InfrastructureSettings,
  Invitation,
  InvitationSummary,
  OrganizationMember,
  OrganizationSettings,
  PublicBranding,
  PushConfig,
  PushSubscriptionRecord,
  PushSubscriptionInfo,
  PushTestResult,
  Reaction,
  ReadMarker,
  ServiceHealth,
  Session,
  ThreadPage,
  TokenResponse,
  UnreadSnapshot,
  UpdateMessageRequest,
  UpdateInfrastructureSettingsRequest,
  UpdateOrganizationMemberRequest,
  TransferOwnershipRequest,
  ChangePasswordRequest,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  SetStatusRequest,
  CustomStatus,
  ChangeEmailRequest,
  ConfirmEmailRequest,
  EmailChangeResponse,
  UpdateOrganizationSettingsRequest,
  User,
  UserPreferences,
  UpdatePreferencesRequest,
  AuditPage,
} from "./types";

type APIErrorPayload = components["schemas"]["Error"];
type APIErrorCode = components["schemas"]["ErrorCode"] | "request_failed";
export type RefreshStrategy = (
  request: () => Promise<TokenResponse>,
) => Promise<TokenResponse>;
export class APIError extends Error {
  constructor(
    readonly status: number,
    readonly code: APIErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "APIError";
  }
}
export async function getHealth(apiURL: string): Promise<ServiceHealth> {
  try {
    const response = await fetch(`${apiURL}/healthz`);
    return { status: response.ok ? "ok" : "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

export class MessengerAPI {
  private accessToken: string | null = null;
  private refreshRequest: Promise<TokenResponse> | null = null;
  constructor(
    readonly apiURL: string,
    private readonly refreshStrategy?: RefreshStrategy,
  ) {}
  token(): string | null {
    return this.accessToken;
  }
  clearToken(expected?: string | null): boolean {
    if (expected !== undefined && this.accessToken !== expected) return false;
    this.accessToken = null;
    return true;
  }
  adoptTokens(tokens: TokenResponse): TokenResponse {
    return this.acceptTokens(tokens);
  }
  websocketURL(): string {
    const url = new URL("/api/v1/ws", this.apiURL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }
  async bootstrapStatus(): Promise<boolean> {
    return (
      await this.request<{ bootstrapped: boolean }>("/api/v1/bootstrap/status")
    ).bootstrapped;
  }
  async bootstrap(input: BootstrapRequest, token = ""): Promise<TokenResponse> {
    const headers = new Headers();
    if (token) headers.set("X-Coma-Bootstrap-Token", token);
    return this.acceptTokens(
      await this.request<TokenResponse>("/api/v1/bootstrap", {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      }),
    );
  }
  async login(input: LoginRequest): Promise<TokenResponse> {
    return this.acceptTokens(
      await this.request<TokenResponse>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }
  forgotPassword(input: ForgotPasswordRequest): Promise<void> {
    return this.request("/api/v1/auth/password/forgot", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  resetPassword(input: ResetPasswordRequest): Promise<void> {
    return this.request("/api/v1/auth/password/reset", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  refresh(): Promise<TokenResponse> {
    if (!this.refreshRequest) {
      const request = () =>
        this.request<TokenResponse>(
          "/api/v1/auth/refresh",
          { method: "POST" },
          false,
        );
      this.refreshRequest = (
        this.refreshStrategy ? this.refreshStrategy(request) : request()
      )
        .then((value) => this.acceptTokens(value))
        .finally(() => {
          this.refreshRequest = null;
        });
    }
    return this.refreshRequest;
  }
  async logout(): Promise<void> {
    try {
      await this.request<void>("/api/v1/auth/logout", { method: "POST" });
    } finally {
      this.accessToken = null;
    }
  }
  async acceptInvitation(
    token: string,
    input: AcceptInvitationRequest,
  ): Promise<TokenResponse> {
    return this.acceptTokens(
      await this.request<TokenResponse>(
        `/api/v1/invitations/${encodeURIComponent(token)}/accept`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    );
  }
  me(): Promise<User> {
    return this.request("/api/v1/me");
  }
  updateMe(
    input: Partial<
      Pick<User, "display_name" | "handle" | "title" | "about" | "timezone">
    >,
  ): Promise<User> {
    return this.request("/api/v1/me", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }
  changePassword(input: ChangePasswordRequest): Promise<void> {
    return this.request("/api/v1/me/password", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  setStatus(input: SetStatusRequest): Promise<CustomStatus> {
    return this.request("/api/v1/me/status", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }
  clearStatus(): Promise<CustomStatus> {
    return this.request("/api/v1/me/status", { method: "DELETE" });
  }
  changeEmail(input: ChangeEmailRequest): Promise<EmailChangeResponse> {
    return this.request("/api/v1/me/email/change", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  confirmEmail(input: ConfirmEmailRequest): Promise<User> {
    return this.request("/api/v1/me/email/confirm", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  createInvitation(input: CreateInvitationRequest): Promise<Invitation> {
    return this.request("/api/v1/invitations", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  invitations(): Promise<InvitationSummary[]> {
    return this.request("/api/v1/invitations");
  }
  revokeInvitation(id: string): Promise<void> {
    return this.request(`/api/v1/invitations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
  rotateInvitation(id: string): Promise<Invitation> {
    return this.request(
      `/api/v1/invitations/${encodeURIComponent(id)}/rotate`,
      { method: "POST" },
    );
  }
  branding(): Promise<PublicBranding> {
    return this.request("/api/v1/branding");
  }
  async sessions(): Promise<Session[]> {
    return (await this.request<{ sessions: Session[] }>("/api/v1/sessions"))
      .sessions;
  }
  revokeSession(id: string): Promise<void> {
    return this.request(`/api/v1/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
  revokeOtherSessions(): Promise<void> {
    return this.request("/api/v1/sessions/revoke-others", { method: "POST" });
  }
  organization(): Promise<OrganizationSettings> {
    return this.request("/api/v1/organization");
  }
  updateOrganization(
    input: UpdateOrganizationSettingsRequest,
  ): Promise<OrganizationSettings> {
    return this.request("/api/v1/organization", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }
  putBrandingAsset(kind: "logo" | "favicon", file: Blob): Promise<void> {
    return this.request(`/api/v1/organization/branding/${kind}`, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
  }
  deleteBrandingAsset(kind: "logo" | "favicon"): Promise<void> {
    return this.request(`/api/v1/organization/branding/${kind}`, {
      method: "DELETE",
    });
  }
  infrastructure(): Promise<InfrastructureSettings> {
    return this.request("/api/v1/organization/infrastructure");
  }
  updateInfrastructure(
    input: UpdateInfrastructureSettingsRequest,
  ): Promise<InfrastructureSettings> {
    return this.request("/api/v1/organization/infrastructure", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }
  testInfrastructure(kind: "s3" | "smtp"): Promise<ConnectionTestResult> {
    return this.request("/api/v1/organization/infrastructure/test", {
      method: "POST",
      body: JSON.stringify({ kind }),
    });
  }
  async organizationMembers(): Promise<OrganizationMember[]> {
    return (
      await this.request<{ members: OrganizationMember[] }>(
        "/api/v1/organization/members",
      )
    ).members;
  }
  updateOrganizationMember(
    actorID: string,
    input: UpdateOrganizationMemberRequest,
  ): Promise<OrganizationMember> {
    return this.request(
      `/api/v1/organization/members/${encodeURIComponent(actorID)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }
  requireMemberPasswordChange(actorID: string): Promise<void> {
    return this.request(
      `/api/v1/organization/members/${encodeURIComponent(actorID)}/require-password-change`,
      { method: "POST" },
    );
  }
  issueMemberPasswordReset(actorID: string): Promise<void> {
    return this.request(
      `/api/v1/organization/members/${encodeURIComponent(actorID)}/password-reset`,
      { method: "POST" },
    );
  }
  transferOrganizationOwnership(
    input: TransferOwnershipRequest,
  ): Promise<User> {
    return this.request("/api/v1/organization/transfer-ownership", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  organizationAudit(limit = 50): Promise<AuditPage> {
    return this.request(`/api/v1/organization/audit?limit=${limit}`);
  }
  async chats(): Promise<Chat[]> {
    return (await this.request<{ chats: Chat[] }>("/api/v1/chats")).chats;
  }
  chat(id: string): Promise<Chat> {
    return this.request(`/api/v1/chats/${id}`);
  }
  createChat(input: CreateChatRequest): Promise<Chat> {
    return this.request("/api/v1/chats", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async discoverChats(): Promise<DirectoryChat[]> {
    return (
      await this.request<{ chats: DirectoryChat[] }>("/api/v1/chats/discover")
    ).chats;
  }
  joinChat(id: string): Promise<Chat> {
    return this.request(`/api/v1/chats/${id}/join`, { method: "POST" });
  }
  updateChat(
    id: string,
    input: { name?: string; topic?: string; visibility?: "private" | "public" },
  ): Promise<Chat> {
    return this.request(`/api/v1/chats/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }
  archiveChat(id: string): Promise<void> {
    return this.request(`/api/v1/chats/${id}`, { method: "DELETE" });
  }
  async members(chatID: string): Promise<ChatMember[]> {
    return (
      await this.request<{ members: ChatMember[] }>(
        `/api/v1/chats/${chatID}/members`,
      )
    ).members;
  }
  addMember(
    chatID: string,
    actorID: string,
    role: "owner" | "admin" | "member" = "member",
  ): Promise<ChatMember> {
    return this.request(`/api/v1/chats/${chatID}/members`, {
      method: "POST",
      body: JSON.stringify({ actor_id: actorID, role }),
    });
  }
  updateMember(
    chatID: string,
    actorID: string,
    role: "owner" | "admin" | "member",
  ): Promise<ChatMember> {
    return this.request(`/api/v1/chats/${chatID}/members/${actorID}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
  }
  removeMember(chatID: string, actorID: string): Promise<void> {
    return this.request(`/api/v1/chats/${chatID}/members/${actorID}`, {
      method: "DELETE",
    });
  }
  actors(query = "", afterID = ""): Promise<ActorPage> {
    const values = new URLSearchParams();
    if (query) values.set("q", query);
    if (afterID) values.set("after_id", afterID);
    return this.request(`/api/v1/actors${values.size ? `?${values}` : ""}`);
  }
  messages(
    chatID: string,
    options: { beforeSeq?: number; limit?: number; threadRootID?: string } = {},
  ): Promise<MessagePage> {
    const query = new URLSearchParams();
    if (options.beforeSeq) query.set("before_seq", String(options.beforeSeq));
    if (options.limit) query.set("limit", String(options.limit));
    if (options.threadRootID) query.set("thread_root_id", options.threadRootID);
    return this.request(
      `/api/v1/chats/${chatID}/messages${query.size ? `?${query}` : ""}`,
    );
  }
  thread(rootID: string, beforeSeq?: number): Promise<MessagePage> {
    return this.request(
      `/api/v1/messages/${rootID}/thread${beforeSeq ? `?before_seq=${beforeSeq}` : ""}`,
    );
  }
  messageContext(messageID: string, limit = 51): Promise<MessageWindow> {
    return this.request(`/api/v1/messages/${messageID}/context?limit=${limit}`);
  }
  threads(beforeSeq?: number): Promise<ThreadPage> {
    return this.request(
      `/api/v1/threads${beforeSeq ? `?before_seq=${beforeSeq}` : ""}`,
    );
  }
  createMessage(chatID: string, input: CreateMessageRequest): Promise<Message> {
    return this.request(`/api/v1/chats/${chatID}/messages`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  updateMessage(id: string, input: UpdateMessageRequest): Promise<Message> {
    return this.request(`/api/v1/messages/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }
  deleteMessage(id: string): Promise<Message> {
    return this.request(`/api/v1/messages/${id}`, { method: "DELETE" });
  }
  async reactions(id: string): Promise<Reaction[]> {
    return (
      await this.request<{ reactions: Reaction[] }>(
        `/api/v1/messages/${id}/reactions`,
      )
    ).reactions;
  }
  async receipts(id: string): Promise<MessageReceipt[]> {
    return (
      await this.request<{ receipts: MessageReceipt[] }>(
        `/api/v1/messages/${id}/receipts`,
      )
    ).receipts;
  }
  react(id: string, emoji: string): Promise<Reaction> {
    return this.request(
      `/api/v1/messages/${id}/reactions/${encodeURIComponent(emoji)}`,
      { method: "PUT" },
    );
  }
  unreact(id: string, emoji: string): Promise<void> {
    return this.request(
      `/api/v1/messages/${id}/reactions/${encodeURIComponent(emoji)}`,
      { method: "DELETE" },
    );
  }
  async pins(chatID: string): Promise<MessagePin[]> {
    return (
      await this.request<{ pins: MessagePin[] }>(`/api/v1/chats/${chatID}/pins`)
    ).pins;
  }
  pin(id: string): Promise<MessagePin> {
    return this.request(`/api/v1/messages/${id}/pin`, { method: "PUT" });
  }
  unpin(id: string): Promise<void> {
    return this.request(`/api/v1/messages/${id}/pin`, { method: "DELETE" });
  }
  forward(id: string, chatID: string, clientMsgID: string): Promise<Message> {
    return this.request(`/api/v1/messages/${id}/forward`, {
      method: "POST",
      body: JSON.stringify({ chat_id: chatID, client_msg_id: clientMsgID }),
    });
  }
  followThread(id: string): Promise<unknown> {
    return this.request(`/api/v1/messages/${id}/thread/follow`, {
      method: "PUT",
    });
  }
  unfollowThread(id: string): Promise<void> {
    return this.request(`/api/v1/messages/${id}/thread/follow`, {
      method: "DELETE",
    });
  }
  unread(): Promise<UnreadSnapshot> {
    return this.request("/api/v1/unread");
  }
  markRead(chatID: string, seq: number): Promise<ReadMarker> {
    return this.request(`/api/v1/chats/${chatID}/read`, {
      method: "POST",
      body: JSON.stringify({ last_read_seq: seq }),
    });
  }
  markThreadRead(id: string, seq: number): Promise<ReadMarker> {
    return this.request(`/api/v1/messages/${id}/thread/read`, {
      method: "POST",
      body: JSON.stringify({ last_read_seq: seq }),
    });
  }
  async drafts(): Promise<Draft[]> {
    return (await this.request<{ drafts: Draft[] }>("/api/v1/drafts")).drafts;
  }
  putDraft(
    chatID: string,
    body: string,
    expectedVersion: number,
    threadRootID?: string,
  ): Promise<Draft> {
    return this.request(`/api/v1/drafts/${chatID}`, {
      method: "PUT",
      body: JSON.stringify({
        body,
        body_format: "markdown",
        expected_version: expectedVersion,
        thread_root_id: threadRootID ?? null,
      }),
    });
  }
  deleteDraft(chatID: string, threadRootID?: string): Promise<void> {
    return this.request(
      `/api/v1/drafts/${chatID}${threadRootID ? `?thread_root_id=${threadRootID}` : ""}`,
      { method: "DELETE" },
    );
  }
  pushConfig(): Promise<PushConfig> {
    return this.request("/api/v1/push/config");
  }
  registerPush(input: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }): Promise<PushSubscriptionRecord> {
    return this.request("/api/v1/push/subscriptions", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }
  pushSubscriptions(): Promise<PushSubscriptionInfo[]> {
    return this.request("/api/v1/push/subscriptions");
  }
  testPush(): Promise<PushTestResult> {
    return this.request("/api/v1/push/test", { method: "POST" });
  }
  removePush(id: string): Promise<void> {
    return this.request(`/api/v1/push/subscriptions/${id}`, {
      method: "DELETE",
    });
  }
  preferences(): Promise<UserPreferences> {
    return this.request("/api/v1/preferences");
  }
  updatePreferences(input: UpdatePreferencesRequest): Promise<UserPreferences> {
    return this.request("/api/v1/preferences", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }
  chatFolders(): Promise<ChatFolder[]> {
    return this.request("/api/v1/preferences/chat-folders");
  }
  putChatFolders(input: ChatFolder[]): Promise<ChatFolder[]> {
    return this.request("/api/v1/preferences/chat-folders", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }
  pinnedChats(): Promise<string[]> {
    return this.request("/api/v1/preferences/pinned-chats");
  }
  putPinnedChats(input: string[]): Promise<string[]> {
    return this.request("/api/v1/preferences/pinned-chats", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }
  chatNotifications(chatID: string): Promise<ChatNotificationPreferences> {
    return this.request(`/api/v1/chats/${chatID}/notification-preferences`);
  }
  updateChatNotifications(
    chatID: string,
    input: ChatNotificationPreferences,
  ): Promise<ChatNotificationPreferences> {
    return this.request(`/api/v1/chats/${chatID}/notification-preferences`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }
  resetChatNotifications(
    chatID: string,
  ): Promise<ChatNotificationPreferences> {
    return this.request(`/api/v1/chats/${chatID}/notification-preferences`, {
      method: "DELETE",
    });
  }
  chatNotificationOverrides(): Promise<ChatNotificationOverride[]> {
    return this.request("/api/v1/chats/notification-overrides");
  }
  private acceptTokens(tokens: TokenResponse): TokenResponse {
    this.accessToken = tokens.access_token;
    return tokens;
  }
  private async request<T>(
    path: string,
    init: RequestInit = {},
    retry = true,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    if (this.accessToken)
      headers.set("Authorization", `Bearer ${this.accessToken}`);
    const response = await fetch(`${this.apiURL}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
    if (response.status === 401 && retry && path !== "/api/v1/auth/refresh") {
      try {
        await this.refresh();
        return this.request<T>(path, init, false);
      } catch {
        this.accessToken = null;
      }
    }
    if (!response.ok) {
      let payload: Partial<APIErrorPayload> = {};
      try {
        payload = (await response.json()) as APIErrorPayload;
      } catch {
        /* proxy returned non-JSON */
      }
      throw new APIError(
        response.status,
        payload.code ?? "request_failed",
        payload.message ?? "Request failed.",
      );
    }
    if (response.status === 204) return undefined as T;
    const body = await response.text();
    if (!body) return undefined as T;
    return JSON.parse(body) as T;
  }
}
