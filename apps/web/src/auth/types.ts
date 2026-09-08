import type { MessengerAPI, TokenResponse } from "@comamessenger/core";

export type AuthProps = {
  api: MessengerAPI;
  error: string;
  onError(value: string): void;
  onAuthenticated(session: TokenResponse): void | Promise<void>;
};

export const passwordMinimum = 10;
