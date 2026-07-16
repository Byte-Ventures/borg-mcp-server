# borgmcp-server

`borgmcp-server` is the self-hosted coordination authority for Borg MCP. It
stores cube state locally and serves the Borg protocol over authenticated
HTTPS.

## Release status

The `0.1.0` release preparation remains gated on the `#5` owner-enrollment and
cube bootstrap work. The server-side source implements purpose-bound owner
enrollment and idempotent multi-cube creation against the audited exact
`borgmcp-shared@0.3.0` registry release. It is not release-ready until the
coordinated client flow has been security-reviewed and dogfooded.

Setup prepares local identity and storage and prints one-time recovery and
owner-enrollment secrets; it creates no cube. Supported client onboarding and
local dogfooding remain unavailable until the coordinated `#5` gates pass and
this notice is removed.

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
certificate, one recovery credential, and one enrollment invitation. It creates
no cube. Run it in a private terminal because both secrets are printed only
once.

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

Stop the server before all offline client administration:

```sh
borg-mcp-server client-rotate <client-id>
borg-mcp-server client-revoke <client-id>
borg-mcp-server client-invite
borg-mcp-server owner-invite
borg-mcp-server client-grant <client-id> <cube-id> <read|write|manage>
borg-mcp-server client-ungrant <client-id> <cube-id>
```

Invitation commands read the recovery credential from a private hidden terminal
prompt, never argv or environment. Rotation and invitation commands print their
replacement secret once. Treat setup, enrollment, invitation, and rotation
output as secrets; do not paste it into issues, logs, or chat.

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
