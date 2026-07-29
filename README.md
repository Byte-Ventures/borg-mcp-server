# borgmcp-server

`borgmcp-server` is the self-hosted coordination authority for Borg MCP. It
stores cube state locally and serves the Borg protocol over authenticated
HTTPS.

## Current install

The current public preview and install target is `borgmcp-server@0.7.2`.
Verify current package metadata through [npm](https://www.npmjs.com/package/borgmcp-server).

## Requirements

- Node.js 22.12 or later
- npm 10 or later
- A private local data directory with sufficient disk space

## Install and quickstart

Install the current public preview from npm:

```sh
npm install --global borgmcp-server
borg-mcp-server setup
borg-mcp-server start
borg assimilate
```

Setup prints no credential, invitation, or credential path,
and creates no cube. `borg-mcp-server start` remains a foreground command.
Managed persistence is an explicit, separately reviewed
handoff; foreground start never installs or loads it.

The server listens on `https://127.0.0.1:7091` by default. Use
`BORG_SERVER_DATA_DIR` to select another data directory.

## How it fits together

- [`borg-mcp-client`](https://github.com/Byte-Ventures/borg-mcp-client) provides
  the local MCP and command-line client.
- [`borg-mcp-server`](https://github.com/Byte-Ventures/borg-mcp-server) is this
  self-hosted coordination authority.
- [`borg-mcp-shared`](https://github.com/Byte-Ventures/borg-mcp-shared) defines
  the portable protocol contract and conformance suite used by both sides.

The repositories release independently. Protocol changes land and pass portable
conformance in `borg-mcp-shared` first; client and server then update to an exact,
reviewed registry release. Neither consumer uses Git or SSH dependencies.

## Security posture

Loopback is the safe default. Binding to a private LAN address requires both an
explicit address and `--lan` consent:

Before LAN startup, move `ca.key` out of the runtime data directory. Keep the
CA private key offline; the running service does not need it.

Read [SECURITY.md](SECURITY.md) before exposing the service beyond loopback.

## Reference and support

- [Operator reference](docs/operator-reference.md): setup, dashboard, networking,
  debugging, credential administration, and capacity controls.
- [Lifecycle specification](docs/design/sprint-6-server-lifecycle.md): status,
  update, managed-service, stop, and stale-lock semantics.
- [Protocol reference](docs/protocol-reference.md): advisory runtime metadata.
- [Release runbook](docs/releasing.md): dependency-lock and release verification.

Historical release notes are preserved in [`RELEASES.md`](RELEASES.md).

Run `borg-mcp-server help` for the complete command summary.

### Library entry point

The package exports `runCli`, `CliIo`, and `ServerService` for controlled
embedding. Most installations should use the `borg-mcp-server` executable.

### Support

Use GitHub Issues for reproducible non-sensitive defects. Report
vulnerabilities privately as described in the security policy.

### License

This server is licensed under the Functional Source License, Version 1.1,
ALv2 Future License (`FSL-1.1-ALv2`). Each released version becomes available
under Apache License 2.0 on the second anniversary of the date that version was
made available. See [LICENSE](LICENSE) for the controlling terms and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency disclosures.
