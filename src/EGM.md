# src

## Overview

This directory holds the TypeScript source of `borgmcp-server`, the self-hosted Borg coordination server. The source is ES modules (`src/package.json` is `{"private":true,"type":"module"}`), and `npm run build` compiles it to `dist/`. The executable is `borg-mcp-server` (`dist/main.js`), and the library entry is `dist/index.js`.

The server runs as one Node process. It terminates TLS 1.3 HTTPS itself (`https-server.ts`), dispatches coordination protocol requests (`coordination-api.ts`), and stores all state in one SQLite database (`store.ts`, `migrations.ts`). It can also do these jobs:

- Show an operator terminal dashboard (`dashboard*.ts`).
- Install itself as a launchd or systemd user service (`managed-service*.ts`).
- Update itself from the npm registry (`registry-artifact.ts`, `runtime-lifecycle.ts`, `runtime-operator.ts`).

`service.ts` assembles these parts. `cli.ts` maps commands onto `service.ts`. Portable protocol decoders, path constants, and envelope types come from the `borgmcp-shared/protocol` dependency, not from this directory.

The `.js` files `dashboard.js`, `dashboard-ink.js`, and `dashboard-plain.js` only contain `export * from "./<name>.ts"`.

## Interface

### Entry points and public library surface

- `runMain(args, service, output, fatalExit)`: the process entry point. It calls `runCli` with `nodeServerService` and sets `process.exitCode` [main.ts:runMain].
- `runCli(args, service, io)` and `CliIo`: command dispatch. Commands [cli.ts:runCli]:
  - `version [--json]` and `--version`
  - `setup [--reinitialize]`
  - `cert-reissue --host <ip>`
  - `start` (flags parsed by `parseStartOptions`)
  - `dashboard [--ascii] [--no-motion]`
  - `status [--json]`
  - `service install|uninstall [--json]`
  - `update [--json]`
  - `recover-stale-lock [--json]`
  - `client-rotate <client-id>`, `client-list`, `client-revoke <selector>`
  - `client-grant <selector> <cube-id> <read|write|manage>`, `client-ungrant <selector> <cube-id>`
  - `invite [<client-name>]`
  - `help`, `--help`, `-h`
- `parseStartOptions(args)`: parses the `start` flags `--host`, `--port`, `--lan`, `--ascii`, `--no-motion`, and `--log-level debug` [start-options.ts:parseStartOptions].
- Public exports from `index.ts`. A change here changes the packed API [index.ts]:
  - `runCli` and `CliIo`.
  - From `service.ts`: `inspectManagedServiceState`, `inspectRuntimeLock`, `recoverStaleRuntimeLock`, `inspectNodeRuntime`, and the service, status, and setup types.
  - From `runtime-identity.ts`: `createRuntimeBuildIdentity`, `loadRuntimeBuildIdentity`, `RUNTIME_INFO_PATH`, `SERVER_PACKAGE_VERSION`.
  - From `managed-service.ts`: `createManagedServiceDefinition`. From `managed-service-install.ts` and `managed-service-uninstall.ts`: the install and uninstall result types.
  - From `runtime-lifecycle.ts`: `createRuntimeLifecycle`, `RuntimeActivationError`, `createUnixNpmArtifactUnpacker`, `inspectActiveRuntimeArtifact`.
  - From `registry-artifact.ts`: `createRegistryArtifactSource`.
  - From `dashboard.ts`: `createDashboardRenderer`, `dashboardColorEnabled`, `dashboardColorDepth`, `rankDashboardSnapshot`, `renderPlainDashboard`, `resolveDashboardMotionMode`, `sanitizeTerminalText`, `selectDashboardGlyphMode`, and the dashboard types.
  - From `runtime-operator.ts`: `createRuntimeOperator` and `RuntimeUpdateFailure`.
  - `index.ts` does not export anything from `store.ts`, `https-server.ts`, `coordination-api.ts`, or `credentials.ts`.

### Service composition

