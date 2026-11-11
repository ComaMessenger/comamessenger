# Files, object storage and search runbook

## Operating modes

The default installation uses `STORAGE_DRIVER=local` and the named Compose
volume `files-data`. The volume is mounted at `/var/lib/coma/files`; PostgreSQL
stores only metadata, object keys, checksums and quota counters. Local storage
supports exactly one Core instance. Run two or more Core instances only with
`STORAGE_DRIVER=s3` (or a separately reviewed shared-storage implementation).

Defaults:

| Setting | Default | Meaning |
| --- | ---: | --- |
| `LOCAL_STORAGE_QUOTA_BYTES` | 2 GiB | logical quota per organization |
| `LOCAL_STORAGE_MIN_FREE_BYTES` | 256 MiB | filesystem safety reserve |
| `FILE_MAX_BYTES` | 100 MiB | maximum original file size |
| `FILE_MULTIPART_THRESHOLD_BYTES` | 16 MiB | S3 multipart threshold |
| `FILE_UPLOAD_TTL` | 24 h | upload reservation and unattached-file TTL |
| `FILE_PRESIGN_TTL` | 15 min | upload/download URL lifetime |

When quota or the free-space guard is reached, new writes return HTTP 507
`storage_full`. Reads and messaging remain available. Do not solve this by
lowering the free-space reserve below what PostgreSQL and the host need.

## S3 configuration

Set `STORAGE_DRIVER=s3`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY` and
`S3_SECRET_KEY`. `S3_ENDPOINT` is the address Core uses; `S3_PUBLIC_ENDPOINT`
is optional and must be reachable by browsers when it differs from the
container-network address. `S3_PREFIX` isolates an installation inside a
bucket. Secrets belong in the deployment secret store, never in frontend
environment variables.

| Backend | Endpoint/addressing | Contract status |
| --- | --- | --- |
| Local filesystem | no S3 settings | automated contract on every test run |
| versitygw, Compose profile `s3gw` (new installations) | `http://s3gw:9000`, host port 9100, path style | contract, copy `if-match` (412), upload sealing and wrong-storage reconciliation run in CI on every push (since 2026-11-11) |
| MinIO, Compose profile `s3` (existing installations, staging) | `http://minio:9000`, path style | live contract passed 2026-08-21; the `minio/minio` image is no longer published, keep the local one |
| AWS S3 | regional endpoint, virtual-host style (`S3_FORCE_PATH_STYLE=false`) | same opt-in release contract |
| Yandex Object Storage | `https://storage.yandexcloud.net`; use provider region and normally path style | same opt-in release contract |
| Selectel S3 | endpoint and pool/region shown in the Selectel panel, path style by default | same opt-in release contract; legacy pre-2023 settings must be migrated before 2026-09-15 |

