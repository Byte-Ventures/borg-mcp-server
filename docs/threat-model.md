# Server threat model

## Scope and security objective

This model covers the single-node `borgmcp-server` process, its SQLite store, local TLS identity,
offline credential administration, REST routes, and SSE streams. The objective is to let explicitly
enrolled clients coordinate on one operator-controlled host without cloud access, ambient discovery,
browser access, arbitrary code execution, or cross-client/cross-cube authority.

The model does not make a compromised operating-system account, root user, hypervisor, or physical
host trustworthy. A hostile local administrator can read process memory and server files. High
availability, internet exposure, external identity providers, and remote administration are outside
v1 scope.

## Assets and trust boundaries

- Setup consumes one internal bootstrap invitation to create the same-machine owner client with
  `create_cube`. The owner can create short-lived, purpose-bound client invitations. Clients generate
  and persist their own credential and retry key before exchange; exact credential-proven retries
  return stable non-secret identity. A client invitation enrolls a client without server capabilities
  or cube grants. Its
  allowlisted mint-time client name becomes the stored identity; the enrolling peer's
  self-description remains a claim hint. Explicit names are atomically refused at mint while
  held by an active client or a live unclaimed invitation; revoked client names and expired
  invitation labels may be reused. Client credentials can access only explicitly granted cubes and mint narrower,
  scoped drone-session credentials for attached seats. Enrolled client and drone-session credentials
  do not expire with time; revocation, eviction, supersession, or reset ends their validity.
  Product role labels and cube owner metadata never grant authority.
- A client with only `read` access attaches with an explicit observer posture derived from its current
  parent grant. Attach responses and drone listings expose that posture, but the server remains the
  enforcement boundary: observer drones are rejected during direct-recipient validation, observer
  clients and sessions cannot mutate or acknowledge activity, and their page/replay/live stream views
  omit directed entries. `write` and `manage` parent grants derive participant posture and remain
  eligible for directed work. Grant changes therefore alter effective posture without a second stored
  authority flag that could drift.
- Authenticated `POST /api/cubes` requires an active parent client with `create_cube`. It atomically
  creates one cube, fixed human/default-worker roles, the creator's `manage` grant, and an idempotency
  binding. Exact retries are non-mutating; ordinary clients and drone sessions are denied. Per-client
  and server cube quotas bound growth.
- Repository-cube adoption is an explicit client-confirmed operation, never a name-based lookup or
  migration backfill. Resolution returns an authoritative association only while that same client
  currently has `manage` access; stale, foreign, and inaccessible bindings are indistinguishable from
  no association. Association requires current `manage` access to the selected cube, derives the
  cube name, template, human role, and default worker role from server state, and atomically inserts
  only the canonical repository binding. Same bindings are idempotent. Conflicts and invalid legacy
  role layouts use static messages that disclose no cube or repository identity, and authorization,
  validation, capacity, mutation-hook, or SQLite contention failures roll back without partial state.
- Credential records in the server database are keyed lookup and verifier digests, never plaintext.
  Invitation, client, and drone-session digests use separate HMAC domains. The portable owner bearer
  is stored separately in the owner-only `~/.borg/credentials` file. Rotation revokes prior client
  credentials; revocation also invalidates child sessions. Unknown, expired, revoked, and
  consumed-with-another-tuple invitation claims execute the same sentinel-row lookup, tuple checks,
  and digest comparisons before returning the same public failure.
- Client attach accepts an optional prior seat identity. A caller may reattach only its own un-evicted
  drone in the target cube; foreign, evicted, and wrong-cube identities follow the ordinary authorized
  mint path without disclosing why they were ineligible. Permanent per-client retry bindings include
  the complete cube, role, and prior-seat tuple, so later fresh-key reattachment cannot erase or
  repurpose an older retry key.
- Runtime metadata is an advisory, non-authoritative seat report. The shared protocol decoder accepts
  only the bounded Agent CLI enum, printable-safe model identifier, and one canonical public repository
  name/origin pair; it rejects credentials, local/private origins, controls, bidi controls, malformed
  values, unknown keys, and partial repository patches before persistence. The authenticated self-update
  route derives cube and drone identity from the immutable drone-session principal, can update only that
  seat, and makes foreign and unknown cubes indistinguishable. Attach and sparse self-heal updates are
  atomic, never echo rejected input, and do not modify grants, role, posture, routing, liveness,
  `last_seen`, activity logs, wake state, timers, or model execution.