- `ServerService` is the contract that the CLI uses [service.ts:ServerService]. `nodeServerService` is the production instance [service.ts:nodeServerService].
- `createNodeServerService(deps)` builds the foreground `start` pipeline. The steps run in this order: bind, runtime lock, log sink, TLS key, store and `CoordinationApi`, HTTPS listener(s), liveness scheduler, owner-credential bind, dashboard, wait for shutdown, teardown [service.ts:createNodeServerService].
- `setupNodeServerInstallation` prepares or reinitializes the install. `assertManagedServiceInstallation` checks an install before a managed service uses it. `bindPortableOwnerCredentialPort` updates the portable owner credential for the running port [service.ts].
- `createOfflineCredentialService` handles `client-*` and `invite` against the database. It works while the server is stopped or live. When the server is stopped, it takes the runtime lock and applies migrations. When the server is live, it takes no runtime lock and opens the store in `require-current` mode [service.ts:createOfflineCredentialService, invitationRuntimeState].
- `acquireRuntimeLock`, `inspectRuntimeLock`, `recoverStaleRuntimeLock`, and `acquireInvitationMintLock` manage the lock files [service.ts].
- `startLivenessScheduler` runs a liveness scan every 60 s [service.ts:startLivenessScheduler].
- `installProcessShutdownHandlers` aborts on SIGINT, SIGTERM, or SIGHUP [service.ts:installProcessShutdownHandlers].
- `stopServerRuntime`, `inspectNodeRuntime`, `completeRuntimeUpdate`, `selectServerEnvironment`, and `resolveStorageLimits` are also defined here [service.ts].
- `bootstrapServer` creates the CA (unless it is given a preserved CA, as in `setup --reinitialize`), the server leaf certificate, the digest key, `borg.db`, and `server.json`, and enrolls the local owner. `reissueServerCertificate` reissues the leaf certificate from the existing CA. `loadDigestKey` and `loadTlsPrivateKey` load private files [bootstrap.ts].
- `SERVER_PACKAGE_VERSION` (generated, see `scripts/release-identity.mjs`), `RUNTIME_INFO_PATH = "/api/runtime"`, `createRuntimeBuildIdentity`, and `loadRuntimeBuildIdentity` [runtime-identity.ts].

### HTTPS transport

- `startHttpsServer(options)` returns a `RunningServer` object `{origin, limits, close}` [https-server.ts:startHttpsServer].
- Other exports [https-server.ts]:
  - `DEFAULT_SERVICE_LIMITS` and `ServiceLimits`.
  - `handleRequest` and `createRequestHandlerContext`.
  - `parseCoordinationQuery` and `CoordinationQueryError`.
  - `validateTlsCertificate`.
  - `RequestRateLimiter`, `PreAuthAdmissionLimiter`, `ConcurrentQuota`.
- Routes:
  - `GET /healthz` returns 204.
  - `GET /api/protocol` returns the protocol preflight.
  - `POST /api/enrollment/exchange`.
  - `GET /api/runtime` (requires authentication).
  - `/api/client/attach`, `/api/client/attach/reconcile`, `/api/cubes`, every `/api/cubes/...` path, `/api/repository-cubes/resolve`, and `/api/repository-cubes/association` are passed to `handleCoordination`.
  - Any other path returns 404 [https-server.ts:handleRequest, isCoordinationPath].
- `resolveBindOptions`, `DEFAULT_BIND_HOST = "127.0.0.1"`, `DEFAULT_PORT = 7_091` [network-policy.ts].

### Coordination protocol

