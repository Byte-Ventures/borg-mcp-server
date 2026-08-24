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
listener or managed service. Its output names the prepared bind address that is
written into the server certificate. Running `setup` again is idempotent: it
preserves the existing data and identity, reports the address persisted in
`server.json`, and never repeats credentials. After stopping the
server, `borg-mcp-server setup --reinitialize` recreates the database and leaf
identity while preserving the existing CA. It refuses to run if either `ca.key`
or `ca.crt` is absent or invalid, before deleting any server state. Use the
separate documented CA-loss recovery procedure only when the CA material is
genuinely unavailable.

## Managed service

`borg-mcp-server start` is always foreground-only. To install and start a
loopback-only background service after setup, run:

```sh
borg-mcp-server service install
```

The command requires a complete initialized data directory, a verified prepared
runtime, and no foreground server process. It installs a launchd agent on macOS
or a systemd user service on Linux. Repeating the command is idempotent. A stale
definition is replaced only when it is an owner-private regular file carrying
Borg's current ownership marker. Markerless historical definitions and other
unmarked definitions are left untouched.

If install refuses a historical definition, stop the service with the platform
command below, preserve or remove the old definition manually, then rerun
`borg-mcp-server service install`. If uninstall refuses that definition, perform
the same manual cleanup, then rerun `borg-mcp-server service uninstall`. If the
definition is already absent but its registration remains, use the leftover
registration commands reported by uninstall. The default definition is
`~/Library/LaunchAgents/ai.borgmcp.server.plist` on macOS and
`~/.config/systemd/user/ai.borgmcp.server.service` on Linux.

Remove the managed definition, stopping the service first when it is active,
with:

```sh
borg-mcp-server service uninstall
```

The command is an idempotent no-op when both the definition and service-manager
registration are absent. If the definition is absent but the service manager
still reports the service, the command identifies the leftover registration and
prints the platform removal commands without changing it. Uninstall removes only
the same owner-private, single-link, Borg-owned regular-file shapes accepted by
the installer; foreign, linked, permissively readable, or otherwise unsafe
definitions remain untouched. Data, server identity, credentials, verified
runtime artifacts, and managed and runtime logs are preserved. If controller
or filesystem removal fails, human and `--json` output report the independently
observed definition state, service state, exact platform recovery command when
one is available, and whether a previously running stable identity returned.

The definition and its stdout/stderr sinks are owner-private, and the managed
process uses umask `077`. Logs are written under
`~/.borg/server/logs/managed.stdout.log` and
`~/.borg/server/logs/managed.stderr.log` when the default data directory is in
use. Authenticated-request, liveness, and activity-store timing records go to the
server-owned `~/.borg/server/logs/runtime.log`. The server rotates that file at
10 MiB and retains three files total (`runtime.log`, `.1`, and `.2`), enough for
more than one day at the expected tens of thousands of records per day. Startup
and crash output remain in managed stderr.

Runtime telemetry is optional and never falls back to per-request stderr. If a
runtime log path is a symbolic link, has multiple hard links, belongs to another
user, or permits group/other access, startup emits one `RUNTIME_LOG_UNSAFE`
warning, disables telemetry, and continues serving. Stop the server, repair or
remove the unsafe `runtime.log*` files, and restart to restore telemetry. A full,
slow, or temporarily unavailable disk emits one bounded warning, drops newest
ordinary records when the in-memory queue reaches 1,024 records or 1 MiB, reserves
two records and 4 KiB for `slow_*` evidence, and retries the owned sink. The next
successful record reports the dropped and failed counts. On startup, the server
validates the current file's final JSON line and truncates an incomplete or
invalid tail to the last complete record before appending.

`borg-mcp-server status` reports whether the service is active, inactive,
or absent and identifies its adapter. Use the platform service manager for
temporary stop and restart operations:

```sh
# macOS
launchctl kickstart -k gui/$(id -u)/ai.borgmcp.server
launchctl bootout gui/$(id -u)/ai.borgmcp.server

# Linux
systemctl --user restart ai.borgmcp.server
systemctl --user stop ai.borgmcp.server
```

The server has no public `stop` command; a foreground process remains owned by
its terminal and stops with Ctrl-C.

