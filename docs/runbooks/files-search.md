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
| MinIO Compose profile | `http://minio:9000`, path style | live contract passed 2026-08-21 |
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

Start the optional local S3 profile:

```sh
docker compose -f deploy/compose.yaml --profile s3 up -d minio minio-init
```

Run the exact contract against MinIO or a real provider:

```sh
TEST_S3_ENDPOINT=https://provider-endpoint \
TEST_S3_PUBLIC_ENDPOINT=https://provider-endpoint \
TEST_S3_REGION=provider-region \
TEST_S3_BUCKET=comamessenger-contract \
TEST_S3_ACCESS_KEY=... \
TEST_S3_SECRET_KEY=... \
TEST_S3_FORCE_PATH_STYLE=true \
go test ./internal/storage -run TestConfiguredS3BlobStoreContract -count=1 -v
```

Use a disposable private bucket/prefix. The suite exercises put, head, get,
presigned get, delete, multipart completion and multipart abort, and cleans up
its objects. A live external-provider run remains a release gate because
credentials are intentionally not committed to the repository.

## Lifecycle and reconciliation

Core atomically reserves quota before issuing an upload. Completion moves the
reservation to used bytes. Abort, failed validation and expired sessions return
the reservation. Ready files that were never attached to a message or avatar
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
