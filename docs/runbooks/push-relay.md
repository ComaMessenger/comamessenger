# Push relay

The relay forwards encrypted notifications from self-hosted instances to APNs and FCM ([ADR-0012](../decisions/0012-mobile-push-relay.md)). It is operated by the Coma project for the published app; a white-label build runs its own relay with its own keys.

## What the relay stores and sees

- `relay_devices`: opaque handle, platform, APNs/FCM token, timestamps.
- Per notification: handle, AES-256-GCM ciphertext, neutral fallback text («New message»), optional collapse id (a chat id), the instance IP.
- It never sees message text, chat names or authors, and it never logs tokens or ciphertext.

## Configuration

| Variable               | Purpose                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `RELAY_DATABASE_URL`   | PostgreSQL of the relay itself; the table is created on start.             |
| `RELAY_LISTEN`         | Listen address, default `:8090`. Terminate TLS in front of it.             |
| `APNS_KEY_FILE`        | Token-based APNs key (`AuthKey_XXXX.p8`).                                  |
| `APNS_KEY_ID`          | Key ID of that key.                                                        |
| `APNS_TEAM_ID`         | Apple Developer team ID.                                                   |
| `APNS_TOPIC`           | Bundle identifier of the app.                                              |
| `APNS_SANDBOX`         | `true` for development builds signed with a development profile.           |
| `FCM_CREDENTIALS_FILE` | Google service account JSON with the Firebase Cloud Messaging API enabled. |

At least one platform must be configured. Keys are mounted as files and never committed.

```sh
docker build -f core/Dockerfile --target push-relay -t coma-push-relay .
docker run --rm -p 8090:8090 \
  -e RELAY_DATABASE_URL=postgres://… \
  -e APNS_KEY_FILE=/keys/apns.p8 -e APNS_KEY_ID=… -e APNS_TEAM_ID=… -e APNS_TOPIC=… \
  -e FCM_CREDENTIALS_FILE=/keys/fcm.json \
  -v "$PWD/keys:/keys:ro" coma-push-relay
```

Instances point `PUSH_RELAY_URL` at the public HTTPS address of the relay.

## API

| Request                       | Result                                                                      |
| ----------------------------- | --------------------------------------------------------------------------- |
| `POST /v1/devices`            | `{platform, token}` → `201 {handle}`; the app calls it directly.            |
| `PUT /v1/devices/{handle}`    | `{token}` → `204`; token rotation. `410` for an unknown handle.             |
| `DELETE /v1/devices/{handle}` | `204`; the app forgets the device on sign-out of every account.             |
| `POST /v1/send`               | `{handle, ciphertext, fallback_title, fallback_body, collapse_id}` → `202`. |
| `GET /healthz`                | `204`.                                                                      |

`410` from `/v1/send` means the provider reported the token as unregistered or the handle is unknown; instances then delete the device. `429` is rate limiting (per IP for registration, per IP and per handle for sending), `502` a provider failure the instance retries with backoff.

## Operations

- A relay outage delays mobile notifications only; messages, realtime and Web Push are unaffected, and instances retry deliveries with exponential backoff up to an hour.
- Rotating the APNs key: upload the new key, update `APNS_KEY_FILE`/`APNS_KEY_ID`, restart. Handles stay valid.
- Removing stale devices: rows with an old `last_sent_at` can be deleted; instances drop their device on the next `410`.