Current server runtime locks include the process mode and verified runtime
identity. If a live server owns an older or incomplete `runtime.lock`, stop it
through its original terminal or the platform service manager. Only after that
process exits, remove `runtime.lock` from the server data directory and retry.

## Dashboard

`borg-mcp-server start` remains a foreground command. In an interactive
terminal it opens a read-only dashboard showing the verified server identity,
the effective endpoint and bind mode, and an attention-first Sensor Grid. The
layout prioritizes the ATTN band, the focused cube's per-drone status and
attention cells, one shared cube-level Sensor Scope, a recent activity feed,
and then a paged cube list ranked by coordination posts in the trailing 15
minutes. The scope aggregates the existing five-second activity samples across
the focused cube; it does not draw per-drone activity graphs. Distinct posting
drones break ranking ties. The scope has a separate dotted baseline and labels
the start, intermediate thirds, and current end of the selected window. The
status words LIVE, RECENT, QUIET, and DARK keep liveness meaningful without
color. The feed query retains at most the eight newest entries, while the
interactive layout shows up to four according to the available height. Each
row contains only a sanitized, terminal-width-truncated head of its message;
the database query bounds that head to 256 code points. It does not display
full message bodies, actor or recipient IDs, or document contents.

The Sensor Grid refreshes on committed activity, acknowledgements, terminal
resize, and a bounded five-second age tick. New activity produces a short,
event-driven cube pulse. By default, one scan column advances inside the shared
scope at no more than two frames per second without reading the database. A
frame taking longer than 50 milliseconds disables ambient motion for that
viewer session and reports
`motion: calm (auto)` in the footer.

No input is required. When stdin is also an interactive terminal, `<` and `>`
pin the preceding or following ranked cube and `a` returns to auto-follow. The
`(auto)` marker makes the current mode explicit; pinned focus never silently
times out or jumps back to rank one. `w` cycles a fixed 5m, 15m, or 60m
activity window without changing it automatically, and Space pages the cube
list. These keys change presentation only and never mutate server or cube
state.

At 100 columns and wider, the shared scope and drone board render side by side;
at narrower widths they stack. Below 12 rows, the endpoint/bind row, feed, and
cube list yield to a compact deck with an inline scope ramp and the highest
priority drone status cells. Stale and then unacknowledged attention targets
precede liveness ordering, so exact 40-by-10 terminals retain ATTN plus the
target STATUS/name/age cell. The dashboard uses box-drawing terminal glyphs by
default. `--ascii` forces a strict 7-bit rendering, and incompatible
terminal/locale settings select that fallback automatically. `NO_COLOR`
removes color without removing status labels or layout cues.
`BORGMCP_DASHBOARD_MOTION=ambient` (the default) moves the in-scope scan column
every 500 milliseconds and retains event pulses. `calm` advances the scan
column once after each successful data refresh, including the five-second idle
refresh, and retains event pulses. `off` leaves the marker fixed at its
terminal position with no marker animation or event pulse.
`--no-motion` selects `off`, fixes the scan column at the scope's terminal
position, and always wins over the environment setting.
An interactive `TERM=dumb` terminal keeps the same Sensor Grid hierarchy with
strict ASCII and no color. Terminals below 40 columns or 10 rows receive a
bounded plain-text status view; at constrained sizes lower-priority feed and
cube-list rows yield before ATTN and the focused drone board's status, name,
and age.

Ctrl-C or terminal teardown stops the server, restores the prior terminal screen and cursor, and
does not install or enable persistence. Redirected output and managed-service
execution never enter the alternate screen or emit ANSI rendering; they retain
the existing single bounded machine-readable startup record. That record includes
`endpoint`, the prepared `bind_host`, the effective `bind_mode`, and a runnable
`bind_remedy` when the prepared and effective bind intent differ.

To observe an already-running local server from a second terminal, run
`borg-mcp-server dashboard` (optionally with `--ascii` or `--no-motion`). This
viewer opens the existing SQLite database read-only and shows the same
dashboard. `BORGMCP_DASHBOARD_MOTION` applies to this viewer as well.
The same optional navigation keys work in this viewer. Ctrl-C closes only the
viewer; the server keeps running. Redirected or non-TTY viewer output is one
bounded non-ANSI snapshot and then exits.

