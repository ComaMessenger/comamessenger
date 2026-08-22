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
  FileMetadata,
  FileUpload,
  CompletedFilePart,
  SearchPage,
  AvatarUpdate,
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
  Agent,
  AgentVersion,
  AgentUsageReport,
  AgentApiKey,
  CreatedAgentApiKey,
  CreateAgentRequest,
  DuplicateAgentRequest,
  UpdateAgentRequest,
  CreateAgentKeyRequest,
  AgentPlatformSettings,
  UpdateAgentPlatformSettingsRequest,
  AgentToolDefinition,
  InvokeAgentToolRequest,
  AgentToolConfirmation,
  AgentRun,
  AgentRunPage,
  InvokeAgentRequest,
  AgentTrigger,
  CreateAgentTriggerRequest,
  UpdateAgentTriggerRequest,
  ClaimedAgentRun,
  ClaimAgentRunRequest,
  AgentRunLeaseRequest,
  PublishAgentRunRequest,
  CompleteAgentRunRequest,
  FailAgentRunRequest,
  AgentRuntimeCheckpoint,
  UpdateAgentRuntimeCheckpointRequest,
  AgentProviderCredentialView,
  UpdateAgentProviderCredentialRequest,
  AgentLlmConnection,
  CreateAgentLlmConnectionRequest,
  UpdateAgentLlmConnectionRequest,
  AgentMcpServer,
  CreateAgentMcpServerRequest,
  UpdateAgentMcpServerRequest,
  AgentRuntimeMcpServer,
  AgentRuntimeRunLeaseRequest,
  AgentMcpToolCall,
  StartAgentMcpToolCallRequest,
  FinishAgentMcpToolCallRequest,
  AgentProviderCall,
  AgentProviderProxyRequest,
  StartAgentProviderCallRequest,
  FinishAgentProviderCallRequest,
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
  useAccessToken(token: string): void {
    this.accessToken = token;
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
  agents(): Promise<Agent[]> {
    return this.request("/api/v1/agents");
  }
  agentPlatformSettings(): Promise<AgentPlatformSettings> {
    return this.request("/api/v1/agents/settings");
  }
  updateAgentPlatformSettings(
    input: UpdateAgentPlatformSettingsRequest,
  ): Promise<AgentPlatformSettings> {
    return this.request("/api/v1/agents/settings", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }
  agentTools(): Promise<AgentToolDefinition[]> {
    return this.request("/api/v1/agent-tools");
  }
  invokeAgentTool<T>(name: string, input: InvokeAgentToolRequest): Promise<T> {
    return this.request(`/api/v1/agent-tools/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  agentToolConfirmations(
    status:
      | "pending"
      | "approved"
      | "denied"
      | "completed"
      | "failed"
      | "expired"
      | "all" = "pending",
  ): Promise<AgentToolConfirmation[]> {
    return this.request(
      `/api/v1/agents/tool-confirmations?status=${encodeURIComponent(status)}`,
    );
  }
  approveAgentToolConfirmation(id: string): Promise<AgentToolConfirmation> {
    return this.request(
      `/api/v1/agents/tool-confirmations/${encodeURIComponent(id)}/approve`,
      { method: "POST" },
    );
  }
  denyAgentToolConfirmation(id: string): Promise<AgentToolConfirmation> {
    return this.request(
      `/api/v1/agents/tool-confirmations/${encodeURIComponent(id)}/deny`,
      { method: "POST" },
    );
  }
  invokeAgent(id: string, input: InvokeAgentRequest): Promise<AgentRun> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}/invoke`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  agentRuns(id: string): Promise<AgentRunPage> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}/runs`);
  }
  agentRun(runID: string): Promise<AgentRun> {
    return this.request(`/api/v1/agent-runs/${encodeURIComponent(runID)}`);
  }
  agentUsage(id: string): Promise<AgentUsageReport> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}/usage`);
  }
  cancelAgentRun(runID: string): Promise<AgentRun> {
    return this.request(
      `/api/v1/agent-runs/${encodeURIComponent(runID)}/cancel`,
      { method: "POST" },
    );
  }
  async claimAgentRun(
    input: ClaimAgentRunRequest,
  ): Promise<ClaimedAgentRun | null> {
    return (
      (await this.request<ClaimedAgentRun | undefined>(
        "/api/v1/agent-runtime/runs/claim",
        { method: "POST", body: JSON.stringify(input) },
      )) ?? null
    );
  }
  heartbeatAgentRun(
    runID: string,
    input: AgentRunLeaseRequest,
  ): Promise<AgentRun> {
    return this.request(
      `/api/v1/agent-runtime/runs/${encodeURIComponent(runID)}/heartbeat`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  publishAgentRun(id: string, input: PublishAgentRunRequest): Promise<Message> {
    return this.request(
      `/api/v1/agent-runtime/runs/${encodeURIComponent(id)}/publish`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  completeAgentRun(
    runID: string,
    input: CompleteAgentRunRequest,
  ): Promise<AgentRun> {
    return this.request(
      `/api/v1/agent-runtime/runs/${encodeURIComponent(runID)}/complete`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  failAgentRun(runID: string, input: FailAgentRunRequest): Promise<AgentRun> {
    return this.request(
      `/api/v1/agent-runtime/runs/${encodeURIComponent(runID)}/fail`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  agentRuntimeCheckpoint(consumer: string): Promise<AgentRuntimeCheckpoint> {
    return this.request(
      `/api/v1/agent-runtime/checkpoints/${encodeURIComponent(consumer)}`,
    );
  }
  updateAgentRuntimeCheckpoint(
    consumer: string,
    input: UpdateAgentRuntimeCheckpointRequest,
  ): Promise<AgentRuntimeCheckpoint> {
    return this.request(
      `/api/v1/agent-runtime/checkpoints/${encodeURIComponent(consumer)}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  }
  agentProviderCredential(id: string): Promise<AgentProviderCredentialView> {
    return this.request(
      `/api/v1/agents/${encodeURIComponent(id)}/provider-credentials`,
    );
  }
  updateAgentProviderCredential(
    id: string,
    input: UpdateAgentProviderCredentialRequest,
  ): Promise<AgentProviderCredentialView> {
    return this.request(
      `/api/v1/agents/${encodeURIComponent(id)}/provider-credentials`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  }
  agentLlmConnections(): Promise<AgentLlmConnection[]> {
    return this.request("/api/v1/agent-connections");
  }
  agentLlmConnection(id: string): Promise<AgentLlmConnection> {
    return this.request(`/api/v1/agent-connections/${encodeURIComponent(id)}`);
  }
  createAgentLlmConnection(
    input: CreateAgentLlmConnectionRequest,
  ): Promise<AgentLlmConnection> {
    return this.request("/api/v1/agent-connections", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  updateAgentLlmConnection(
    id: string,
    input: UpdateAgentLlmConnectionRequest,
  ): Promise<AgentLlmConnection> {
    return this.request(`/api/v1/agent-connections/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }
  deleteAgentLlmConnection(id: string): Promise<void> {
    return this.request(`/api/v1/agent-connections/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
  testAgentLlmConnection(id: string): Promise<AgentLlmConnection> {
    return this.request(
      `/api/v1/agent-connections/${encodeURIComponent(id)}/test`,
      { method: "POST" },
    );
  }
  agentMcpServers(id: string): Promise<AgentMcpServer[]> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}/mcp-servers`);
  }
  createAgentMcpServer(
    id: string,
    input: CreateAgentMcpServerRequest,
  ): Promise<AgentMcpServer> {
    return this.request(
      `/api/v1/agents/${encodeURIComponent(id)}/mcp-servers`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  updateAgentMcpServer(
    id: string,
    serverID: string,
    input: UpdateAgentMcpServerRequest,
  ): Promise<AgentMcpServer> {
    return this.request(
      `/api/v1/agents/${encodeURIComponent(id)}/mcp-servers/${encodeURIComponent(serverID)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }
  deleteAgentMcpServer(id: string, serverID: string): Promise<void> {
    return this.request(
      `/api/v1/agents/${encodeURIComponent(id)}/mcp-servers/${encodeURIComponent(serverID)}`,
      { method: "DELETE" },
    );
  }
  agentRuntimeMcpServers(
    input: AgentRuntimeRunLeaseRequest,
  ): Promise<AgentRuntimeMcpServer[]> {
    return this.request("/api/v1/agent-runtime/mcp-servers", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  startAgentMcpToolCall(
    input: StartAgentMcpToolCallRequest,
  ): Promise<AgentMcpToolCall> {
    return this.request("/api/v1/agent-runtime/mcp-tool-calls", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  finishAgentMcpToolCall(
    callID: string,
    input: FinishAgentMcpToolCallRequest,
  ): Promise<void> {
    return this.request(
      `/api/v1/agent-runtime/mcp-tool-calls/${encodeURIComponent(callID)}/finish`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  startAgentProviderCall(
    input: StartAgentProviderCallRequest,
  ): Promise<AgentProviderCall> {
    return this.request("/api/v1/agent-runtime/provider-calls", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  finishAgentProviderCall(
    callID: string,
    input: FinishAgentProviderCallRequest,
  ): Promise<AgentProviderCall> {
    return this.request(
      `/api/v1/agent-runtime/provider-calls/${encodeURIComponent(callID)}/finish`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  async agentRuntimeProviderChat(
    input: AgentProviderProxyRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (this.accessToken)
      headers.set("Authorization", `Bearer ${this.accessToken}`);
    const response = await fetch(
      `${this.apiURL}/api/v1/agent-runtime/provider/chat`,
      {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify(input),
        signal,
      },
    );
    if (!response.ok) {
      let payload: Partial<APIErrorPayload> = {};
      try {
        payload = (await response.json()) as APIErrorPayload;
      } catch {
        /* core returned a non-JSON gateway failure */
      }
      throw new APIError(
        response.status,
        payload.code ?? "request_failed",
        payload.message ?? "Provider request failed.",
      );
    }
    return response;
  }
  agentTriggers(id: string): Promise<AgentTrigger[]> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}/triggers`);
  }
  createAgentTrigger(
    id: string,
    input: CreateAgentTriggerRequest,
  ): Promise<AgentTrigger> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}/triggers`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  updateAgentTrigger(
    id: string,
    triggerID: string,
    input: UpdateAgentTriggerRequest,
  ): Promise<AgentTrigger> {
    return this.request(
      `/api/v1/agents/${encodeURIComponent(id)}/triggers/${encodeURIComponent(triggerID)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }
  deleteAgentTrigger(id: string, triggerID: string): Promise<void> {
    return this.request(
      `/api/v1/agents/${encodeURIComponent(id)}/triggers/${encodeURIComponent(triggerID)}`,
      { method: "DELETE" },
    );
  }
  createAgent(input: CreateAgentRequest): Promise<Agent> {
    return this.request("/api/v1/agents", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  agent(id: string): Promise<Agent> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}`);
  }
  updateAgent(id: string, input: UpdateAgentRequest): Promise<Agent> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }
  deleteAgent(id: string): Promise<void> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
  duplicateAgent(id: string, input: DuplicateAgentRequest): Promise<Agent> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}/duplicate`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  resetAgentRecipe(id: string): Promise<Agent> {
    return this.request(
      `/api/v1/agents/${encodeURIComponent(id)}/reset-recipe`,
      { method: "POST" },
    );
  }
  agentVersions(id: string): Promise<AgentVersion[]> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}/versions`);
  }
  publishAgent(id: string): Promise<Agent> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}/publish`, {
      method: "POST",
    });
  }
  pauseAgent(id: string): Promise<Agent> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}/pause`, {
      method: "POST",
    });
  }
  resumeAgent(id: string): Promise<Agent> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}/resume`, {
      method: "POST",
    });
  }
  rollbackAgent(id: string, versionID: string): Promise<Agent> {
    return this.request(
      `/api/v1/agents/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionID)}/rollback`,
      { method: "POST" },
    );
  }
  agentKeys(id: string): Promise<AgentApiKey[]> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}/keys`);
  }
  createAgentKey(
    id: string,
    input: CreateAgentKeyRequest,
  ): Promise<CreatedAgentApiKey> {
    return this.request(`/api/v1/agents/${encodeURIComponent(id)}/keys`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  revokeAgentKey(id: string, keyID: string): Promise<void> {
    return this.request(
      `/api/v1/agents/${encodeURIComponent(id)}/keys/${encodeURIComponent(keyID)}`,
      { method: "DELETE" },
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
  putMyAvatar(file: Blob): Promise<AvatarUpdate> {
    return this.request("/api/v1/me/avatar", {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
  }
  deleteMyAvatar(): Promise<AvatarUpdate> {
    return this.request("/api/v1/me/avatar", { method: "DELETE" });
  }
  putOrganizationMemberAvatar(
    actorID: string,
    file: Blob,
  ): Promise<AvatarUpdate> {
    return this.request(
      `/api/v1/organization/members/${encodeURIComponent(actorID)}/avatar`,
      { method: "PUT", headers: { "Content-Type": file.type }, body: file },
    );
  }
  deleteOrganizationMemberAvatar(actorID: string): Promise<AvatarUpdate> {
    return this.request(
      `/api/v1/organization/members/${encodeURIComponent(actorID)}/avatar`,
      { method: "DELETE" },
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
  organizationAudit(
    filters: {
      limit?: number;
      category?: string;
      actor_id?: string;
      from?: string;
      to?: string;
      after_id?: string;
    } = {},
  ): Promise<AuditPage> {
    const query = new URLSearchParams();
    query.set("limit", String(filters.limit ?? 50));
    for (const key of [
      "category",
      "actor_id",
      "from",
      "to",
      "after_id",
    ] as const) {
      if (filters[key]) query.set(key, filters[key]);
    }
    return this.request(`/api/v1/organization/audit?${query}`);
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
  actorAvatar(actorID: string): Promise<Blob> {
    return this.requestBlob(
      `/api/v1/actors/${encodeURIComponent(actorID)}/avatar`,
    );
  }
  createFileUpload(input: {
    name: string;
    mime: string;
    size: number;
    sha256?: string;
  }): Promise<FileUpload> {
    return this.request("/api/v1/files/uploads", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  signFileUploadParts(
    uploadID: string,
    partNumbers: number[],
  ): Promise<{
    parts: Array<{ number: number; url: string }>;
  }> {
    return this.request(
      `/api/v1/files/uploads/${encodeURIComponent(uploadID)}/parts`,
      { method: "POST", body: JSON.stringify({ part_numbers: partNumbers }) },
    );
  }
  completeFileUpload(
    uploadID: string,
    parts: CompletedFilePart[] = [],
  ): Promise<FileMetadata> {
    return this.request(
      `/api/v1/files/uploads/${encodeURIComponent(uploadID)}/complete`,
      { method: "POST", body: JSON.stringify({ parts }) },
    );
  }
  abortFileUpload(uploadID: string): Promise<void> {
    return this.request(
      `/api/v1/files/uploads/${encodeURIComponent(uploadID)}`,
      { method: "DELETE" },
    );
  }
  file(fileID: string): Promise<FileMetadata> {
    return this.request(`/api/v1/files/${encodeURIComponent(fileID)}`);
  }
  downloadFile(fileID: string): Promise<Blob> {
    return this.requestBlob(
      `/api/v1/files/${encodeURIComponent(fileID)}/download`,
    );
  }
  search(filters: {
    q: string;
    chat_id?: string;
    author_id?: string;
    from?: string;
    to?: string;
    type?: "all" | "message" | "file";
    in_thread?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<SearchPage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return this.request(`/api/v1/search?${query}`);
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
  resetChatNotifications(chatID: string): Promise<ChatNotificationPreferences> {
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
  private async requestBlob(path: string, retry = true): Promise<Blob> {
    const headers = new Headers();
    if (this.accessToken)
      headers.set("Authorization", `Bearer ${this.accessToken}`);
    const response = await fetch(`${this.apiURL}${path}`, {
      headers,
      credentials: "include",
    });
    if (response.status === 401 && retry) {
      await this.refresh();
      return this.requestBlob(path, false);
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
    return response.blob();
  }
}
