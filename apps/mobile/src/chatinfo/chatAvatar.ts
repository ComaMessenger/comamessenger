import { File, UploadType } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import type { MessengerAPI } from "@comamessenger/core";
import { withAuthorization } from "@/files/auth";

/** The web accepts PNG and JPEG up to 10 MB for a chat image. */
const maxBytes = 10_000_000;

export class ChatAvatarTooLarge extends Error {}

/**
 * Lets an owner or admin pick a square image for a group or a channel and
 * uploads it as the chat avatar. Returns false when the user cancelled.
 */
export async function pickAndUploadChatAvatar(
  api: MessengerAPI,
  chatID: string,
): Promise<boolean> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.85,
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  });
  if (result.canceled || !result.assets[0]) return false;
  const asset = result.assets[0];
  if (asset.fileSize && asset.fileSize > maxBytes)
    throw new ChatAvatarTooLarge();
  const mime = asset.mimeType === "image/png" ? "image/png" : "image/jpeg";
  const response = await withAuthorization(api, (authorization) =>
    new File(asset.uri).upload(
      `${api.apiURL}/api/v1/chats/${encodeURIComponent(chatID)}/avatar`,
      {
        httpMethod: "PUT",
        uploadType: UploadType.BINARY_CONTENT,
        headers: { "Content-Type": mime, Authorization: authorization },
      },
    ),
  );
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Chat avatar upload failed with HTTP ${response.status}.`);
  return true;
}
