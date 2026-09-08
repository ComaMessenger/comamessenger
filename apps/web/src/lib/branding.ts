import type { PublicBranding } from "@comamessenger/core";
import comaLogo from "../assets/coma-logo.svg";

export const apiURL = import.meta.env.VITE_API_URL ?? window.location.origin;

export function brandingLogoURL() {
  return `${apiURL}/api/v1/branding/logo?v=${Date.now()}`;
}

export { comaLogo };

export function applyPublicBranding(branding: PublicBranding, baseURL: string) {
  if (/^#[0-9A-Fa-f]{6}$/.test(branding.accent_color)) {
    const root = document.documentElement.style;
    root.setProperty("--coma-primary", branding.accent_color);
    root.setProperty(
      "--coma-primary-hover",
      `color-mix(in srgb, ${branding.accent_color} 82%, black)`,
    );
    root.setProperty(
      "--coma-primary-soft",
      `color-mix(in srgb, ${branding.accent_color} 14%, transparent)`,
    );
    root.setProperty(
      "--coma-primary-disabled",
      `color-mix(in srgb, ${branding.accent_color} 55%, transparent)`,
    );
  }
  document.title = branding.workspace_name
    ? `${branding.workspace_name} — Coma`
    : "Coma";
  let favicon = document.querySelector<HTMLLinkElement>(
    "link[rel='icon'][data-coma-branding]",
  );
  if (!favicon) {
    favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.dataset.comaBranding = "true";
    document.head.append(favicon);
  }
  favicon.href = branding.favicon_url
    ? `${baseURL}${branding.favicon_url}`
    : comaLogo;
}
