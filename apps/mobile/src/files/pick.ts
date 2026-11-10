import { File } from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { LocalFile } from "./upload";

export type PickSource = "photos" | "camera" | "file";

function sizeOf(uri: string, reported?: number | null) {
  return reported && reported > 0 ? reported : new File(uri).size;
}

/**
 * Opens the system picker. Permission prompts come from the pickers
 * themselves, right after the user chose the source.
 */
export async function pickFiles(
  source: PickSource,
  limit: number,
): Promise<LocalFile[]> {
  if (limit <= 0) return [];
  if (source === "file") {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled) return [];
    return result.assets.map((asset) => ({
      uri: asset.uri,
      name: asset.name,
      mime: asset.mimeType ?? "application/octet-stream",
      size: sizeOf(asset.uri, asset.size),
    }));
  }
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return [];
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ["images", "videos"],
    quality: 0.9,
    allowsMultipleSelection: source === "photos",
    selectionLimit: limit,
  };
  const result =
    source === "camera"
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled) return [];
  return result.assets.map((asset, index) => ({
    uri: asset.uri,
    name: asset.fileName ?? `photo-${Date.now()}-${index}.jpg`,
    mime:
      asset.mimeType ?? (asset.type === "video" ? "video/mp4" : "image/jpeg"),
    size: sizeOf(asset.uri, asset.fileSize),
  }));
}