- Role creation, sparse role update, granular role-section patch, and role deletion routes require
  the cube's `manage` grant. All four routes return `403 ACCESS_DENIED` when the cube is read-visible
  but the grant is insufficient, and `404 NOT_FOUND` when the cube or role is inaccessible, foreign,
  or missing. Default promotion and role mutation recheck authority inside one immediate transaction.
  Role deletion applies the default, required, taxonomy-reference, and active-drone guards, then
  retargets evicted drones to the default role and
  deletes the role in that same transaction. A current default cannot be explicitly demoted;
  promoting another role is the only default transition, preserving exactly one default. Section
  patches alter one plain-label section while preserving the remainder of the stored playbook. The
  role-rationale route uses the cube's `read` scope and returns one named section, bounded to 51,200
  bytes.
- `credential-digest.key`, `server.key`, and `borg.db` are runtime secrets. They remain mode `0600`
  under an operator-controlled mode `0700` directory. The long-running service does not load
  `ca.key`. After setup, operators deploying on a LAN must move `ca.key` to offline storage that the
  service account cannot read; only `ca.crt`, `server.crt`, and `server.key` remain available at
  runtime.
- Client listing, rotation, revocation, and grant changes remain operator commands, not network routes.
  The listing exposes client names, current ID-derived handles, active/revoked state, and cube grants,
  but no credential or invitation material. Revocation and grant changes resolve an exact unique
  name, a listed handle, or a full client UUID in the same immediate transaction as the
  mutation. Resolution spans active and revoked clients, keeping old handle prefixes anchored;
  duplicate names, stale handle prefixes, and cross-namespace name/handle/UUID collisions fail
  closed with a working selector for every candidate; an explicit `id:<client-uuid>` selector
  disambiguates a handle shadowed by a name. A uniquely resolved revoked client is reported as
  revoked rather than absent. Run `borg-mcp-server client-rotate <client-id>` or
  `borg-mcp-server client-revoke <client-name-or-handle>` while the server is live; securely
  deliver any one-time rotated credential. Live operations commit through the same SQLite store
  while the service runs; request-time authorization observes the commit on the next request, with
  no polling window. Credential rotation/revocation in the running authority aborts registered
  streams. A concurrent write fails closed and can be retried; no stale cross-process authorization
  cache exists.
- Client invitation minting remains a local CLI operation with no network route, but may execute
  beside a live server because it invalidates no live authority. It authenticates with the portable
  owner credential and adds one purpose-bound digest row. A live-path connection never migrates:
  it requires the exact migration version/name/checksum
  chain used by the running CLI and fails closed on mismatch. A separate short-lived invitation-mutation
  lock prevents concurrent invitation commands and
  excludes setup and reinitialization. The live server observes the
  committed WAL write on its next enrollment read without restart; SQLite contention fails closed.
  Invitation claim inserts the client, credential digest, retry binding, and invitation consumption in
  one immediate transaction; owner claim also inserts `create_cube`. Cube access remains a separate
  grant-table concern.
- Setup acquires the same PID-bound runtime lock before inspecting or changing identity state. It is
  idempotent for a complete installation and refuses a partial installation by default; only the
  explicit destructive `setup --reinitialize` path removes the known identity/database files, and it
  can never run while the server lock is live. Unrelated files in the data directory are not removed.
- SIGINT/SIGTERM/SIGHUP handlers are installed before runtime-lock acquisition. A signal observed during key,
  certificate, store, or listener startup completes that in-flight phase only to acquire cleanup
  ownership, then closes any listener, destroys authentication state, wipes the loaded key, and removes
  `runtime.lock`; the lock is never released ahead of listener/authentication teardown. If listener or
  authentication closure cannot be positively confirmed, the process retains those resources and the
  lock, emits only a sanitized fatal message, and exits nonzero so the operating system closes sockets;
  operators must investigate before using the explicit stale-lock recovery command. That command
  revalidates a private, structurally valid server lock with a conclusively absent PID and renames it
  to preserve evidence; it never deletes a lock or acts on ambiguous/live evidence.
- Rotation intentionally prints the new client credential once to the invoking terminal, and `invite`
  prints a single-use client enrollment invitation once. These are the only secret-output exceptions:
  operators must use a private terminal and must not capture command output in shared logs. Runtime
  request headers, request bodies, credentials, and internal errors are never logged.
