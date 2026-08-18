# ADR-0005: Authentication, sessions and ownership invariants

- Status: accepted
- Date: 2026-08-18

## Context

Phase 1 introduces the first security boundary: one organization, human users, browser sessions, invitations and membership in chats and channels. The implementation must remain safe when several requests race and when an API handler contains a bug.

## Decision

- Passwords use Argon2id with a per-password random salt and versioned parameters stored in the encoded hash.
- Access tokens are short-lived signed JWTs. Refresh tokens are opaque random values; only their SHA-256 hashes are stored.
- Every refresh rotation creates a new session row in the same family and revokes the previous row. Reuse of any replaced token revokes the complete family.
- Browser refresh tokens use `HttpOnly`, `SameSite=Lax` cookies. `Secure` is mandatory outside development. Cookie-authenticated mutation endpoints validate `Origin` against `PUBLIC_APP_URL`.
- An organization may have several owners. Database-level deferred constraints prevent a transaction from leaving it without an active owner.
- Group chats and channels may have several owners. Database-level deferred constraints prevent a non-archived group or channel from losing its last active owner membership.
- Direct chats are private, have exactly one normalized pair key and cannot be duplicated for the same two actors.
- Any active organization member may discover and join a public group/channel. Private resources require an explicit membership action from an owner/admin.
- Authorization decisions live in `internal/authz`; handlers and repositories do not invent their own role matrices.

## Consequences

- Logout and session rotation remain enforceable without storing bearer secrets in plaintext.
- Ownership invariants survive concurrent requests and direct database writes.
- A single in-memory rate limiter is sufficient for the one-instance v1 deployment; phase 7 must replace or coordinate it when horizontal scaling is enabled.
- Changing the access-token signing key logs out all clients, which is acceptable until a multi-key rotation mechanism is introduced.