The standalone viewer is an operator-local, all-cubes view. Authorization is
the ownership and private filesystem permissions on `BORG_SERVER_DATA_DIR`
(default `~/.borg/server`): the viewer requires the current operating-system
user to own the private directory and database, and rejects untrusted writable
path ancestors. It is not a per-client, per-principal, tenant-scoped, or remote
dashboard. The command refuses missing, non-private, incompatible, or stopped
installations. Its feed has the same eight-entry, 256-code-point sanitized
message-head boundary as the embedded dashboard and never displays a full
message body.

## Network configuration

Follow the website's [server operations guide](https://borgmcp.ai/docs/run-server/)
for the complete loopback and private-LAN sequence. The direct server start
syntax for a private address is:

```sh
borg-mcp-server start --host 192.168.1.20 --port 7091 --lan
```

The prepared address is certificate configuration, not persisted consent to a
LAN bind. If an installation prepared for a private-LAN address starts without
`--host` and `--lan`, it remains on loopback and prints the exact command that
starts it on the prepared address with fresh LAN consent.

TLS files may instead be supplied explicitly with
`BORG_SERVER_TLS_KEY_FILE`, `BORG_SERVER_TLS_CERT_FILE`, and
`BORG_SERVER_TLS_CA_FILE`.

### LAN address changes

The server certificate contains IP subject-alternative names, and startup
requires an exact SAN for the requested bind address. If the server's LAN
address changes, perform the leaf-reissue procedure while the server is stopped:

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
unique eight-hex-character prefix. Cursor timestamps accept UTC ISO-8601 values
ending in `Z`, with no fractional seconds or with one to three fractional digits;
malformed selectors identify the accepted forms. Point lookups retain the same
cube visibility rules as paginated reads.

Roster `wake_state` is `idle` when no directed dispatch is pending, `pending`
while an unacknowledged dispatch is within the three-minute wake window, `awake`
after an acknowledgement, and `stale` after the window expires. For each pending
directed dispatch, the server sends its recipient at most two delivered wake-path
pings, no more than one per minute. An offline recipient is skipped without
consuming an attempt, nothing is queued for later delivery, and an arbitrary
interval may therefore separate the two delivered pings. Each ping is ephemeral,
non-durable, and delivered to every drone on that dispatch's recipient list;
drones outside the list never observe it. Co-recipients therefore observe one
another's pings, so a dispatch with N unacknowledged recipients can deliver up to
N wake events to each recipient. A ping is not written to or replayed from the
activity log, and it leaves no durable record for a reconnecting drone.
Acknowledgement is the liveness signal, not an idle drone's last-seen timestamp.

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
live. Client listing, rotation, revocation, and grant changes are operator-only
live-safe operations; the running server observes committed changes on the next
request.

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
SQLite write on the next request. A concurrent database write fails closed and
can be retried.

## Capacity controls

The website's [self-hosting reference](https://borgmcp.ai/docs/self-hosting/)
lists the operator-facing storage and growth settings and their defaults. This
server also accepts `BORG_SERVER_CONTEXT_GUIDELINE_BYTES` (default: 16384 bytes)
for directive and playbook review advisories.

Invalid values fail closed before the server starts.
Document storage uses two UTF-8 byte budgets:
`BORG_SERVER_MAX_DOCUMENT_BYTES` defaults to 65536 bytes per document, and
`BORG_SERVER_MAX_ACTIVE_DOCUMENT_BYTES_PER_CUBE` defaults to 524288 bytes per
cube. Active and superseded revisions count; removed documents remain
audit-readable but do not count. The per-document value must not exceed the
per-cube value. When the active budget fills, remove superseded revisions with
the client's `borg_remove-document` tool before retrying.

Activity messages use `BORG_SERVER_LOG_ENTRY_ADVISORY_BYTES` (default 1024) and
`BORG_SERVER_MAX_LOG_ENTRY_BYTES` (default 4096). Messages above the advisory
and at or below the hard limit are accepted with document-storage guidance.
Messages above the hard limit are rejected before mutation. The advisory must
not exceed the hard limit, and the hard limit cannot exceed the durable
10240-byte storage ceiling.

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
