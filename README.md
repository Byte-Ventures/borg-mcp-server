# borgmcp-server

`borgmcp-server` is the self-hosted coordination authority for Borg MCP. It
stores cube state locally and serves the Borg protocol over authenticated
HTTPS.

## Release status

The current public preview is `borgmcp-server@0.1.7`, published on npm.
Versions `0.1.2` and `0.1.3` were not published; their immutable tags are
preserved failed-release evidence and are not installation or dogfood targets.
Version `0.1.5` includes the reviewed owner-enrollment, idempotent multi-cube
creation, managed role administration, fail-closed setup reinitialization,
redacted debug logging, and cube-scoped invitation baseline. Relative to
`0.1.4`, it adds idempotent prior-seat reattachment, migrated cube-context and
taxonomy routing, durable SSE replay and heartbeat delivery, fleet liveness
signals, typed terminal drone eviction, and explicit manage-access denials for
visible non-managing principals. Immutable `v0.1.6` failed safely before artifact
upload or npm publication and is not an install target. The published `0.1.7`
package is the reviewed recovery release and consumes the audited exact
`borgmcp-shared@0.4.2` registry release. Current source is the unpublished
`borgmcp-server@0.1.8` release candidate and consumes the verified exact
`borgmcp-shared@0.4.3` registry release. Version `0.1.7` remains the current
install target until the candidate passes exact-SHA review, immutable tag
publication, and bounded registry verification.

Setup prepares local identity and storage and prints one-time recovery and
owner-enrollment secrets; it creates no cube. Version `0.1.1` completed the
documented exact-source, tagged-artifact, and protected-publication gates.
Version `0.1.7` completed a fresh exact-source, tagged-artifact, tokenless OIDC
publication, provenance, signature, and attestation gate chain.

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

`borg-mcp-server start` remains a foreground command. Ctrl-C stops it, and it
does not install or enable persistence. Inspect exact running evidence or stage
and activate a verified update with:

```sh
borg-mcp-server status
borg-mcp-server update
```

When stdout is not a terminal, `status` and `update` emit one bounded JSON
record. Status never derives a build identity from a source checkout. If an
older package does not provide embedded source identity, the field is reported
as unavailable.

The server library provides matching launchd and systemd adapter definitions
that point at the atomically selected `current` artifact and preserve
`BORG_SERVER_DATA_DIR`. Managed persistence is an explicit, separately reviewed
handoff; foreground start never installs it. The lifecycle contract and terminal
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
borg-mcp-server client-revoke <client-id>
borg-mcp-server invite
borg-mcp-server client-grant <client-id> <cube-id> <read|write|manage>
borg-mcp-server client-ungrant <client-id> <cube-id>
```

`invite` uses the locally stored owner credential to authorize one existing
single-use client invitation and prints it only in an interactive terminal. It
never places a credential or invitation in argv or environment, and refuses
non-interactive output. The invitation can then be exchanged through the existing
enrollment protocol. It grants no server capability or cube access.

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
