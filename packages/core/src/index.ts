import type { components } from "@comamessenger/protocol";

export type ServiceHealth = {
  status: "checking" | "ok" | "unavailable";
};

export type User = components["schemas"]["User"];
export type Chat = components["schemas"]["Chat"];
export type DirectoryChat = components["schemas"]["DirectoryChat"];
export type BootstrapRequest = components["schemas"]["BootstrapRequest"];
export type LoginRequest = components["schemas"]["LoginRequest"];
export type CreateChatRequest = components["schemas"]["CreateChatRequest"];
export type AcceptInvitationRequest = components["schemas"]["AcceptInvitationRequest"];
export type TokenResponse = components["schemas"]["TokenResponse"];

type APIErrorPayload = components["schemas"]["Error"];

export class APIError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
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

  constructor(private readonly apiURL: string) {}

  async bootstrapStatus(): Promise<boolean> {
    const result = await this.request<{ bootstrapped: boolean }>("/api/v1/bootstrap/status");
    return result.bootstrapped;
  }

  async bootstrap(input: BootstrapRequest): Promise<TokenResponse> {
    return this.acceptTokens(
      await this.request<TokenResponse>("/api/v1/bootstrap", {
        method: "POST",
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

  refresh(): Promise<TokenResponse> {
    if (!this.refreshRequest) {
      this.refreshRequest = this.request<TokenResponse>(
        "/api/v1/auth/refresh",
        { method: "POST" },
        false,
      )
        .then((tokens) => this.acceptTokens(tokens))
        .finally(() => {
          this.refreshRequest = null;
        });
    }
    return this.refreshRequest;
  }

  async acceptInvitation(token: string, input: AcceptInvitationRequest): Promise<TokenResponse> {
    return this.acceptTokens(
      await this.request<TokenResponse>(`/api/v1/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }

  async logout(): Promise<void> {
    await this.request<void>("/api/v1/auth/logout", { method: "POST" });
    this.accessToken = null;
  }

  async chats(): Promise<Chat[]> {
    return (await this.request<{ chats: Chat[] }>("/api/v1/chats")).chats;
  }

  async createChat(input: CreateChatRequest): Promise<Chat> {
    return this.request<Chat>("/api/v1/chats", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async discoverChats(): Promise<DirectoryChat[]> {
    return (await this.request<{ chats: DirectoryChat[] }>("/api/v1/chats/discover")).chats;
  }

  async joinChat(chatID: string): Promise<Chat> {
    return this.request<Chat>(`/api/v1/chats/${chatID}/join`, { method: "POST" });
  }

  private acceptTokens(tokens: TokenResponse): TokenResponse {
    this.accessToken = tokens.access_token;
    return tokens;
  }

  private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("Content-Type", "application/json");
    if (this.accessToken) headers.set("Authorization", `Bearer ${this.accessToken}`);

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
        // A stable fallback is still useful when a proxy returns a non-JSON error.
      }
      throw new APIError(response.status, payload.code ?? "request_failed", payload.message ?? "Request failed.");
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