- Operator debug diagnostics are disabled by default and can be enabled only for one local process start.
  A central closed-schema projection writes structured records to stderr and accepts operational enums,
  counts, and canonical IDs only. Authorization headers, credentials, invitations, recovery material,
  request/message/decision bodies, tokens, raw paths, exceptions, and arbitrary metadata never enter the
  output schema; no network log sink or remote level-change route exists.
- The CLI prints actionable stderr only for server-typed operator errors with bounded copy: malformed
  start flags, bind/LAN policy, missing data/TLS prerequisites, symlinked data paths, offline lock
  state, unknown clients, and invalid storage-bound environment settings. Unknown exceptions, fatal
  teardown, filesystem paths, TLS/SQLite internals, credentials, tokens, and caller-controlled values
  always collapse to `Server command failed.`

## Network and transport boundary

- The default listener is `127.0.0.1:7091`. Hosts must be explicit IP literals. Wildcard, DNS name,
  and public-routable binds are rejected. A private IPv4/IPv6 address requires `--lan` on every start;
  consent is not persisted. The service performs no mDNS, multicast, zeroconf, or other discovery.
- Every listener uses HTTPS with TLS 1.3 minimum. Certificates must be current, non-CA leaves with an
  exact bind-IP SAN and server-auth usage. A LAN bind additionally requires an explicit current CA
  trust anchor and startup builds a bounded cryptographically verified leaf/intermediate path to that
  self-signed root. The leaf certificate file may append intermediates in serving order; the explicit
  CA file starts with the trusted root.
- Accepted TCP sockets are tracked before TLS or HTTP ownership. Shutdown destroys and awaits every
  tracked socket, including peers stalled before a TLS handshake, before authentication state or the
  runtime lock can be released; the handshake timeout remains a separate steady-state bound.
- Clients must configure `ca.crt` as the trust anchor and verify the requested IP address. They must
  not disable certificate verification. The setup-reported CA SPKI SHA-256 fingerprint is the
  out-of-band pin for transferring that trust anchor.
- Browser-origin requests are rejected before routing and no CORS allow-origin header is emitted.
  There is no cookie authentication and no browser deployment mode.

## Request, authentication, and abuse boundary

- `/healthz` is unauthenticated and returns only an empty `204`; it discloses no identity, readiness,
  version, capability, or dependency state. `/api/protocol` is the other unauthenticated transport
  endpoint and returns only the shared protocol identity tag used to fail closed on version mismatch.
  Every application REST route and SSE stream requires a valid bearer credential. Enrollment requires
  its one-time invitation in the canonical request body. Missing, malformed, or revoked credentials
  fail closed; expired or reused invitations fail closed.
- Request bodies, headers, global connections, per-address connections, per-credential SSE streams,
  TLS handshakes, handler time, request time, and keepalive time are bounded. Bounded
  global and per-remote-address fixed-window limiters run before body parsing and authentication; loopback
  admission uses the finite global request bound for local coordination bursts while LAN sources retain the
  tighter per-address bound. Authenticated coordination requests enter a separate principal limiter only
  after authentication derives a server-trusted principal: client credentials are keyed by client identity,
  and drone-session credentials are keyed by drone-session identity for reads, mutations, and streams.
  Credential hashes remain storage and authentication identifiers, not fairness identities. Excess requests
  return `429` with `Retry-After`. Arbitrary invalid credentials cannot occupy client limiter state. SSE
  stream allowances remain per credential. Unknown identities fail closed when limiter state reaches its bound.
- SSE replay, pending-event queues, and live queues are bounded. Credential rotation/revocation in the
  running authority aborts registered streams.
- Activity storage retains at most 10,000 entries and 10,000 cursor tombstones per cube by default;
  pruning is transactional and cascades recipients and acknowledgements before publishing the new
  entry. Every network-reachable growth mutation, including enrollment, attach/reissue, acknowledgement,
  decision history, directives, and activity, fails closed with a secret-free `CAPACITY_EXCEEDED`
  response before mutation when the database plus WAL/SHM reaches 1 GiB or available filesystem space
  would fall below 64 MiB. The preflight reserves at least 64 SQLite pages for indexes and metadata,
  rounds the bounded payload to whole pages, and conservatively reserves rewriting the entire current
  DB/WAL/SHM footprint plus writing each new page to both the database and WAL. This intentionally
  trades usable capacity for a no-write-before-rejection guarantee, including prune/cascade paths. Operators
  may lower or raise these positive-integer bounds with
  `BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE`, `BORG_SERVER_MAX_ACTIVE_DECISION_BYTES_PER_CUBE`,
  `BORG_SERVER_MAX_DATABASE_BYTES`, and
  `BORG_SERVER_MIN_FREE_DISK_BYTES`; changes require restart and must fit the host backup policy.

