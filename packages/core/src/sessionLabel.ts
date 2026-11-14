/**
 * Short device name of a session from its user agent: the browser or app,
 * and the platform. An unrecognized agent shows `fallback`, never the raw
 * string. With `nativeApp` set, requests of the phone app (CFNetwork on iOS,
 * okhttp on Android) are named after it instead of falling back.
 */
export function sessionLabel(
  userAgent: string,
  fallback: string,
  options: { nativeApp?: string } = {},
): string {
  if (!userAgent.trim()) return fallback;
  const app =
    options.nativeApp && /CFNetwork|okhttp|Coma\//.test(userAgent)
      ? options.nativeApp
      : "";
  const browser = app || browserName(userAgent);
  const platform = platformName(userAgent, Boolean(app));
  if (browser && platform) return `${browser} · ${platform}`;
  return browser || platform || fallback;
}

function browserName(userAgent: string): string {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/CriOS\//.test(userAgent)) return "Chrome";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  if (/Safari(?:\/|$)/.test(userAgent)) return "Safari";
  return "";
}

function platformName(userAgent: string, nativeApp: boolean): string {
  if (/iPhone|iPad/.test(userAgent)) return "iOS";
  if (/Android/.test(userAgent)) return "Android";
  // The iOS networking stack reports Darwin, not the device.
  if (nativeApp && /Darwin|CFNetwork/.test(userAgent)) return "iOS";
  if (nativeApp && /okhttp/.test(userAgent)) return "Android";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "macOS";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Linux/.test(userAgent)) return "Linux";
  return "";
}