- `CoordinationApi.handle(request)`, together with `CoordinationRequest` and `CoordinationResponse`, is a dispatcher that does not depend on HTTP [coordination-api.ts:CoordinationApi].
- Operations under `/api/cubes/:cube` [coordination-api.ts:handle]:
  - The cube itself: `GET`, `PATCH`, `DELETE`. `GET /api/cubes` lists cubes, and `POST /api/cubes` creates a cube.
  - `taxonomy-patch` and `role-rationale`.
  - Roles: `roles` and `roles/:role`, with `section-patch`.
  - Drones: `drones`, `drones/self/metadata`, and `drones/:drone`.
  - Logs: `POST logs` appends, `PUT logs` reads a page, and `GET logs/:id|8hex` reads one entry. `GET logs/:uuid/ack-status` returns the acknowledgement state. It accepts only a full UUID.
  - `documents[/:id]`, `acks`, and `decisions` (POST, DELETE, and PUT).
  - `GET stream` is an SSE stream that sends `log`, `bookmark`, `heartbeat`, and `error` events.
- The other operations are seat attach and reconcile, and repository-cube resolve and associate.
- `createEnrollmentExchange` and `decodeEnrollmentEnvelope` handle invitation exchange [enrollment.ts].
- `validateMessageTaxonomy`, `patchMessageTaxonomy`, and `resolveMessageRouting` handle message classes, prefixes, and routing to broadcast or direct recipients [message-taxonomy.ts].
- `readRoleSectionText`, `patchRoleSectionText`, and `RoleSectionPatchConflictError` work on the `Label:` sections of a role description [role-section.ts].
- `WAKE_RETRY_INTERVAL_MS`, `WAKE_MAX_ATTEMPTS`, and `WAKE_STALE_AFTER_MS` are constants only [wake-policy.ts].
- `PLATFORM_QUEEN_SHORT_DESCRIPTION` and `PLATFORM_QUEEN_DETAILED_DESCRIPTION` are static role text [platform-queen.ts].

### Credentials and principals

- `CredentialAuthority` creates invitations, exchanges them, authenticates bearer tokens, attaches seats, rotates and revokes clients, and registers live sessions [credentials.ts:CredentialAuthority].
- `CredentialDigester` computes keyed HMAC-SHA256 lookup and verifier digests. `LiveCredentialRegistry` tracks live sessions. `generateSecret` creates new secrets [credentials.ts].
- `clientPrincipal`, `droneSessionPrincipal`, `assertServerDerivedPrincipal`, `assertCanonicalUuid`, and the `Principal` union type (`operator`, `client`, `drone-session`) [principal.ts].
- `writePortableServerCredential`, `rebindPortableServerCredential`, `readPortableServerCredentialForTrustIdentity`, `portableCredentialAccountHasNonOwner`, and `portableCredentialAccount` manage the owner credential in `~/.borg/credentials` [portable-credential-store.ts].

### Persistence (SQLite)

- `openStore(options)` returns a frozen `StoreRuntime` object [store.ts:openStore] with these members:
  - `forPrincipal(principal)` returns a `ScopedStore`, the API that request code uses.
  - `maintenance` (`MaintenanceStore`) is for administration and tests.
  - `credentials` (`CredentialStore`).
  - `liveness` (`LivenessStore.scan`).
  - `dashboard` (a snapshot source).
  - `diagnostics`.
  - `close`.
- `ScopedStore` methods [store.ts:SqliteScopedStore]:
  - Cubes: `createCube`, `getCube`, `listCubes`, `updateCube`, `deleteCube`.
  - Repository cubes: `resolveRepositoryCube`, `associateRepositoryCube`.
  - Roles: `listRoles`, `createRole`, `updateRole`, `patchRoleSection`, `deleteRole`, `readRoleRationale`.
  - Drones: `listDrones`, `listDronesSince`, `reassignDrone`, `evictDrone`, `updateOwnRuntimeMetadata`.
  - Log: `appendLog`, `readLog`, `readLogEntry`, `readAckStatus`, `acknowledge`, `subscribeActivity`.
  - Documents: `putDocument`, `getDocument`, `listDocuments`, `removeDocument`.
  - Decisions: `recordDecision`, `removeDecision`, `listDecisions`.
  - Seats: `attachSeat`, `reconcileAttachment`.
