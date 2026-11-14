import { Directory, File, Paths } from "expo-file-system";
import type { KnowledgeDocument, MessengerAPI } from "@comamessenger/core";
import { absoluteURL, authorization } from "@/files/auth";

/**
 * The original upload of a file document in the app's private cache,
 * downloaded once per content version: opened again offline, it is still
 * there. Nothing lands in public storage unless the reader shares it.
 */
export async function downloadSource(
  api: MessengerAPI,
  document: Pick<KnowledgeDocument, "id" | "title" | "file_name" | "content_version">,
): Promise<File> {
  const directory = new Directory(
    Paths.cache,
    "knowledge",
    document.id,
    String(document.content_version),
  );
  const name = (document.file_name || document.title).replace(/[/\\]/g, "_");
  const target = new File(directory, name);
  if (target.exists) return target;
  if (!directory.exists) directory.create({ intermediates: true });
  const link = await api.knowledgeDocumentFileLink(document.id);
  await File.downloadFileAsync(absoluteURL(api, link.url), target, {
    headers: link.authenticated
      ? { Authorization: await authorization(api) }
      : undefined,
    idempotent: true,
  });
  return target;
}

/** Text formats above this size are offered to other apps, not rendered. */
export const textPreviewBytes = 2_000_000;
/** Characters of a text file shown on screen. */
export const textPreviewChars = 200_000;
