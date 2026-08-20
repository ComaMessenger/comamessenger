export function sessionLabel(userAgent: string, fallback: string): string {
  if (!userAgent.trim()) return fallback;
  const browser = browserName(userAgent);
  const platform = platformName(userAgent);
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

function platformName(userAgent: string): string {
  if (/iPhone|iPad/.test(userAgent)) return "iOS";
  if (/Android/.test(userAgent)) return "Android";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "macOS";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Linux/.test(userAgent)) return "Linux";
  return "";
}