- `CredentialStore` methods: `createInvitation`, `findInvitation`, `claimInvitation`, `findClientCredential`, `findDroneSessionCredential`, `rotateClientCredential`, `revokeClientCredentials`, `revokeClientCredentialsBySelector`, `clientHasServerCapability` [store.ts:SqliteCredentialStore].
- Constants: `DEFAULT_STORAGE_LIMITS` (among others, 1 GiB maximum database and 64 MiB minimum free disk) and `DEFAULT_CUBE_LIMITS` (100 cubes per client, 1000 in total) [store.ts].
- `preparePrivateDataDirectory` creates the private data directory [store.ts].
- Errors such as `AccessDeniedError`, `ScopedStoreError`, `CubeDeletedError`, `StorageCapacityError`, and the `Role*`, `Document*`, and `Attach*` errors [store.ts:704-941].
- `withImmediateTransaction` runs `BEGIN IMMEDIATE`, then the function. It rolls back when the function throws. It does not commit: the caller must commit [sqlite-transaction.ts]. `ActivityHub` is an in-memory publish/subscribe hub per cube [store-activity-hub.ts]. The row decoders and `EMPTY_RUNTIME_METADATA` are in [store-row-decoders.ts].
- `STORE_MIGRATIONS` holds 30 ordered migrations (versions 1 to 30). The module also exports `applyMigrations`, `assertMigrationsCurrent`, `migrationChecksum`, and `MigrationCompatibilityError` [migrations.ts]. `MIGRATION_CHECKSUM_MANIFEST` holds the published checksums [migration-checksums.ts].
- SQLite tables after the last migration [migrations.ts:STORE_MIGRATIONS]:
  - Clients and cubes: `clients`, `cubes`, `client_cube_grants`, `client_credentials`, `client_server_capabilities`.
  - Roles and drones: `roles`, `drones`, `drone_sessions`, `drone_session_credentials`, `silent_seat_ping_state`.
  - Activity log: `activity_log`, `activity_acks`, `activity_log_recipients`, `activity_log_documents`, `activity_post_bindings`, `activity_wake_attempts`, `expired_activity_cursors`.
  - Decisions and documents: `decisions`, `documents`.
  - Enrollment: `enrollment_invitations`, `enrollment_claims`, `owner_enrollment_state`.
  - Cube creation and repositories: `cube_create_bindings`, `repository_associations`, `attachment_operations`.
  - Deleted cubes: `deleted_cubes`, `deleted_cube_client_grants`, `deleted_cube_session_credentials`.
  - The migration runner: `schema_migrations`.
  - Dropped tables: `recovery_credentials`, `seat_attach_bindings`, and the intermediate `legacy_cube_create_bindings` and `legacy_repository_associations`.

### Runtime lifecycle, update, and managed service

- `createRuntimeLifecycle` provides `stage`, `prepare`, and `activate`. `inspectActiveRuntimeArtifact` reads the active artifact. `createUnixNpmArtifactUnpacker` unpacks a tarball with `tar` and `npm ci`. `RuntimeActivationError` reports a failed activation [runtime-lifecycle.ts].
- `createRuntimeOperator` provides `prepareLatest` and `updateLatest`. `RuntimeUpdateFailure` reports a failed update [runtime-operator.ts].
- `createRegistryArtifactSource().latest()` downloads the newest tarball from the npm registry [registry-artifact.ts].
- `createManagedServiceDefinition` builds the launchd plist or systemd unit and its controller argv. `createBoundManagedServiceRunner` and `assertManagedServiceControllerBinding` check that the controller runs the expected definition [managed-service.ts].
- `installManagedService`, `inspectManagedServiceDefinition`, `writeManagedServicePrivateFile`, `acquireManagedServiceLock`, and `ManagedServiceInstallError` [managed-service-install.ts]. `uninstallManagedService` and `ManagedServiceUninstallError` [managed-service-uninstall.ts].

### Logging and errors

