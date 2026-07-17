# borgmcp-server

`borgmcp-server` is the self-hosted coordination authority for Borg MCP. It
stores cube state locally and serves the Borg protocol over authenticated
HTTPS.

## Release status

The current public preview is `borgmcp-server@0.1.4`, published on npm.
Versions `0.1.2` and `0.1.3` were not published; their immutable tags are
internal failed-release evidence and are not installation or dogfood targets.
Version `0.1.4` retains the
reviewed owner-enrollment, idempotent multi-cube creation, and stable prior-seat
reattachment baseline, and adds managed role creation and updates, fail-closed
setup reinitialization, opt-in redacted debug logging, live-safe invitation
minting, and atomic cube-scoped invitations with enforced observer posture.
It consumes the audited exact `borgmcp-shared@0.3.0` registry release.

Setup prepares local identity and storage and prints one-time recovery and
owner-enrollment secrets; it creates no cube. Version `0.1.1` completed the
documented exact-source, tagged-artifact, and protected-publication gates.
Version `0.1.4` completed a fresh exact-source, tagged-artifact, tokenless OIDC
publication, provenance, signature, and attestation gate chain.

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
certificate, one recovery credential, and one owner enrollment invitation. It
creates no cube. Run it in a private terminal because both secrets are shown
once; the owner enrollment invitation is single-use and enrolls the owner client.

```sh
borg-mcp-server setup
borg-mcp-server start
```

Running `setup` again refuses to change an existing installation. After stopping
the server, `borg-mcp-server setup --reinitialize` explicitly destroys and
recreates the server identity and database; use it only when prior state may be
discarded.

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
borg-mcp-server client-invite
borg-mcp-server client-invite <cube-name-or-id> [--access <read|write|manage>]
borg-mcp-server owner-invite
borg-mcp-server client-grant <client-id> <cube-id> <read|write|manage>
borg-mcp-server client-ungrant <client-id> <cube-id>
```

Invitation commands visibly prompt with `Recovery credential (hidden input):`
before reading the recovery credential from a private hidden terminal, never argv
or environment. `owner-invite` prints an owner enrollment invitation. A plain
`client-invite` remains an enroll-only invitation with no cube grant. Supplying a
cube selector atomically binds one grant to the invitation. `read` attaches an
observer that can discover the cube and read shared activity, but cannot post,
acknowledge, claim, administer, be selected as a direct recipient, or receive
directed stream events. `write` attaches a participant that can coordinate and is
the default; explicit `manage` adds cube administration. Attach responses and
drone listings identify the effective `observer` or `participant` posture. The
command prints the resolved display name, full cube ID,
effective access, and capability summary before the single-use invitation.

For automation and duplicate-name environments, use the full lowercase canonical
cube UUID. A display name must match exactly and case-sensitively. Unknown names,
UUID-like malformed selectors, and duplicate names fail without creating or
printing an invitation; duplicate-name errors list the candidate IDs so the
operator can rerun unambiguously. Claiming a scoped invitation atomically creates
the client credential binding and exactly that cube grant. It grants no server
capability and no access to any other cube.

Both invitation forms are single-use and shown once. Treat setup, enrollment,
invitation, and rotation output as secrets; do not paste it into issues, logs, or
chat.

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
