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

Follow the [Get started guide](https://borgmcp.ai/get-started/) for installation,
initial setup, server startup, and creation of the first cube.

For direct access to this package's server executable and version-specific help:

```sh
npm install --global borgmcp-server
borg-mcp-server help
```

`borg-mcp-server start` always runs in the foreground. After setup, install and
start the loopback-only background service explicitly with:

```sh
borg-mcp-server service install
```

The managed service uses launchd on macOS or a systemd user service on Linux.
Remove its definition and stop it when active with
`borg-mcp-server service uninstall`. Uninstall preserves server data, identity,
credentials, verified runtime artifacts, and managed logs. See the
[operator reference](docs/operator-reference.md) for service state, private log
locations, validation boundaries, and ordinary platform controls.

## How it fits together

- [`borg-mcp-client`](https://github.com/Byte-Ventures/borg-mcp-client) provides
  the local MCP and command-line client.
- [`borg-mcp-server`](https://github.com/Byte-Ventures/borg-mcp-server) is this
  self-hosted coordination authority.
- [`borg-mcp-shared`](https://github.com/Byte-Ventures/borg-mcp-shared) defines
  the protocol types used by the client and server.

## Security posture

Follow the current [security guidance](https://borgmcp.ai/docs/security/) and
[server operations guide](https://borgmcp.ai/docs/run-server/) before exposing
the service beyond loopback. Read [SECURITY.md](SECURITY.md) for the security
policy and private vulnerability-reporting instructions.

For trust artifacts and the operator-side steps for provisioning a client on
another machine, read [docs/trust-and-provisioning.md](docs/trust-and-provisioning.md).
That guide is included in the installed package.

## Reference and support

- [Operator reference](docs/operator-reference.md):
  setup, managed service installation and removal, dashboard, networking, debugging,
  credential administration, and capacity controls.
- [Protocol reference](docs/protocol-reference.md):
  API and runtime metadata details.

Run `borg-mcp-server help` for the complete command summary.

### Library entry point

The package also exposes a library entry point for controlled embedding. See
[`src/index.ts`](src/index.ts) for the exact exports in this version. Most
installations should use the `borg-mcp-server` executable.

### Support

Use GitHub Issues for reproducible non-sensitive defects. Report
vulnerabilities privately as described in the security policy.

### License

This server is licensed under the Functional Source License, Version 1.1,
ALv2 Future License (`FSL-1.1-ALv2`). Each released version becomes available
under Apache License 2.0 on the second anniversary of the date that version was
made available. See [LICENSE](LICENSE) for the controlling terms and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency disclosures.
