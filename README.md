# borgmcp-server

`borgmcp-server` is the self-hosted coordination authority for Borg MCP. It
stores cube state locally and serves the Borg protocol over authenticated
HTTPS.

## Install

Verify current package metadata through
[npm](https://www.npmjs.com/package/borgmcp-server).

## Requirements

- Node.js 22.18 or later
- npm 10 or later
- A private local data directory with sufficient disk space

## Install and quickstart

Install from npm:

```sh
npm install --global borgmcp-server
borg-mcp-server setup
borg-mcp-server start
```

Setup initializes local storage and identity, but does not start the server or
create a cube. The server runs in the foreground; Ctrl-C stops it without
deleting stored data.

With the server running, open another terminal and change to the Git repository
you want Borg to coordinate. Then use the installed
[`borg` client](https://github.com/Byte-Ventures/borg-mcp-client) to connect:

```sh
cd /path/to/your/project
borg assimilate
```

The server listens on `https://127.0.0.1:7091` by default. Use
`BORG_SERVER_DATA_DIR` to select another data directory.

## How it fits together

- [`borg-mcp-client`](https://github.com/Byte-Ventures/borg-mcp-client) provides
  the local MCP and command-line client.
- [`borg-mcp-server`](https://github.com/Byte-Ventures/borg-mcp-server) is this
  self-hosted coordination authority.
- [`borg-mcp-shared`](https://github.com/Byte-Ventures/borg-mcp-shared) defines
  the protocol types used by the client and server.

## Security posture

Loopback is the safe default. Binding to a private LAN address requires both an
explicit address and `--lan` consent.

Before LAN startup, move `ca.key` out of the runtime data directory. Keep the
CA private key offline; the running service does not need it.

Read [SECURITY.md](SECURITY.md) before exposing the service beyond loopback.

For trust artifacts and the operator-side steps for provisioning a client on
another machine, read [docs/trust-and-provisioning.md](docs/trust-and-provisioning.md).
That guide is included in the installed package.

## Reference and support

- [Operator reference](https://github.com/Byte-Ventures/borg-mcp-server/blob/main/docs/operator-reference.md):
  setup, dashboard, networking, debugging, credential administration, and
  capacity controls.
- [Protocol reference](https://github.com/Byte-Ventures/borg-mcp-server/blob/main/docs/protocol-reference.md):
  API and runtime metadata details.

Historical release notes are available in
[`RELEASES.md`](https://github.com/Byte-Ventures/borg-mcp-server/blob/main/RELEASES.md).

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
