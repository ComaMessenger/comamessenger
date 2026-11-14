import { File, UploadType } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { MessengerAPI } from "@comamessenger/core";
import { withAuthorization } from "./auth";

export type PickedImage = { uri: string; mime: string };

export class ImageTooLarge extends Error {}

/**
 * Lets the user pick a square photo. iOS exports HEIC as JPEG, since the
 * server takes PNG, JPEG and WebP only. With `maxSide` the picture is scaled
 * down (logos and favicons have a size limit). Null when cancelled.
 */
export async function pickSquareImage(
  options: { maxSide?: number; png?: boolean } = {},
): Promise<PickedImage | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.85,
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  const mime =
    asset.mimeType && /^image\/(png|jpeg|webp)$/.test(asset.mimeType)
      ? asset.mimeType
      : "image/jpeg";
  if (!options.maxSide) return { uri: asset.uri, mime };
  const context = ImageManipulator.manipulate(asset.uri);
  if (asset.width > options.maxSide)
    context.resize({ width: options.maxSide, height: options.maxSide });
  const image = await context.renderAsync();
  const png = options.png || mime === "image/png";
  const saved = await image.saveAsync({
    format: png ? SaveFormat.PNG : SaveFormat.JPEG,
    compress: png ? 1 : 0.9,
  });
  return { uri: saved.uri, mime: png ? "image/png" : "image/jpeg" };
}

/** PUTs a picked image to an API path with the session token. */
export async function uploadImage(
  api: MessengerAPI,
  path: string,
  image: PickedImage,
  maxBytes?: number,
): Promise<void> {
  const file = new File(image.uri);
  if (maxBytes && file.size > maxBytes) throw new ImageTooLarge();
  const response = await withAuthorization(api, (authorization) =>
    file.upload(`${api.apiURL}${path}`, {
      httpMethod: "PUT",
      uploadType: UploadType.BINARY_CONTENT,
      headers: { "Content-Type": image.mime, Authorization: authorization },
    }),
  );
  if (response.status === 413) throw new ImageTooLarge();
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Image upload failed with HTTP ${response.status}.`);
}