Provider references: [AWS S3 endpoints](https://docs.aws.amazon.com/general/latest/gr/s3.html),
[Yandex S3 API](https://yandex.cloud/en/docs/storage/s3/), and
[Selectel S3 API](https://docs.selectel.ru/en/api/object-storage-s3/).

For direct browser upload, bucket CORS must allow the application origin,
`PUT` and `GET`, requested `Content-Type` headers, and expose `ETag` for
multipart completion. Keep the bucket private: access is granted only through
short-lived signed URLs after Core authorization.

A provider must honour `x-amz-copy-source-if-match`: Core copies every
presigned or multipart upload to a key the client never saw before checking
and serving it, pinned to the ETag it read, so a still-valid upload URL
cannot replace a checked object. `TestConfiguredS3CopyHonorsSourceETag` fails
on a provider that ignores the header.

A single presigned PUT URL lives at most 5 minutes; part URLs of a multipart
upload and download URLs keep `FILE_PRESIGN_TTL`. Clients re-sign a part
whose URL expired and retry `complete` on 429/503 after `Retry-After`.

### Bucket ownership and reconciliation

Give Core its own bucket, or at least its own `S3_PREFIX`. Reconciliation
only ever touches keys Core writes (`objects/…`, `previews/…`, `avatars/…`;
`files.OwnedKey`), with or without a prefix, so other applications in a
shared bucket are left alone, but a shared bucket without a prefix still
mixes listings and quotas.

Reconciliation never deletes the object of a file that was ever ready
(`ready_at` set). It stops without changing anything, logging
`file storage looks misconfigured`, when the bucket is missing, when the
bucket holds no Core objects while files exist, or when at least 3 and at
least 10 % of the checked files lack their objects in one pass. A single
missing object is noted (`missing_since`) and fails its file only if still
missing an hour later; when the object comes back the file is ready again.
Only files that failed before they were ever ready are retired (status
`deleted`, their key becomes an orphan) once every upload URL expired,
counted from the failure. Multipart uploads nobody completed (client uploads
past their TTL, interrupted server-side copies) are aborted, again only for
Core keys. On AWS or another managed provider you may add a lifecycle rule as
a second line of defence:

```json
{"Rules": [{"ID": "abort-incomplete-multipart", "Status": "Enabled",
  "Filter": {"Prefix": "objects/"},
  "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}}]}
```

At startup Core refuses to run when the bucket does not exist (`file storage
check failed: the bucket must exist`) and warns when it exists but holds none
of the most recent files.

### Bundled storage profiles

- **Existing installations (staging included)** run MinIO under the `s3`
  profile, unchanged: `S3_ENDPOINT=http://minio:9000`, host port 9000.
  `deploy/deploy.sh` rebuilds and restarts only `core`, `web` and
  `agent-runtime`; the MinIO container keeps running and is not recreated.
  Nothing has to be changed after updating.
- **New installations** use versitygw under the `s3gw` profile (posix
  backend, pinned by digest, host port `S3_GATEWAY_PORT`, default 9100):

  ```sh
  docker compose --env-file .env -f deploy/compose.yaml --profile s3gw up -d --wait s3gw
  docker compose --env-file .env -f deploy/compose.yaml --profile s3gw up s3gw-init
  ```

  `S3_GATEWAY_ACCESS_KEY`/`S3_GATEWAY_SECRET_KEY` have no default and the
  gateway refuses to start without them (`deploy/generate-env.sh` creates
  them). `s3gw-volume-init` creates the bucket `S3_BUCKET` as a directory;
  `s3gw-init` sets bucket CORS for `PUBLIC_APP_URL` (GET, PUT, HEAD; exposes
  `ETag`; other origins get 403). Set `S3_ENDPOINT=http://s3gw:9000`,
  `S3_FORCE_PATH_STYLE=true`, `S3_ACCESS_KEY`/`S3_SECRET_KEY` to the gateway
  pair, and in nginx proxy the bucket location to `coma_s3gw`
  (`deploy/nginx/coma.conf.example`).

### Moving from MinIO to the gateway

versitygw cannot read MinIO's data directory, so objects are copied. MinIO is
never changed, which keeps the way back open. Performed end to end on
2026-11-11 against a local copy of the Compose stack: MinIO with objects,
the copy, Core on the gateway, Core refusing a missing bucket and warning on
an empty one, and the rollback.

1. Add the gateway key pair to `.env`:
   `S3_GATEWAY_ACCESS_KEY=coma$(openssl rand -hex 8)` and
   `S3_GATEWAY_SECRET_KEY=$(openssl rand -hex 32)`. Make sure the Docker
   host has free space for the bucket twice (gateway volume and a temporary
   copy).
2. Stop uploads: `docker compose --env-file .env -f deploy/compose.yaml stop core`.
3. Copy and verify: `./deploy/migrate-minio-to-s3gw.sh`. It starts `s3gw`
   next to MinIO, sets CORS, copies the bucket and compares keys, sizes and
   SHA-256 of every object; it stops with an error on any difference.
4. Switch Core: in `.env` set `S3_ENDPOINT=http://s3gw:9000`,
   `S3_ACCESS_KEY`/`S3_SECRET_KEY` to the gateway pair; in nginx proxy the
   bucket location to `coma_s3gw` and reload nginx.
5. Start Core: `docker compose --env-file .env -f deploy/compose.yaml up -d --wait core`.
   Its log must not contain `file storage check failed` or
   `file storage looks empty`. Open an old file in the app.
6. Rollback, if needed: restore the previous `S3_*` values and nginx, then
   start Core again. Files uploaded after the switch exist only on the
   gateway; copy them back the same way before switching.
7. After a week without problems stop MinIO
   (`docker compose --env-file .env -f deploy/compose.yaml --profile s3 stop minio`).
   Keep its volume until a backup of the gateway volume exists.

Run the exact contract against the profile or a real provider:

```sh
TEST_S3_ENDPOINT=https://provider-endpoint \
TEST_S3_PUBLIC_ENDPOINT=https://provider-endpoint \
TEST_S3_REGION=provider-region \
TEST_S3_BUCKET=comamessenger-contract \
TEST_S3_ACCESS_KEY=... \
TEST_S3_SECRET_KEY=... \
TEST_S3_FORCE_PATH_STYLE=true \
go test ./internal/storage -run TestConfiguredS3 -count=1 -v
```

Use a disposable private bucket/prefix. The suite exercises put, head, get,
presigned get, delete, multipart completion and multipart abort, and cleans up
its objects. A live external-provider run remains a release gate because
credentials are intentionally not committed to the repository.

## Lifecycle and reconciliation

Core atomically reserves quota before issuing an upload. Completion moves the
reservation to used bytes. Abort, failed validation and expired sessions return
the reservation. Ready files that were never attached to a message, avatar or knowledge document
are deleted after `FILE_UPLOAD_TTL`; attachment and cleanup lock the same row so
they cannot race.

The reconciliation worker checks expired sessions, missing or size-mismatched
blobs, quota ledgers and old orphan objects. It logs non-zero counters as
`file reconciliation completed`. River jobs are visible in `river_job`; file
state is visible in `files.processing_status`. A failed preview or extraction
does not make the original download unavailable. Optional malware scanning is
installed through `files.ProcessorHook`; returning `files.ErrUnsafeContent`
rejects content permanently, while other errors are retried by River.

Useful PostgreSQL checks:

```sql
SELECT status, processing_status, count(*) FROM files GROUP BY 1, 2 ORDER BY 1, 2;
SELECT state, kind, count(*) FROM river_job GROUP BY 1, 2 ORDER BY 1, 2;
SELECT org_id, used_bytes, reserved_bytes, quota_bytes FROM organization_storage_usage;
SELECT count(*) FROM file_uploads WHERE status IN ('active','uploading') AND expires_at < now();
```

Message deletion immediately removes messages and attached extracted text from
search and from recipient download authorization. Phase 4 intentionally keeps
the underlying attachment for the workspace lifetime; uploader access remains
available. Expired unattached uploads and replaced/deleted avatars are removed
physically. A future workspace-retention feature must define bulk attachment
deletion separately rather than silently changing this policy.

## Knowledge base indexing

Knowledge documents are uploaded through the regular file upload flow and then
attached with `POST /api/v1/knowledge/collections/{id}/documents`; Markdown
pages are stored in `knowledge_documents.body`. A file referenced by a document
is excluded from unattached-file cleanup; deleting the document releases it to
the regular cleanup after `FILE_UPLOAD_TTL`.

Indexing runs as River jobs in the `knowledge-indexing` queue:
`knowledge.index` extracts text (text/*, Markdown, CSV, XLSX, DOCX, PDF), cuts
it into fragments of up to 2000 characters on section boundaries and replaces
`knowledge_chunks` atomically; `knowledge.embed` runs only when the collection
has an embedding connection with `embedding_model` set and
`embedding_data_sharing_approved=true`, otherwise search stays full-text only.
Each job carries the document `content_version`, so a stale job for an edited
page is a no-op. Failed documents keep `status='failed'` and `error_code`
(`unsupported_format`, `file_unavailable`, `no_text_extracted`,
`empty_document`, `indexing_failed`); scanned PDFs without a text layer end in
`no_text_extracted` because OCR is out of scope.

Access follows the collection, not the file: anyone who may read a collection
(every member for `organization`, members of the listed chats for `chats`,
every holder of `knowledge.manage`) gets the extracted fragments through
`GET /api/v1/knowledge/documents/{id}/fragments` and the original upload
through `GET /api/v1/knowledge/documents/{id}/file`, even when they neither
uploaded the file nor share a chat message with it. `knowledge.manage` is
granted on the workspace members page by the owner or by an administrator
who holds both `members.manage` and `knowledge.manage`; administrators may
grant or revoke it only for regular members other than themselves.

Vector search is an exact scan per collection (no ANN index, because vector
dimensions depend on the configured model). Add an HNSW index per dimension if
a workspace grows beyond roughly 100k fragments.

```sql
SELECT status, embedding_status, count(*) FROM knowledge_documents GROUP BY 1, 2 ORDER BY 1, 2;
SELECT state, kind, count(*) FROM river_job WHERE kind LIKE 'knowledge.%' GROUP BY 1, 2 ORDER BY 1, 2;
SELECT collection_id, count(*), count(embedding) AS embedded FROM knowledge_chunks GROUP BY 1;
```

## Backup and restore

Local blobs and PostgreSQL metadata form one logical backup. For a consistent
snapshot:

1. Put the installation in maintenance mode and stop Core so uploads,
   processors and reconciliation cannot write.
2. Take `pg_dump` (or a database snapshot) and snapshot/archive `files-data`
   while Core remains stopped.
3. Save the storage-related configuration and encryption/signing secrets in
   the deployment secret backup.
4. Start Core and verify `/healthz`.

Restore into an empty installation in the same order: stop Core, restore
PostgreSQL, restore `files-data` with directory mode `0700` and blob mode
`0600`, restore configuration/secrets, then start Core. Watch reconciliation
logs and the SQL checks above. Do not treat a database-only or volume-only copy
as a complete backup.

For external S3, enable provider versioning/backup according to the provider's
policy and still pause Core while taking the PostgreSQL recovery point. After a
point-in-time restore, reconciliation removes old unreferenced objects only
after its safety window and marks metadata whose object is absent.

## Search capacity check

PostgreSQL GIN full-text indexes cover Russian, English and a `simple`
fallback. Membership is joined inside the query before `LIMIT`. The integration
suite loads 10,000 messages and runs 80 searches across eight workers:

```sh
TEST_DATABASE_URL=postgres://... go test ./internal/search -run TestSearchLoadAtTargetVolume -count=1
```

Re-run this test and inspect `EXPLAIN (ANALYZE, BUFFERS)` on release-like data
before raising target volume. Elasticsearch/OpenSearch is not part of Phase 4;
introduce it only after measured PostgreSQL limits justify the operational cost.
