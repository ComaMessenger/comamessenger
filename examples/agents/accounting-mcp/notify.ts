// Sends a signed event to a Coma incoming webhook, the way an accounting
// system would report that a slot became free.
//
//   COMA_WEBHOOK_URL=https://coma.example.com/api/v1/hooks/<id> \
//   COMA_WEBHOOK_SECRET=whsec_... npm run notify -- s-2
import { createHmac, randomUUID } from "node:crypto";

/** Signature over "<timestamp>.<delivery id>.<raw body>" with HMAC-SHA256. */
export function sign(
  secret: string,
  timestamp: string,
  deliveryID: string,
  body: string,
): string {
  return (
    "sha256=" +
    createHmac("sha256", secret)
      .update(`${timestamp}.${deliveryID}.${body}`)
      .digest("hex")
  );
}

export async function notify(
  url: string,
  secret: string,
  event: string,
  payload: unknown,
) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const deliveryID = randomUUID();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Coma-Timestamp": timestamp,
      "X-Coma-Delivery": deliveryID,
      "X-Coma-Event": event,
      "X-Coma-Signature": sign(secret, timestamp, deliveryID, body),
    },
    body,
  });
  return { status: response.status, body: await response.text() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.COMA_WEBHOOK_URL;
  const secret = process.env.COMA_WEBHOOK_SECRET;
  if (!url || !secret) {
    console.error("Set COMA_WEBHOOK_URL and COMA_WEBHOOK_SECRET");
    process.exit(2);
  }
  const slot = process.argv[2] ?? "s-2";
  const result = await notify(url, secret, "slot.released", {
    slot_id: slot,
    date: "2026-11-12",
    reason: "instructor_sick_leave",
  });
  console.log(result.status, result.body);
}
