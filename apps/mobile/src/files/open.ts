import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import type { FileMetadata, MessengerAPI } from "@comamessenger/core";
import { absoluteURL, authorization } from "./auth";

/**
 * Downloads an attachment into the app's private cache and hands it to the
 * system viewer or share sheet. Nothing lands in public storage unless the
 * user saves it from there.
 */
export async function openAttachment(
  api: MessengerAPI,
  file: FileMetadata,
): Promise<void> {
  const directory = new Directory(Paths.cache, "attachments", file.id);
  if (!directory.exists) directory.create({ intermediates: true });
  const target = new File(directory, file.name.replace(/[/\\]/g, "_"));
  if (!target.exists) {
    const link = await api.fileLink(file.id);
    await File.downloadFileAsync(absoluteURL(api, link.url), target, {
      headers: link.authenticated
        ? { Authorization: await authorization(api) }
        : undefined,
      idempotent: true,
    });
  }
  await Sharing.shareAsync(target.uri, {
    mimeType: file.mime,
    dialogTitle: file.name,
  });
}
