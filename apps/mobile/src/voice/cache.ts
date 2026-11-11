import { Directory, File, Paths } from "expo-file-system";
import type { MessengerAPI } from "@comamessenger/core";
import { absoluteURL, authorization } from "@/files/auth";

/**
 * Voice files downloaded for playback, kept for the app session only: the
 * folder is emptied the first time it is used after launch and on sign-out,
 * so recordings do not pile up in the cache or outlive the account.
 */
const folder = () => new Directory(Paths.cache, "voice");
let swept = false;
const downloads = new Map<string, Promise<string>>();

function ready(): Directory {
  const directory = folder();
  if (!swept) {
    swept = true;
    try {
      if (directory.exists) directory.delete();
    } catch {
      // A leftover from the last session is harmless.
    }
  }
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

function target(fileID: string) {
  return new File(ready(), `${fileID.replace(/[^\w-]/g, "_")}.m4a`);
}

/** Local URI of a voice file, downloading it through the file link once. */
export function voiceFileURI(
  api: MessengerAPI,
  fileID: string,
): Promise<string> {
  const local = target(fileID);
  if (local.exists && (local.size ?? 0) > 0) return Promise.resolve(local.uri);
  const running = downloads.get(fileID);
  if (running) return running;
  const download = (async () => {
    const link = await api.fileLink(fileID);
    const partial = new File(ready(), `${local.name}.part`);
    if (partial.exists) partial.delete();
    await File.downloadFileAsync(absoluteURL(api, link.url), partial, {
      headers: link.authenticated
        ? { Authorization: await authorization(api) }
        : undefined,
      idempotent: true,
    });
    // Renamed only when complete, so a broken download is never played.
    partial.moveSync(local);
    return local.uri;
  })().finally(() => downloads.delete(fileID));
  downloads.set(fileID, download);
  return download;
}

/** Keeps a just-sent recording as the cached copy of its uploaded file. */
export function adoptRecording(fileID: string, uri: string) {
  try {
    const source = new File(uri);
    const local = target(fileID);
    if (local.exists) source.delete();
    else source.moveSync(local);
  } catch {
    try {
      new File(uri).delete();
    } catch {
      // Already gone.
    }
  }
}

export function clearVoiceCache() {
  downloads.clear();
  swept = true;
  try {
    const directory = folder();
    if (directory.exists) directory.delete();
  } catch {
    // Nothing to clear.
  }
}
