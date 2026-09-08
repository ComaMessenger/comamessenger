import type { PublicBranding } from "@comamessenger/core";
import comaLogo from "../assets/coma-logo.svg";

export const apiURL = import.meta.env.VITE_API_URL ?? window.location.origin;

export function brandingLogoURL() {
  return `${apiURL}/api/v1/branding/logo?v=${Date.now()}`;
}

export { comaLogo };

export function applyPublicBranding(branding: PublicBranding, baseURL: string) {
  if (/^#[0-9A-Fa-f]{6}$/.test(branding.accent_color)) {
    // The accent lands in a separate variable: theme.css derives --coma-primary
    // from it per theme, so a dark workspace colour stays readable in dark mode.
    const root = document.documentElement;
    root.style.setProperty("--coma-accent", branding.accent_color);
    root.dataset.branded = "true";
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
