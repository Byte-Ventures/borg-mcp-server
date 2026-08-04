# Server operator reference

## Setup and local identity

The default data directory is `~/.borg/server`. Setup creates the local
database, credential-digest key, local certificate authority, server
certificate, and one same-machine owner binding. The matching client credential
is written atomically to the portable owner-only file at
`~/.borg/credentials` (mode `0600`). Its `~/.borg` parent must be owner-controlled
and not group/world-writable.

Credential updates share the client-compatible `~/.borg/credentials.lock` protocol.
A live holder is waited on for a bounded interval. A corrupt or dead-holder lock
fails closed and is never reclaimed automatically; remove it only after confirming
that no Borg process is running.

Setup verifies and prepares the latest immutable npm artifact, but starts no
listener or managed service. Running `setup` again is idempotent: it preserves
the existing data and identity and never repeats credentials. After stopping the
server, `borg-mcp-server setup --reinitialize` recreates the database and leaf
identity while preserving the existing CA. It refuses to run if either `ca.key`
or `ca.crt` is absent or invalid, before deleting any server state. Use the
separate documented CA-loss recovery procedure only when the CA material is
genuinely unavailable.

## Dashboard

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
the existing single bounded machine-readable startup record.

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

## Network configuration

```sh
borg-mcp-server start --host 192.168.1.20 --port 7091 --lan
```

Public, wildcard,
unspecified, multicast, and otherwise unsafe bind addresses are rejected.

TLS files may instead be supplied explicitly with
`BORG_SERVER_TLS_KEY_FILE`, `BORG_SERVER_TLS_CERT_FILE`, and
`BORG_SERVER_TLS_CA_FILE`.

### LAN address changes

The server certificate contains IP subject-alternative names. If the server's
LAN address changes, older clients that perform the standard leaf SAN check can
reject the new address even though the server's CA identity is unchanged.
Clients that support CA-pinned address changes use the CA SPKI trust identity
and do not require a leaf reissue. Do not put `ca.key` online just to handle an
address change.

For an older client, perform the manual leaf-reissue procedure while the server
is stopped:

1. Retrieve `ca.key` from offline protected storage into the private server data
   directory. Confirm mode `0600` and do not copy it to the client machine.
2. Reissue the leaf for the new address:

   ```sh
   borg-mcp-server cert-reissue --host 192.168.1.20
   ```

3. Move `ca.key` back to offline protected storage before starting the server.
4. Start the server with the new address and explicit LAN consent:

   ```sh
   borg-mcp-server start --host 192.168.1.20 --port 7091 --lan
   ```

The reissue changes only `server.crt` and `server.key`. The CA certificate,
CA private key, and `ca_spki_sha256` trust identity remain unchanged. Verify
the CA bytes or fingerprint before and after the operation when carrying out a
recovery.

Running `borg-mcp-server setup` again is idempotent. The explicit
`setup --reinitialize` path recreates the database and server leaf identity
while preserving `ca.crt` and `ca.key`. If either CA file is absent or invalid,
setup refuses before deleting anything. CA regeneration is only for documented
CA-loss recovery: if the CA private key or certificate is lost, stop the server,
preserve any required encrypted backup, and plan to re-enroll clients after
creating a new identity. Never treat a changed LAN address as a reason to
reinitialize the CA.

## Activity log lookup

Activity log point lookups and paginated cursors accept a full entry UUID or a
unique eight-hex-character prefix. Cursor timestamps accept ISO-8601 values with
or without fractional seconds; malformed selectors identify the accepted forms.
Point lookups retain the same cube visibility rules as paginated reads.

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
or chat. Client grant, ungrant, revoke, and rotate operations are operator-only
and may run while the server is live. The running server observes the committed
SQLite write on the next request; requests already in flight are not retroactively
changed. A concurrent database write fails closed and can be retried.

## Capacity controls

The server accepts positive integer values for these optional environment
variables:

- `BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE`
- `BORG_SERVER_MAX_ACTIVE_DECISION_BYTES_PER_CUBE` (default: 16384 bytes of active decision text)
- `BORG_SERVER_CONTEXT_GUIDELINE_BYTES` (default: 16384 bytes for directive and playbook review advisories)
- `BORG_SERVER_MAX_DATABASE_BYTES`
- `BORG_SERVER_MIN_FREE_DISK_BYTES`

Invalid values fail closed before the server starts.
The active decision text budget sums UTF-8 bytes from each active decision's topic,
decision, and rationale. A new topic cannot exceed the budget. Replacing an
existing topic is allowed when the resulting total stays at or below the larger
of the configured budget and the current total, so cleanup and same-size
supersession remain possible even after earlier growth exceeded the budget.
The 16 KB default keeps the active registry compact enough to load into every
seat's context while allowing ordinary collections of substantive rulings.
The context guideline is advisory only: successful directive and role-playbook
updates report their resulting UTF-8 byte size, with pointed compaction guidance
at or above the configured value. It never rejects or changes a write.
Cube creation is additionally bounded to 100 cubes per creating client and
1,000 cubes per server. Exact idempotent retries do not consume quota twice.
