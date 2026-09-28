import * as SecureStore from "expo-secure-store";
import type { RefreshTokenStore } from "@comamessenger/core";

const refreshTokenKey = "coma.refresh_token";

// AFTER_FIRST_UNLOCK keeps the token readable while the phone is locked, so
// background resume and push handling can refresh the session.
const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export const refreshTokenStore: RefreshTokenStore = {
  load: () => SecureStore.getItemAsync(refreshTokenKey, options),
  async save(token) {
    if (token) await SecureStore.setItemAsync(refreshTokenKey, token, options);
    else await SecureStore.deleteItemAsync(refreshTokenKey, options);
  },
};
