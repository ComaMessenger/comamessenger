import { randomUUID } from "expo-crypto";

// packages/core uses crypto.randomUUID for request and client message IDs;
// Hermes does not provide it.
const scope = globalThis as { crypto?: { randomUUID?: () => string } };
if (!scope.crypto?.randomUUID)
  scope.crypto = Object.assign(scope.crypto ?? {}, { randomUUID });
