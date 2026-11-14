import * as Sharing from "expo-sharing";
import { Asset, requestPermissionsAsync } from "expo-media-library";
import type { FileMetadata, MessengerAPI } from "@comamessenger/core";
import { downloadAttachment, openAttachment } from "@/files/open";

/** The system share sheet with the photo or video itself. */
export async function shareMedia(api: MessengerAPI, file: FileMetadata) {
  if (!(await Sharing.isAvailableAsync())) throw new Error("no sharing");
  await openAttachment(api, file);
}

/**
 * Saves a photo or video to the phone's library. Only adding is asked for
 * (iOS «add photos only»): the app never reads the library here.
 */
export async function saveMediaToPhotos(
  api: MessengerAPI,
  file: FileMetadata,
): Promise<"saved" | "denied"> {
  const permission = await requestPermissionsAsync(true, []);
  if (!permission.granted) return "denied";
  const local = await downloadAttachment(api, file);
  await Asset.create(local.uri);
  return "saved";
}
