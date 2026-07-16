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

- The recovery credential creates short-lived purpose-bound enrollment invitations. Clients generate
  and persist their own credential and retry key before exchange; exact credential-proven retries
  return stable non-secret identity. The one owner invitation grants only persisted `create_cube`;
  ordinary invitations grant no server capability or cube. Client credentials can access only
  explicitly granted cubes and mint narrower, expiring drone-session credentials for attached seats.
  Product role labels and cube owner metadata never grant authority.
- Authenticated `POST /api/cubes` requires an active parent client with `create_cube`. It atomically
  creates one cube, fixed human/default-worker roles, the creator's `manage` grant, and an idempotency
  binding. Exact retries are non-mutating; ordinary clients and drone sessions are denied. Per-client
  and server cube quotas bound growth.
- Persisted credentials are keyed lookup and verifier digests, never plaintext. Recovery, invitation,
  client, and drone-session digests use separate HMAC domains. Rotation revokes prior client
  credentials; revocation also invalidates child sessions. Unknown, expired, revoked, and
  consumed-with-another-tuple invitation claims execute the same sentinel-row lookup, tuple checks,
  and digest comparisons before returning the same public failure.
- Client attach accepts an optional prior seat identity. A caller may reattach only its own un-evicted
  drone in the target cube; foreign, evicted, and wrong-cube identities follow the ordinary authorized
  mint path without disclosing why they were ineligible. Permanent per-client retry bindings include
  the complete cube, role, and prior-seat tuple, so later fresh-key reattachment cannot erase or
  repurpose an older retry key.
- `credential-digest.key`, `server.key`, and `borg.db` are runtime secrets. They remain mode `0600`
  under an operator-controlled mode `0700` directory. The long-running service does not load
  `ca.key`. After setup, operators deploying on a LAN must move `ca.key` to offline storage that the
  service account cannot read; only `ca.crt`, `server.crt`, and `server.key` remain available at
  runtime.
- Client rotation and revocation are offline commands, not network routes. Stop the server first, run
  `borg-mcp-server client-rotate <client-id>` or `borg-mcp-server client-revoke <client-id>`, securely
  deliver any one-time rotated credential, then restart. A PID-bound runtime lock rejects offline
  changes while the service is live. Stale locks fail closed and require explicit removal only after
  confirming the recorded PID is stopped; an old cross-process SSE stream therefore cannot survive
  an offline database change.
- Setup acquires the same PID-bound runtime lock before inspecting or changing identity state. It
  refuses any existing or partial installation by default; only the explicit destructive
  `setup --reinitialize` path removes the known identity/database files, and it can never run while
  the server lock is live. Unrelated files in the data directory are not removed.
- SIGINT/SIGTERM handlers are installed before runtime-lock acquisition. A signal observed during key,
  certificate, store, or listener startup completes that in-flight phase only to acquire cleanup
  ownership, then closes any listener, destroys authentication state, wipes the loaded key, and removes
  `runtime.lock`; the lock is never released ahead of listener/authentication teardown. If listener or
  authentication closure cannot be positively confirmed, the process retains those resources and the
  lock, emits only a sanitized fatal message, and exits nonzero so the operating system closes sockets;
  operators must investigate before explicitly removing the resulting stale lock.
- Setup intentionally prints the recovery credential and owner enrollment invitation once to the invoking
  terminal. Rotation intentionally prints the new client credential once. These are the only
  secret-output exceptions: operators must use a private terminal and must not capture command output
  in shared logs. Runtime request headers, request bodies, credentials, and internal errors are never
  logged.
- The CLI prints actionable stderr only for server-typed operator errors with static copy: malformed
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

- `/healthz` is the shared protocol's sole unauthenticated transport exception and returns only an
  empty `204`; it discloses no identity, readiness, version, capability, or dependency state. Every
  application REST route and SSE stream requires a valid bearer credential. Enrollment requires its
  one-time invitation in the canonical request body. Missing, malformed, expired, reused, and revoked
  credentials fail closed.
- Request bodies, headers, global connections, per-address connections, per-credential SSE streams,
  requests per socket, TLS handshakes, handler time, request time, and keepalive time are bounded. Bounded
  global and per-remote-address fixed-window limiters run before body parsing and authentication;
  authenticated coordination requests enter a separate parent-client limiter only after authentication
  derives a server-trusted principal. Client credentials and drone-session credentials issued to the
  same parent client share that request allowance, so rotation or reissue cannot reset it. Credential
  hashes remain storage and authentication identifiers, not fairness identities. Excess requests return
  `429` with `Retry-After`. Arbitrary invalid credentials cannot occupy client limiter state. SSE stream
  allowances remain per credential. Unknown identities fail closed when limiter state reaches its bound.
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
  `BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE`, `BORG_SERVER_MAX_DATABASE_BYTES`, and
  `BORG_SERVER_MIN_FREE_DISK_BYTES`; changes require restart and must fit the host backup policy.

| Remote growth surface | Capacity-gated mutation |
| --- | --- |
| Enrollment exchange | Purpose-bound invitation claim, client-generated credential digest, retry binding, and owner capability insertion |
| Cube creation | Cube, two fixed roles, creator manage grant, and retry-result binding |
| Client attach/retry | Permanent retry binding, eligible prior-seat reattachment or drone insertion, session/credential insertion, and prior-session revocation |
| Cube directive update | Directive replacement and SQLite index/page growth |
| Activity append | Log/recipient insertion, cursor tombstone insertion, and pruning cascades |
| Activity acknowledgement/claim | Acknowledgement insertion |
| Decision ratification | Active-decision supersession and immutable history insertion |

- Network routes map only to fixed coordination operations. Production source contains no subprocess,
  shell, dynamic-code, remote-tool, outbound-cloud, or arbitrary SQL execution surface. Offline
  bootstrap is also exercised with TCP, UDP, and `fetch` egress actively intercepted.

## Acceptance matrix

| #1016 criterion | Enforcement and evidence |
| --- | --- |
| Separate least-privilege credentials | Purpose-separated digest domains, scoped principals, narrow drone sessions, and offline-only client rotation/revocation commands. |
| Loopback default, explicit LAN consent, no discovery | `network-policy.ts`, `start-options.ts`, bind negatives, and static discovery boundary test. |
| Verified TLS for non-loopback | Exact SAN/EKU/validity checks plus mandatory bounded root/intermediate path verification for LAN mode; trusted/untrusted/direct/intermediate LAN certificate tests. |
| Authentication on all REST and SSE | All application REST/SSE routes authenticate; invitation exchange is one-time authenticated; the ratified shared-contract health exception is data-free; missing/invalid SSE/route matrix is release-gating. |
| Hashed per-client rotate/revoke tokens | Digest-only SQLite schema, atomic rotation/revocation, offline CLI flow, rejection timing-class regression, generated-file/config/database-sidecar/backup-copy plaintext scans, and revocation tests. |
| Rate, body, connection, and storage limits | Fair per-address and parent-client request rates plus handshake, connection, per-verified-credential SSE, activity-retention, database-size, and disk-reserve bounds beneath global caps; bounded state, `429`, and `CAPACITY_EXCEEDED`; body/header/socket/deadline/pruning/capacity tests. |
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
