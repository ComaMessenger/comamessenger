import { File, UploadType } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import type { MessengerAPI } from "@comamessenger/core";
import { withAuthorization } from "./auth";

/**
 * Lets the user pick a square photo and uploads it as their avatar. The
 * server accepts PNG, JPEG and WebP only, so iOS converts HEIC on export.
 * Returns false when the user cancelled.
 */
export async function pickAndUploadAvatar(api: MessengerAPI): Promise<boolean> {
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
  const mime =
    asset.mimeType && /^image\/(png|jpeg|webp)$/.test(asset.mimeType)
      ? asset.mimeType
      : "image/jpeg";
  const response = await withAuthorization(api, (authorization) =>
    new File(asset.uri).upload(`${api.apiURL}/api/v1/me/avatar`, {
      httpMethod: "PUT",
      uploadType: UploadType.BINARY_CONTENT,
      headers: { "Content-Type": mime, Authorization: authorization },
    }),
  );
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Avatar upload failed with HTTP ${response.status}.`);
  return true;
}
