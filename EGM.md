# borg-mcp-server Blueprint

## System Overview

`borgmcp-server` 5.0.0 is the local coordination server for Borg MCP. It ships the `borg-mcp-server` binary (`dist/main.js`). It is local-first: a single-host HTTPS (TLS 1.3) server on `127.0.0.1:7091` by default, with SQLite persistence under `~/.borg/server`. Clients (`borgmcp`) enroll with it and then coordinate cubes, roles, drones, the activity log, documents and decisions over the `borgmcp-shared` wire protocol. Users normally drive it through the client's `borg server …` wrapper. [AGENTS.md](./AGENTS.md) is authoritative.

Request flow: `src/main.ts` `runMain` → `src/cli.ts` `runCli` → `src/service.ts` (bootstrap, credentials, store, HTTPS, liveness, dashboard, runtime update) → `src/https-server.ts` (transport) → `src/coordination-api.ts` (protocol behavior) → `src/store.ts` (SQLite and authorization through `StoreRuntime.forPrincipal()`).

Cross-repository contract: protocol decoders, envelopes, templates and conformance vectors come from the exact pinned dependency `borgmcp-shared` `3.0.0` ([borg-mcp-shared](https://github.com/Byte-Ventures/borg-mcp-shared)). A wire change is made there first. The client is [borg-mcp-client](https://github.com/Byte-Ventures/borg-mcp-client).

## Local Interface & Invariants

- `vitest.config.ts`: Vitest with `testTimeout` 60 000 ms and no other options.
- `package.json`: `pretest` runs `npm run build`, because some tests inspect `dist/`. `check` = `typecheck` + `test`. `engines.node` is `>=22.18.0`. Dependencies are exact versions, locked by `npm-shrinkwrap.json`.

## Subdirectories & System Boundaries

- src: [./src/EGM.md](./src/EGM.md). The server source: the CLI (`setup`, `start`, `dashboard`, `status`, `service install|uninstall`, `update`, `client-*`, `invite`, …), `ServerService` composition, the HTTPS routes, `CoordinationApi`, credential authority, the `Principal` model, `openStore`/`StoreRuntime`, `STORE_MIGRATIONS` v1–30 over 29 live SQLite tables, the runtime update lifecycle, the launchd/systemd managed service `ai.borgmcp.server`, and the dashboards.
- scripts: [./scripts/EGM.md](./scripts/EGM.md). Release tooling: `release-identity.mjs` (prepare, verify, classify), lockfile and source-lock verification, packed-tarball verification and exercise, registry prepublish/postpublish checks, and GitHub Release creation.

`docs/` (design notes and release notes) and `test/` contain no production code and have no contract.

## Global Invariants

- Loopback is the default. A private-LAN bind needs both an explicit non-loopback host and `--lan`. HTTPS is TLS 1.3 only.
- `borg-mcp-server start` runs in the foreground only. It never installs or loads a managed service.
- Runtime bootstrap is offline. `test/no-egress.test.ts` permits outbound fetch only in `src/registry-artifact.ts`, and subprocess creation only in runtime/service lifecycle code.
- Request code uses a server-derived `Principal` and `StoreRuntime.forPrincipal()`. Never pass a raw database handle across that boundary.
- Migrations are the ordered `STORE_MIGRATIONS` array in `src/migrations.ts`. Never edit a migration that appeared in a published version. Append a new version, and append its checksum to `src/migration-checksums.ts`.
- Operator-facing errors are secret-free and mapped through `src/operator-error.ts`. Debug output goes only through the redacted logger.
- The protocol tag must match exactly (from `borgmcp-shared`). Client and server releases move as a matched pair.
- Release identity comes only from `scripts/release-identity.mjs`. Never bump version literals by hand. Never create, move or reuse a release tag without explicit authorization.
- Lifecycle tests use fixture controllers for every `launchctl` and `systemctl` call.

## Global Side Effects

- Environment: `BORG_SERVER_DATA_DIR` and `BORG_SERVER_RUNTIME_DIR` set the directories below. `selectServerEnvironment` also reads `BORG_SERVER_TLS_KEY_FILE`, `BORG_SERVER_TLS_CERT_FILE`, and `BORG_SERVER_TLS_CA_FILE` (they override the TLS paths), `BORG_SERVER_BIND_HOST`, the storage-limit variables (`BORG_SERVER_MAX_*`, `BORG_SERVER_MIN_FREE_DISK_BYTES`, `BORG_SERVER_CONTEXT_GUIDELINE_BYTES`, and the document and log-entry limit names from `borgmcp-shared`), `BORG_SERVER_SOURCE_SHA`, `BORG_SERVER_ARTIFACT_INTEGRITY`, `BORG_SERVER_PROCESS_MODE` (`foreground` or `managed`), and `BORGMCP_DASHBOARD_MOTION`. `setup` reads `BORG_CLIENT_ONBOARDING`.
- Files: the data directory `BORG_SERVER_DATA_DIR` (default `~/.borg/server`: `borg.db`, TLS/CA material, the digest key, locks, `logs/`), the runtime directory `BORG_SERVER_RUNTIME_DIR` (default `~/.borg/server-runtime`), and `~/.borg/credentials`.
- OS services: a launchd plist or systemd user unit `ai.borgmcp.server`, created only by `service install`.
- Network: an HTTPS listener (default `127.0.0.1:7091`). Fetches from `registry.npmjs.org` happen only during setup and update.
- Subprocesses: `tar`, `npm ci`, `launchctl`, `systemctl`.

## System Verification

- Run: `npm test` (builds first through `pretest`)
- Run: `npm run typecheck`, or `npm run check` for both
