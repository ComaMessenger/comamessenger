import { File } from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { LocalFile } from "./upload";

export type PickSource = "photos" | "camera" | "file";

/**
 * Size of the file that will be uploaded. The picker's own figure can be the
 * size of the original: Android re-encodes a picked photo (quality below 1)
 * into a new file but reports the gallery file's size, and the server then
 * rejects the upload as not matching. The local copy is authoritative.
 */
function sizeOf(uri: string, reported?: number | null) {
  try {
    const actual = new File(uri).size;
    if (actual > 0) return actual;
  } catch {
    // Not a readable local file: fall back to what the picker reported.
  }
  return reported && reported > 0 ? reported : 0;
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
    orderedSelection: true,
    // iOS re-encodes picked videos to H.264 720p: plays everywhere and
    // keeps a minute of video around 40 MB, under the server's file limit.
    // Android hands the original over; the size limit is checked after.
    videoExportPreset: ImagePicker.VideoExportPreset.H264_1280x720,
    videoQuality: ImagePicker.UIImagePickerControllerQualityType.IFrame960x540,
    videoMaxDuration: 600,
  };
  const result =
    source === "camera"
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled) return [];
  return result.assets.map((asset, index) => ({
    uri: asset.uri,
    name:
      asset.fileName ??
      (asset.type === "video"
        ? `video-${Date.now()}-${index}.mp4`
        : `photo-${Date.now()}-${index}.jpg`),
    mime:
      asset.mimeType ?? (asset.type === "video" ? "video/mp4" : "image/jpeg"),
    size: sizeOf(asset.uri, asset.fileSize),
    ...(asset.width > 0 && asset.height > 0
      ? { width: asset.width, height: asset.height }
      : {}),
    ...(asset.duration ? { durationMs: Math.round(asset.duration) } : {}),
  }));
}
