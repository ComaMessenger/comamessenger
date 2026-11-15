/**
 * How a photo from the row of latest ones in «+» is sent. The row reads the
 * library's original file: on an iPhone a HEIC, or a JPEG whose pixels lie
 * as the sensor saw them with the turn in EXIF. Sent as is, it went out as
 * «image/jpeg» whatever it was (a browser cannot show HEIC; the server could
 * not make a preview of it) and, for a JPEG, with a sideways server preview.
 * Like the system picker, such photos are re-encoded to an upright JPEG; a
 * PNG (screenshots) and a GIF keep their bytes.
 */
export type RecentPhotoPlan = {
  reencode: boolean;
  name: string;
  mime: string;
};

export function recentPhotoPlan(
  filename: string | undefined,
  fallback: string,
): RecentPhotoPlan {
  const name = filename?.trim() || fallback;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const stem = dot > 0 ? name.slice(0, dot) : name;
  if (extension === "png") return { reencode: false, name, mime: "image/png" };
  if (extension === "gif") return { reencode: false, name, mime: "image/gif" };
  return { reencode: true, name: `${stem}.jpg`, mime: "image/jpeg" };
}
