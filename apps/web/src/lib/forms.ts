export function formValue(data: FormData, name: string) {
  return String(data.get(name) ?? "").trim();
}

export function base64Key(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

/** Lowercase latin letters, digits and dashes; suggests a normalised slug. */
export function suggestSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export const slugPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const handlePattern = /^[a-z0-9][a-z0-9._-]{1,31}$/;
