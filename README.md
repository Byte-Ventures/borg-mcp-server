# borgmcp-server

`borgmcp-server` is the self-hosted coordination authority for Borg MCP. It
stores cube state locally and serves the Borg protocol over authenticated
HTTPS.

## Release status

The current public preview and install target is `borgmcp-server@0.7.0`.
Verify current package metadata through [npm](https://www.npmjs.com/package/borgmcp-server).
Historical release notes are preserved in [`RELEASES.md`](RELEASES.md).

## Dependency lock verification

Current lock verification remains
entirely offline: exact versions, canonical npm tarball URLs, SHA-512 integrity,
root identity, duplicate consistency, and install-script boundaries are
checked without querying registry metadata.

## Repository topology

Borg MCP's local/self-hosted product is split across three public repositories:

- [`borg-mcp-client`](https://github.com/Byte-Ventures/borg-mcp-client) provides
  the local MCP and command-line client.
- [`borg-mcp-server`](https://github.com/Byte-Ventures/borg-mcp-server) is this
  self-hosted coordination authority.
- [`borg-mcp-shared`](https://github.com/Byte-Ventures/borg-mcp-shared) defines
  the portable protocol contract and conformance suite used by both sides.

The repositories release independently. Protocol changes land and pass portable
conformance in `borg-mcp-shared` first; client and server then update to an exact,
reviewed registry release. Neither consumer uses Git or SSH dependencies.

## Advisory runtime metadata

Protocol v5 attach requests may include the complete shared
`runtime_metadata` report: Agent CLI kind, reported model, canonical public
repository name, and canonical HTTPS origin. An omitted first report is stored
as not reported; an explicit all-null report is stored as reported unknown.
Reattaching the same authenticated seat may refresh the complete report without
creating a new seat.

An active drone session may repair only its own seat with
`PATCH /api/cubes/:cubeId/drones/self/metadata`. Sparse patches preserve omitted
fields, explicit null clears a field, and repository name/origin are always
validated and changed as one pair. Drone-list responses expose the four fields
plus `runtime_metadata_reported`.

This metadata is display-only. It never grants cube access, changes role or
posture, selects routing, marks liveness or `last_seen`, creates activity-log
entries, wakes a seat, or starts a model turn. Validation and canonicalization
come from the exact pinned `borgmcp-shared` contract; rejected values are not
echoed in responses or debug diagnostics.

## Requirements

- Node.js 22.12 or later
- npm 10 or later
- A private local data directory with sufficient disk space

## Install

Install the current public preview from npm:

```sh
npm install --global borgmcp-server
```

## Set up a local server

The default data directory is `~/.borg/server`. Setup creates the local
database, credential-digest key, local certificate authority, server
certificate, and one same-machine owner binding. The matching client credential
is written atomically to the portable owner-only file at
`~/.borg/credentials` (mode `0600`). Its `~/.borg` parent must be owner-controlled
and not group/world-writable. Setup prints no credential, invitation, or credential path,
and creates no cube.

Credential updates share the client-compatible `~/.borg/credentials.lock` protocol.
A live holder is waited on for a bounded interval. A corrupt or dead-holder lock
fails closed and is never reclaimed automatically; remove it only after confirming
that no Borg process is running.

```sh
borg-mcp-server setup
borg-mcp-server start
borg assimilate
```

Setup verifies and prepares the latest immutable npm artifact, but starts no
listener or managed service. Running `setup` again is idempotent: it preserves
the existing data and identity and never repeats credentials. After stopping the
server, `borg-mcp-server setup --reinitialize` explicitly destroys and recreates
the server identity and database; use it only when prior state may be discarded.

`borg-mcp-server start` remains a foreground command. In an interactive
terminal it opens a read-only dashboard showing the verified server identity,
the most active cube in an auto-following per-drone activity panel, and a paged
cube list ranked by coordination posts in the trailing 15 minutes. Distinct
posting drones break ties. New activity produces a short, event-driven cube
pulse. The panel shows per-drone labels, sent counts, last-active age, and an
in-process activity history over the selected window; at full density it also
shows role and received counts. The dashboard never displays activity message
bodies. The panel absorbs the terminal rows left after the cube list and fixed
chrome. It refreshes on committed activity, on terminal resize, and on a
bounded five-second age tick.

No input is required. When stdin is also an interactive terminal, `<` and `>`
pin the preceding or following ranked cube and `a` returns to auto-follow. The
`(auto)` marker makes the current mode explicit; pinned focus never silently
times out or jumps back to rank one. `w` cycles a fixed 5m, 15m, or 60m
activity window without changing it automatically, and Space pages the cube
list. These keys change presentation only and never mutate server or cube
state.

The dashboard uses box-drawing terminal glyphs by default. `--ascii` forces a
strict 7-bit rendering, and incompatible terminal/locale settings select that
fallback automatically. `NO_COLOR` removes color without removing status
labels or layout cues. Terminals smaller than roughly 40 columns by 10 rows
receive a bounded plain-text status view. The activity panel uses a flat
single-column box outline with no perspective cube art.

Ctrl-C or terminal teardown stops the server, restores the prior terminal screen and cursor, and
does not install or enable persistence. Redirected output and managed-service
execution never enter the alternate screen or emit ANSI rendering; they retain
the existing single bounded machine-readable startup record. Inspect exact
running evidence or stage and activate a verified update with:

To observe an already-running local server from a second terminal, run
`borg-mcp-server dashboard` (or add `--ascii`). This viewer opens the existing
SQLite database read-only and shows the same dashboard.
The same optional navigation keys work in this viewer. Ctrl-C closes only the
viewer; the server keeps running. Redirected or non-TTY viewer output is one
bounded non-ANSI snapshot and then exits.

The standalone viewer is an operator-local, all-cubes view. Authorization is
the ownership and private filesystem permissions on `BORG_SERVER_DATA_DIR`
(default `~/.borg/server`): the viewer requires the current operating-system
user to own the private directory and database, and rejects untrusted writable
path ancestors. It is not a per-client, per-principal, tenant-scoped, or remote
dashboard. The command refuses missing, non-private, incompatible, or stopped
installations and never displays activity message bodies.

```sh
borg-mcp-server status
borg-mcp-server version
borg-mcp-server update
borg-mcp-server stop
borg-mcp-server recover-stale-lock
```

When stdout is not a terminal, `status`, `version`, `update`, `stop`, and
`recover-stale-lock` emit one bounded JSON record. The installed controller and the prepared/running runtime
are separate layers: installing a newer CLI does not activate its server
artifact, and activating a newer runtime does not rewrite the globally installed
controller. `update` reports both identities. If the activated runtime is newer,
follow its exact `Next: npm install --global borgmcp-server@<version>` action to
finish the controller update. Status reports all three identities independently
and returns a non-null `next_action` whenever the installed controller and the
effective runtime disagree: `borg-mcp-server update` when the controller is
newer, or the exact global install command when the running runtime (or prepared
runtime while stopped) is newer. It never derives a build identity from a source
checkout; unavailable evidence is reported as unavailable.

Status also reports managed-service state independently as `active`, `inactive`,
or `absent`. An existing but inactive definition stays stopped during update;
status names its exact platform recovery command (`launchctl bootstrap ...` on
an unloaded macOS definition, `launchctl kickstart ...` when it remains loaded,
or the corresponding `systemctl --user enable --now ...` / `restart ...` command
on Linux) without running it.
`borg-mcp-server start` is always foreground-only: it never loads an existing
LaunchAgent or systemd unit.

A private, valid `runtime.lock` whose recorded PID is conclusively absent is
reported as typed stale-lock evidence rather than making status unusable.
`borg-mcp-server recover-stale-lock` revalidates that evidence and preserves the
lock under a unique `runtime.lock.stale-*` name. It never deletes the evidence,
starts a process, or acts on an unsafe, malformed, possibly-live, or
identity-unverifiable lock. Run status again afterward; if a managed definition
is inactive, follow the separately reported platform command.

`stop` unloads the existing managed launchd/systemd service and waits for its
runtime lock to disappear. It is idempotent and preserves server data, TLS
identity, credentials, cubes, artifacts, and service definition. A foreground
server is owned by its terminal instead, so `stop` directs the operator to use
Ctrl-C there rather than signaling a PID inferred from an untrusted lock.

The server library provides matching launchd and systemd adapter definitions
that point at the atomically selected `current` artifact and preserve
`BORG_SERVER_DATA_DIR`. Managed persistence is an explicit, separately reviewed
handoff; foreground start never installs or loads it. The lifecycle contract and terminal
copy are documented in
[`docs/design/sprint-6-server-lifecycle.md`](docs/design/sprint-6-server-lifecycle.md).

The server listens on `https://127.0.0.1:7091` by default. Use
`BORG_SERVER_DATA_DIR` to select another data directory.

## Network configuration

Loopback is the safe default. Binding to a private LAN address requires both an
explicit address and `--lan` consent:

```sh
borg-mcp-server start --host 192.168.1.20 --port 7091 --lan
```

Before LAN startup, move `ca.key` out of the runtime data directory. Keep the
CA private key offline; the running service does not need it. Public, wildcard,
unspecified, multicast, and otherwise unsafe bind addresses are rejected.

TLS files may instead be supplied explicitly with
`BORG_SERVER_TLS_KEY_FILE`, `BORG_SERVER_TLS_CERT_FILE`, and
`BORG_SERVER_TLS_CA_FILE`. Run `borg-mcp-server help` for the complete command
summary.

## Debugging

Debug diagnostics are off by default. A local operator can enable centrally
redacted, one-line JSON records on stderr for one server run:

```sh
borg-mcp-server start --log-level debug
```

Records include normalized routes, principal and coordination IDs, authorization
outcomes, recipient fan-out, cursor replay, SSE lifecycle, and credential-session
events. They never include authorization headers, credentials, invitations,
recovery material, request or message bodies, decision text, tokens, raw paths, or
exceptions. Operational IDs are still private data; capture stderr only in a
private local sink. The log level cannot be changed through the network API.

## Local credential administration

Invitation minting is an additive local operation and may run while the server is
live. Rotation, revocation, and grant changes remain exclusive: stop the server
before running those commands.

```sh
borg-mcp-server client-rotate <client-id>
borg-mcp-server client-list
borg-mcp-server client-revoke <client-name-or-handle>
borg-mcp-server invite "Alice laptop"
borg-mcp-server client-grant <client-name-or-handle> <cube-id> <read|write|manage>
borg-mcp-server client-ungrant <client-name-or-handle> <cube-id>
```

`invite` uses the locally stored owner credential to create one single-use client
invitation with the supplied client name and prints it only in an interactive
terminal. It never places a credential or invitation in argv or environment, and
refuses non-interactive output. The invitation can then be exchanged through the
existing enrollment protocol. It grants no server capability or cube access.
An explicit name must not already belong to an active client or a live unclaimed
invitation; choose another name when the mint is refused.

`client-list` shows each client name beside its current ID-derived handle, its
active or revoked state, and its cube grants. Names created before named
invitations may be duplicated. A duplicated name is refused as a selector; use
one of the offered selectors. If a later client collides with an earlier short
handle, both handles lengthen and the stale shorter form fails closed with the
current candidates. A name that also identifies another client's handle or UUID
is likewise refused with a working selector for each candidate. An explicit
`id:<client-uuid>` selector disambiguates a client whose handle is shadowed by a
name. Existing client UUIDs remain accepted.

Invitations and rotation output are secrets; do not paste them into issues, logs,
or chat.

## Capacity controls

The server accepts positive integer values for these optional environment
variables:

- `BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE`
- `BORG_SERVER_MAX_DATABASE_BYTES`
- `BORG_SERVER_MIN_FREE_DISK_BYTES`

Invalid values fail closed before the server starts.
Cube creation is additionally bounded to 100 cubes per creating client and
1,000 cubes per server. Exact idempotent retries do not consume quota twice.

## Library entry point

The package exports `runCli`, `CliIo`, and `ServerService` for controlled
embedding. Most installations should use the `borg-mcp-server` executable.

## Security and support

Read [SECURITY.md](SECURITY.md) before exposing the service beyond loopback.
Use GitHub Issues for reproducible non-sensitive defects. Report
vulnerabilities privately as described in the security policy.

## License

This server is licensed under the Functional Source License, Version 1.1,
ALv2 Future License (`FSL-1.1-ALv2`). Each released version becomes available
under Apache License 2.0 on the second anniversary of the date that version was
made available. See [LICENSE](LICENSE) for the controlling terms and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency disclosures.
