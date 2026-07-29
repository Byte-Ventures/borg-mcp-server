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

For non-TTY foreground starts, the JSON record must report the verified artifact version, immutable build identity, loopback or explicitly consented LAN endpoint, and preserved data/identity. For TTY foreground starts, the normal dashboard must render the server name and version, endpoint, online state, and cube activity, and state: `Ctrl-C stops this server process. Cube data is saved on disk and is not affected.` The supported tiny-terminal fallback must retain a bounded explicit indication that Ctrl-C stops the server process and cube data remains saved. Verified build-identity and data-identity evidence must remain available through both `borg server status` and the non-TTY JSON record. SIGHUP from terminal teardown follows the same bounded cleanup path. Foreground start never loads an existing inactive service definition.

### Status

Status must report only runtime evidence supplied by the server: running/stopped state, exact running artifact and immutable build identity when available, endpoint, process mode, managed-service state, runtime-lock state, and data-identity availability.

If the running build identity is unavailable, status must say it is unavailable. It must never substitute a source checkout, package cache, or guessed version. The recovery direction is to activate a verified artifact or inspect the explicit service configuration.

A private, structurally valid server lock with a conclusively absent PID is a typed stale-lock diagnostic, not a generic command failure. The diagnostic includes only the bounded decoded PID, process-absence evidence, identity, endpoint, and mode; it never includes the nonce or raw lock bytes. `recover-stale-lock` revalidates the evidence and renames the lock to a unique preserved file. It never deletes evidence, starts a process, or acts when the PID may be live or the lock cannot be verified.

### Update, Restart, And Rollback

Update has four visible phases: verification, activation, result, and next action. Only a verified artifact may activate. A verification failure says no activation occurred and that the last verified runtime remains available.

Restart and rollback are bounded. A successful result reports the running artifact identity. A bounded failure reports either that the last verified runtime was restored or that the server stopped safely; it must always state that data and identity were preserved and point to status as the next action.

Runtime activation and global controller installation are separate operations. Update must never rewrite the executable that is currently running or guess the operator's global package prefix. When a verified runtime is newer than the installed controller, successful TTY and machine output must identify both versions and give the exact version-pinned `npm install --global borgmcp-server@<version>` completion action. Status gives that same action when the running runtime is newer, or when the prepared runtime is newer while stopped. When the controller is newer than the effective runtime, status retains `borg-mcp-server update` as the recovery action.

### Managed Service Handoff

Managed persistence is explicit and distinct from foreground start. The server may offer a platform adapter for `launchd` on macOS and `systemd` on Linux. Before enabling it, output must identify the adapter and instruct the operator to review the generated service definition. Status reports the definition independently as active, inactive, or absent. Update restarts an active managed runtime, leaves an inactive definition stopped after preparing the verified artifact, and leaves an absent service in the foreground-only state.

The server does not own a command that loads platform service state. For an existing inactive definition it names the exact structured platform argv: restart/kickstart when the service remains loaded, or bootstrap/enable when it is unloaded but defined. Creating, rewriting, or loading service definitions remains outside this lifecycle slice.

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

## Current command reference

Inspect exact
running evidence or stage and activate a verified update with:

```sh
borg-mcp-server status
borg-mcp-server version
borg-mcp-server update
borg-mcp-server stop
borg-mcp-server recover-stale-lock
```

When stdout is not a terminal, `status`, `version`, `update`, `stop`, and
`recover-stale-lock` emit one bounded JSON record. The installed controller and the prepared/running runtime
are separate layers: installing a newer CLI does not activate its server
artifact, and activating a newer runtime does not rewrite the globally installed
controller. `update` reports both identities. If the activated runtime is newer,
follow its exact `Next: npm install --global borgmcp-server@<version>` action to
finish the controller update. Status reports all three identities independently
and returns a non-null `next_action` whenever the installed controller and the
effective runtime disagree: `borg-mcp-server update` when the controller is
newer, or the exact global install command when the running runtime (or prepared
runtime while stopped) is newer. It never derives a build identity from a source
checkout; unavailable evidence is reported as unavailable.

Status also reports managed-service state independently as `active`, `inactive`,
or `absent`. An existing but inactive definition stays stopped during update;
status names its exact platform recovery command (`launchctl bootstrap ...` on
an unloaded macOS definition, `launchctl kickstart ...` when it remains loaded,
or the corresponding `systemctl --user enable --now ...` / `restart ...` command
on Linux) without running it.
`borg-mcp-server start` is always foreground-only: it never loads an existing
LaunchAgent or systemd unit.

A private, valid `runtime.lock` whose recorded PID is conclusively absent is
reported as typed stale-lock evidence rather than making status unusable.
`borg-mcp-server recover-stale-lock` revalidates that evidence and preserves the
lock under a unique `runtime.lock.stale-*` name. It never deletes the evidence,
starts a process, or acts on an unsafe, malformed, possibly-live, or
identity-unverifiable lock. Run status again afterward; if a managed definition
is inactive, follow the separately reported platform command.

`stop` unloads the existing managed launchd/systemd service and waits for its
runtime lock to disappear. It is idempotent and preserves server data, TLS
identity, credentials, cubes, artifacts, and service definition. A foreground
server is owned by its terminal instead, so `stop` directs the operator to use
Ctrl-C there rather than signaling a PID inferred from an untrusted lock.

The server library provides matching launchd and systemd adapter definitions
that point at the atomically selected `current` artifact and preserve
`BORG_SERVER_DATA_DIR`. Managed persistence is an explicit, separately reviewed
handoff; foreground start never installs or loads it.