- `operatorErrors`, `OperatorErrorCode`, `operatorPublicMessage`, `operatorPublicDetails`, and the builders `ambiguousClientSelector`, `managedServiceControllerMismatch`, and `unsafeManagedServiceDefinition` [operator-error.ts].
- `createDebugLogger` and `disabledDebugLogger` [debug-log.ts]. `createRuntimeLogger`, `disabledRuntimeLogger`, and `SLOW_RUNTIME_OPERATION_MS` [runtime-log.ts]. `openRuntimeLogSink` and the `RUNTIME_LOG_*` limits [runtime-log-sink.ts].

### Dashboard

- `startForegroundDashboard`, `createDashboardRenderer`, `rankDashboardSnapshot`, `sanitizeTerminalText`, `selectDashboardGlyphMode`, `dashboardColorDepth`, `resolveDashboardMotionMode`, and the `DASHBOARD_*` timing constants [dashboard.ts].
- `renderInkDashboardFrame`, `createInkDashboardElement`, and `dashboardBodyBudget` [dashboard-ink.ts]. `renderPlainDashboard` [dashboard-plain.ts].
- `createDashboardSnapshotReader`, `openReadonlyDashboardSnapshotSource`, and `assertReadonlyDashboardInstallation` [dashboard-source.ts].

## Invariants

### Authorization and principals

