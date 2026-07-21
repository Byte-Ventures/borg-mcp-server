# Sprint 6 Server Lifecycle CLI Specification

## Status

Design gate for borg-mcp-server #104/#109 and borg-mcp-client #91. The companion mockup is `docs/design/mockups/sprint-6-server-lifecycle.html`.

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
- Do not expose artifact URLs, credentials, recovery material, local secret paths, CA material, or raw process errors.
- Do not add retry loops, service installation, or LAN enablement implicitly.

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
- Any new lifecycle copy, service command grammar, or error state is returned to Product Design before hardening.