| Remote growth surface | Capacity-gated mutation |
| --- | --- |
| Enrollment exchange | Purpose-bound invitation claim, client-generated credential digest, retry binding, and owner capability insertion |
| Cube creation | Cube, two fixed roles, creator manage grant, and retry-result binding |
| Repository-cube adoption | One explicit canonical repository binding to an existing manage-accessible cube |
| Client attach/retry | Permanent retry binding, eligible prior-seat reattachment or drone insertion, session/credential insertion, and prior-session revocation |
| Own-seat runtime metadata | Sparse advisory metadata replacement or explicit-null clearing, with repository identity updated as one pair |
| Cube directive update | Directive replacement and SQLite index/page growth |
| Role create/update/section patch/delete; role rationale read | Role insertion, sparse field replacement, default transition, targeted playbook fragment replacement, guarded deletion with evicted-drone retarget, or one named section read without mutation, bounded to 51,200 bytes |
| Activity append | Log/recipient insertion, cursor tombstone insertion, and pruning cascades |
| Activity acknowledgement/claim | Acknowledgement insertion |
| Decision ratification | Active-decision supersession and immutable history insertion |

- Network routes map only to fixed coordination operations and cannot launch subprocesses, shells,
  dynamic code, remote tools, outbound-cloud requests, or arbitrary SQL. Subprocess use is confined to
  local runtime and managed-service lifecycle operations. Offline bootstrap is also exercised with TCP,
  UDP, and `fetch` egress actively intercepted.

## Acceptance matrix

| Release criterion | Enforcement and evidence |
| --- | --- |
| Separate least-privilege credentials | Purpose-separated digest domains, scoped principals, narrow drone sessions, and operator-only client rotation/revocation commands. |
| Loopback default, explicit LAN consent, no discovery | `network-policy.ts`, `start-options.ts`, bind negatives, and static discovery boundary test. |
| Verified TLS for non-loopback | Exact SAN/EKU/validity checks plus mandatory bounded root/intermediate path verification for LAN mode; trusted/untrusted/direct/intermediate LAN certificate tests. |
| Authentication on all REST and SSE | All application REST/SSE routes authenticate; invitation exchange is one-time authenticated; the shared-contract health and protocol-tag endpoints are data-bounded; missing/invalid SSE/route matrix is release-gating. |
| Hashed per-client rotate/revoke tokens | Digest-only SQLite schema, atomic rotation/revocation, offline CLI flow, rejection timing-class regression, generated-file/config/database-sidecar/backup-copy plaintext scans, and revocation tests. |
| Rate, body, connection, and storage limits | Fair per-address and principal-scoped client or drone-session request rates plus handshake, connection, per-verified-credential SSE, activity-retention, database-size, and disk-reserve bounds beneath global caps; bounded state, `429`, and `CAPACITY_EXCEEDED`; body/header/deadline/pruning/capacity tests. |
| No remote tool or subprocess execution | Fixed route surface, static production-source boundary tests, and actively intercepted offline-bootstrap egress test. |
| Threat model | This document, reviewed with the exact release commit. |
| Negative bind/auth/CORS/log-secret tests | Network policy, HTTPS, operator flow, credential, cross-cube, and runtime-boundary suites. |

## Residual risks and operating requirements

- Local account compromise defeats file permissions and may expose active process memory. Use a
  dedicated unprivileged service account, encrypted storage, host patching, and restricted backups.
- The fixed-window limiter reduces brute force and accidental overload; it is not a substitute for a
  host firewall. LAN operators must restrict inbound traffic to intended private clients.
- One node and one SQLite database remain a single availability and corruption domain. Keep offline,
  access-controlled backups and test restoration before relying on the service.
- The generated CA is installation-local. Loss of `ca.key` requires a deliberate trust reset; theft
  requires replacing the CA, server leaf, and every client trust record.
- Release approval remains external and exact-commit-bound. This document does not authorize a tag,
  preview, environment approval, package publication, or deployment.
