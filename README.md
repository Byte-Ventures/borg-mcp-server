# borgmcp-server

`borgmcp-server` is the self-hosted coordination authority for Borg MCP. It
stores cube state locally and serves the Borg protocol over authenticated
HTTPS.

## Requirements

- Node.js 22.12 or later
- npm 10 or later
- A private local data directory with sufficient disk space

## Install

```sh
npm install --global borgmcp-server
```

## Set up a local server

The default data directory is `~/.borg/server`. Setup creates the local
database, credential-digest key, local certificate authority, server
certificate, and initial credentials. Run it in a private terminal because the
recovery credential and enrollment invitation are each printed only once.

```sh
borg-mcp-server setup
borg-mcp-server start
```

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

## Offline credential administration

Stop the server before rotating or revoking client credentials:

```sh
borg-mcp-server client-rotate <client-id>
borg-mcp-server client-revoke <client-id>
```

Rotation prints the replacement credential once. Treat setup, enrollment, and
rotation output as secrets; do not paste it into issues, logs, or chat.

## Capacity controls

The server accepts positive integer values for these optional environment
variables:

- `BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE`
- `BORG_SERVER_MAX_DATABASE_BYTES`
- `BORG_SERVER_MIN_FREE_DISK_BYTES`

Invalid values fail closed before the server starts.

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