- Request code reaches storage only through `StoreRuntime.forPrincipal(principal)`, which calls `assertServerDerivedPrincipal`. Code must never pass a raw `DatabaseSync` across this boundary [store.ts:openStore; coordination-api.ts:handle].
- Principals are created only by the server. A valid principal is registered in a `WeakSet`, is frozen, carries a symbol brand, has exactly the expected keys, and contains only canonical lowercase UUIDs [principal.ts:assertServerDerivedPrincipal].
- Access scope is computed in SQL by `#scope(read|write|manage)` [store.ts:#scope]:
  - Operators have full access.
  - A client needs an unrevoked client row and a grant.
  - A `drone-session` can never get `manage`. It needs a session, client, cube, drone, and grant that all match and are not revoked or evicted.
- Creating a cube requires a `client` principal that has the `create_cube` capability. Associating a repository requires a `client` principal that has `manage` access to the target cube. Neither method accepts the other check [store.ts:createCube, associateRepositoryCube].
- `updateOwnRuntimeMetadata` builds its `UPDATE drones SET` column list from the patch keys. Pass it only a patch decoded by the shared `decodeDroneRuntimeMetadataPatch` [store.ts:updateOwnRuntimeMetadata; coordination-api.ts:handle].

### Credentials

- Secrets are base64url strings of 43 to 1024 characters. The lookup digest is a 16-byte HMAC-SHA256. The verifier is a full 32-byte HMAC-SHA256, compared with `timingSafeEqual` against a dummy verifier when the stored value is missing. The digest key is exactly 32 bytes and is zero-filled after use [credentials.ts:CredentialDigester; bootstrap.ts:loadDigestKey; service.ts:createNodeServerService].
- Invitations are single-use, and claiming one is idempotent only for an exact retry. The owner claim is tied to `owner_enrollment_state.epoch` [store.ts:claimInvitation].

### Network

- The default bind is loopback. Wildcard and public addresses are rejected. A private-LAN bind requires both an explicit host and `--lan`. LAN mode refuses to start when `ca.key` is still in the data directory (`LAN_CA_KEY_ONLINE`) [network-policy.ts:resolveBindOptions; service.ts:assertLanCaKeyOffline].
- TLS uses `minVersion: "TLSv1.3"` with renegotiation disabled. The leaf certificate must cover the bind IP [https-server.ts:startHttpsServer, validateTlsCertificate].
- Requests that have an `Origin` header get 403. Rate limits apply per address, per credential, and globally. Bodies are capped (64 KiB before authentication) [https-server.ts:handleRequest]. The request listener returns 503 when the handler deadline (`handlerTimeoutMs`, default 5 s) expires [https-server.ts:createRequestListener].

### Server lifecycle

- `start` runs in the foreground only and never installs or loads a managed service. When a data directory is set, the runtime lock is acquired before any key, store, or listener work and is released on failure. In TLS-file-only mode (no data directory) no runtime lock is taken. `nodeServerService` always sets a data directory [service.ts:createNodeServerService].
- Runtime bootstrap makes no network calls. Outbound `fetch` is allowed only in `registry-artifact.ts` (enforced by `test/no-egress.test.ts`).

### Migrations

- Migrations must be contiguous starting at version 1. Applied rows must match `sha256(version\0name\0sql)`. An unknown applied version makes startup fail. Each migration runs in its own `BEGIN IMMEDIATE` transaction. `require-current` mode needs an exact match and does not migrate [migrations.ts:applyMigrations, assertMigrationsCurrent; store.ts:openStore].
- Never edit a published migration. Add a new version and add its checksum to `migration-checksums.ts`.

### Storage

- Databases are opened with `foreign_keys=ON`, `journal_mode=WAL` (verified), `synchronous=FULL`, `trusted_schema=OFF`, `secure_delete=ON`, and `busy_timeout=5000`. In `require-current` mode the store does not set `journal_mode`. It only checks that the mode is already `wal` [store.ts:configureDatabase, configureExistingDatabase].
- The data directory is mode 0700 and `borg.db` is mode 0600. Symlinks anywhere in the path are rejected (`DATA_PATH_SYMLINK`) [store.ts:prepareDatabasePath, ensureDirectoryTree].
- Scoped-store writes that grow the database, and `claimInvitation`, call `StorageCapacityGuard.assertCanGrow` first. This check enforces the maximum database size and the minimum free disk space. These writes skip the check: `createInvitation`, `rotateClientCredential`, the liveness wake-attempt inserts, and all `MaintenanceStore` writes [store.ts:StorageCapacityGuard, SqliteCredentialStore, SqliteLivenessStore, SqliteMaintenanceStore].

### Coordination content

- Each cube has exactly one default role [migrations.ts v7]. The default role cannot be deleted or demoted. Mandatory and human-seat roles cannot be deleted. A role that an active drone uses cannot be deleted. Cube names are unique per owner, and role names are unique per cube, without regard to case [store.ts:createRole, updateRole, deleteRole; migrations.ts v29].
- Log entries have a size limit, up to 100 recipients, and up to 100 document references. A reused `postId` replays the stored entry, but only when the content is the same [store.ts:appendLog].

### Errors and logging

- Errors that operators see come only from `operator-error.ts`. The `operatorErrors` entries are frozen, with fixed messages. The builders `ambiguousClientSelector`, `managedServiceControllerMismatch`, and `unsafeManagedServiceDefinition` create new errors whose messages include validated selectors or paths. Coordination failures map to fixed HTTP status codes and protocol error codes [operator-error.ts; coordination-api.ts:handle].
- The debug logger writes only fields on an allowlist (enums, bounded integers, UUIDs). The runtime logger writes a fixed set of keys per event: an ISO `ts`, enum-typed `method` and route-template `path`, and integers that it does not clamp. Logger exceptions are swallowed [debug-log.ts:projectEvent; runtime-log.ts:projectRuntimeEvent].

### Updates and managed service

- A staged artifact must match the registry `dist.integrity` as sha512, contain exact `package.json` identity fields, and have a tree hash. The installed tree is read-only. The `current` symlink is switched atomically. If the restart or the probe fails, or the probed identity does not match, activation rolls back to the previous `current` target. On a first activation there is no previous target: the code removes `current`, stops the service, and throws `RuntimeActivationError("stopped")` [runtime-lifecycle.ts:activateRuntimeArtifact].
- A managed-service definition must be a regular file owned by the user, not a symlink, with one link, at most 64 KiB, in a canonical parent directory, and carry the ownership marker `borgmcp-server-owned:<label>`. A definition that group or others can write is rejected. Any other mode is repaired to 0600. A foreign definition is rejected [managed-service.ts; managed-service-install.ts].

### Dashboard

- The dashboard removes escape and control characters from untrusted text before it renders [dashboard.ts:sanitizeTerminalText].
- The standalone viewer opens `borg.db` read-only with `query_only=ON`. It refuses to open the database when migrations are not current [dashboard-source.ts].

## Side Effects

### Filesystem

- Data directory: `BORG_SERVER_DATA_DIR`, default `~/.borg/server`. It contains:
  - `borg.db` (WAL)
  - `server.json`, `server.key`, `server.crt`, `ca.crt`, `ca.key`
  - `credential-digest.key`
  - `runtime.lock`, `invitation-mint.lock`, `service-install.lock`
  - `logs/runtime.log` (rotated as `.1` and `.2`, 10 MiB each), `logs/managed.stdout.log`, `logs/managed.stderr.log`
  - Sources: [service.ts; bootstrap.ts; runtime-log-sink.ts; managed-service-install.ts]
- Runtime directory: `BORG_SERVER_RUNTIME_DIR`, default `~/.borg/server-runtime`. It contains `artifacts/<sha256>`, the `current` symlink, and temporary `.staging-*` and `.download-*` directories [runtime-lifecycle.ts; registry-artifact.ts].
- `~/.borg/credentials` holds the portable owner credential. Writes are atomic: a temporary file followed by a rename, under a hard-link lock [portable-credential-store.ts].
- `~/Library/LaunchAgents/ai.borgmcp.server.plist` or `~/.config/systemd/user/ai.borgmcp.server.service` holds the managed-service definition [service.ts:createNodeRuntimeOperator; managed-service-install.ts].

### Network

- HTTPS listener(s) on the bind host and port (default `127.0.0.1:7091`). LAN mode adds a loopback companion listener [service.ts; https-server.ts].
- `GET https://registry.npmjs.org/borgmcp-server/latest` and the tarball URL are fetched only during `setup` and `update` [registry-artifact.ts].

### Subprocesses

- `tar -tzf -` and `tar -xzf - -C <staging>` (archive on stdin), and `npm ci --omit=dev --ignore-scripts --no-bin-links --no-audit --no-fund` [runtime-lifecycle.ts].
- `launchctl bootstrap|kickstart|bootout|print` and `systemctl --user enable|restart|stop|disable|daemon-reload|show` [managed-service.ts; service.ts:createNodeRuntimeOperator].

### Process

- Signal handlers for SIGINT, SIGTERM, and SIGHUP. The first signal aborts. A repeated SIGINT exits with code 130, and a repeated SIGTERM exits with code 143. A repeated SIGHUP does not exit [service.ts:installProcessShutdownHandlers].
- `process.kill(pid, 0)` checks whether a process is alive [service.ts; portable-credential-store.ts].
- An aborted lifecycle subprocess gets SIGTERM on its process group (`process.kill(-pid, signal)`), then SIGKILL after 500 ms [runtime-lifecycle.ts].
- The terminal alternate screen and raw stdin are used by the dashboard [dashboard.ts; service.ts:createNodeDashboardTerminal].

### Timers

- Liveness scan every 60 s [service.ts:startLivenessScheduler].
- SSE heartbeat every 5 s [coordination-api.ts:#openStream].
- Dashboard refresh, pulse, and animation timers [dashboard.ts].
- Viewer poll every 2 s [dashboard-source.ts].

### SQLite writes

- The scoped, maintenance, credential, and liveness stores write the tables listed above. `ActivityHub` notifications are published after commit [store.ts].

### Secrets on stdout

- `client-rotate` and `invite` print secrets to stdout once [cli.ts:runCli].

## Verification

- Run: `npm test` (the `pretest` hook runs `npm run build` first). Run one file with `npm test -- test/<name>.test.ts`. For migration work, run `npm test -- test/migrations.test.ts`.
- Run: `npm run typecheck`.
- Before you hand off a change, run `npm run check`.
