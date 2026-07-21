# Sprint 6 Server Lifecycle CLI Specification

## Status

Design gate for borg-mcp-server #104/#109 and borg-mcp-client #91. The companion mockups are `docs/design/mockups/sprint-6-server-lifecycle.html` and `docs/design/mockups/sprint-6-client-facade.html`.

The mockup is the user-facing acceptance surface. Implementation may choose its internal service APIs and adapter file formats, but may not change lifecycle copy, ownership, or recovery semantics without Product Design review.

## Command Ownership

The client owns the `borg server` facade. It forwards commands and renders verified server evidence. It does not infer a checkout, activate an artifact, create a service, or claim a build identity by itself.

The server owns artifact verification, activation, data and identity preservation, runtime build identity, rollback, and explicit Linux/macOS service adapters. The server executable remains the direct foreground authority.

`borg server start` and `borg-mcp-server start` are foreground commands. They must never imply that a daemon, LaunchAgent, or systemd service was installed. Managed persistence is a separate explicit handoff.

## Required States

### Setup

First setup must say that local identity and data storage were prepared, identify the verified artifact, state that no server process started, and give the foreground start command as the next action.

Repeated setup must be idempotent. It must say that data and identity are unchanged and that no process started. It must not print credentials, recovery material, or ambiguous "already running" language.

### Start

Foreground start must report the verified artifact version, immutable build identity, loopback or explicitly consented LAN endpoint, and preserved data/identity. It must say that Ctrl-C stops the foreground process and that foreground mode does not manage persistence.

### Status

Status must report only runtime evidence supplied by the server: running/stopped state, exact running artifact and immutable build identity when available, endpoint, process mode, and data-identity availability.

If the running build identity is unavailable, status must say it is unavailable. It must never substitute a source checkout, package cache, or guessed version. The recovery direction is to activate a verified artifact or inspect the explicit service configuration.

### Update, Restart, And Rollback

Update has four visible phases: verification, activation, result, and next action. Only a verified artifact may activate. A verification failure says no activation occurred and that the last verified runtime remains available.

Restart and rollback are bounded. A successful result reports the running artifact identity. A bounded failure reports either that the last verified runtime was restored or that the server stopped safely; it must always state that data and identity were preserved and point to status as the next action.

### Managed Service Handoff

Managed persistence is explicit and distinct from foreground start. The server may offer a platform adapter for `launchd` on macOS and `systemd` on Linux. Before enabling it, output must identify the adapter and instruct the operator to review the generated service definition. After enabling it, status must identify managed mode and the adapter.

The implementation must not invent a canonical service subcommand until #109 settles its command grammar. Whatever grammar is selected must preserve this copy and behavior.

### Non-TTY

Non-TTY output is one bounded machine-readable record with no ANSI, progress animation, secrets, recovery material, service-file contents, or checkout-derived identity. It carries the same evidence as TTY output: state, artifact, build identity when known, mode, data-identity state, and a bounded error code when unsuccessful.

## Copy Rules

- Say "artifact" and "build identity" for immutable runtime evidence. Do not say "current checkout" or infer one.
- Say "data and identity: preserved" only after the server verifies preservation.
- Use "last verified runtime" rather than promising a rollback when none occurred.
- Use bounded, actionable failures: what stopped, whether activation occurred, what remains available, and the next command.
- Do not expose artifact URLs, credentials, recovery material, local secret paths, CA material, or raw process errors, except for the narrow trusted-terminal fresh-setup handoff below.
- During successful fresh TTY setup only, output these two lines once:

```text
Recovery credential (store offline; authorizes recovery and new invitations; shown once): <credential>
Bootstrap owner enrollment invitation (enrolls the first owner; single-use; shown once): <invitation>
```

  These values must never appear during non-TTY setup, repeated setup, status, update, logs, diagnostics, or error output.
- Do not add retry loops, service installation, or LAN enablement implicitly.

## Client Facade Copy

The following strings are client-owned. The facade renders them before server execution. Server-owned lifecycle output passes through unchanged.

### Help

```text
Usage: borg server <command> [arguments]

Commands:
  setup    Prepare local server identity and data; does not start the server.
  start    Start the verified server in the foreground.
  status   Report verified runtime evidence.
  update   Verify and activate a local server artifact.

Run borg server <command> --help for server command options.
```

### Unsupported Command

```text
Unknown server command: <command>.
Available commands: setup, start, status, update.
Next: run borg server --help.
```

`<command>` is the parsed command token rendered as inert text. Do not include remaining user-supplied arguments. Render at most 80 Unicode code points total; replace each Unicode control code point with `?`, and, when truncated, reserve the final three code points for `...`. The renderer must not emit terminal control sequences.

### Missing Server Executable

```text
Local server command is unavailable: borg-mcp-server was not found.
Next: install a verified borgmcp-server release, then rerun borg server <command>.
No checkout fallback is attempted.
```

`<command>` is the requested lifecycle command. The client must not search a checkout, infer a local binary path, or start another process after this error.

### Server Command Startup Failure

This state applies when process creation fails for a reason other than `ENOENT`. It is distinct from Missing Server Executable and exits `1`; only `ENOENT` renders Missing Server Executable and exits `127`.

```text
Local server command could not be started.
Next: check local permissions and system resources, then rerun borg server <command>.
No server command was started.
```

`<command>` uses the same bounded inert rendering rule as Unsupported Command. Do not expose the raw spawn error, error code, executable path, or a checkout hint.

### Facade Non-TTY

For the four client-owned messages above, non-TTY behavior is the same bounded plain text with no ANSI, JSON, stack trace, searched path, or checkout hint. Server-provided non-TTY lifecycle output remains server-owned and follows the lifecycle mockup.

## Accessibility And Portability

TTY output must remain readable at 80 columns: labels precede values, long identities wrap after the label, and color is never the only distinction. Non-TTY output must not depend on terminal width or color.

Core command wording is identical on Linux and macOS. Only the adapter name and generated service-definition location may differ.

## Acceptance Checklist

- The shipped lifecycle behavior matches the companion mockup.
- Setup starts no listener or managed service.
- Foreground start never claims persistence.
- Status never guesses a build identity.
- Verification failure activates nothing.
- Restart/rollback preserves data and identity or reports a safe stopped state.
- Managed persistence is an explicit action and identifies its adapter.
- Non-TTY output is bounded and machine-readable.
- Client-rendered command tokens are inert, control-safe, and capped at 80 characters.
- Missing executable is `ENOENT` only; other spawn failures use the distinct bounded startup-failure state.
- Any new lifecycle copy, service command grammar, or error state is returned to Product Design before hardening.
