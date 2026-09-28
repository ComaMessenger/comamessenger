import { MessengerAPI } from "@comamessenger/core";
import { refreshTokenStore } from "./session";

export function createMessengerAPI(serverURL: string): MessengerAPI {
  return new MessengerAPI(serverURL, undefined, refreshTokenStore);
}
