import { randomUUID } from "expo-crypto";
// Hermes has no Intl.PluralRules, which ICU plurals in the catalogs need.
// The polyfill installs itself only where the engine lacks it.
import "@formatjs/intl-pluralrules/polyfill.js";
import "@formatjs/intl-pluralrules/locale-data/ru.js";
import "@formatjs/intl-pluralrules/locale-data/en.js";

// packages/core uses crypto.randomUUID for request and client message IDs;
// Hermes does not provide it.
const scope = globalThis as { crypto?: { randomUUID?: () => string } };
if (!scope.crypto?.randomUUID)
  scope.crypto = Object.assign(scope.crypto ?? {}, { randomUUID });
