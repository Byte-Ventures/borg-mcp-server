# Cube-binding operator gate

This is a manually runnable acceptance gate for the `cube-binding-model` change. It is intentionally not part of the default test suite: it needs a real PTY, a live HTTPS server, and a published client package.

## Preconditions

- Node.js 22.12 or newer, npm 10 or newer, Python 3 with the standard `pty` module, and Git.
- Run `npm ci --ignore-scripts --registry=https://registry.npmjs.org` and `npm run build` in the server checkout being tested.
- Network access to the npm registry. The harness installs `borgmcp@2.10.2` at runtime; no client package, invitation, credential, or private key is checked into this repository. npm runs with a disposable `HOME`, cache, user config, global config, and XDG config/cache/data roots under the temporary install directory, so it does not read or write the operator's npm configuration or cache.
- The server checkout used through `BORG_242_SERVER_ROOT` has a built `dist/` and installed `selfsigned` dependency. By default it is the checkout containing this script.

## Widened positive

From the server checkout:

```sh
node scripts/cube-binding-operator-gate.mjs
```

The harness creates a disposable server and database, two independent Git checkouts with the same upstream origin, and a fresh `HOME`. It enrolls the second client through the real hidden-prompt `borg assimilate --enroll` path, asserts that no repository association was saved before the second invocation, grants that client access to the fixture cube, and runs the real `borg assimilate --host ... --cube-name ... --here --cli codex` path through a PTY.

It fails unless the real path reaches the link prompt, creates the second association and client-owned drone, and then the published client's own pinned HTTPS `appendLog` and `readLog` return the exact posted entry. It scans the complete captured PTY streams for the opaque invitation and fails if it appears. The command prints only boolean/count evidence and removes its temporary server, client install, npm state, repositories, and `HOME` on exit. An existing identity file is counted only after valid JSON and the expected version/local-identities/associations object shape are verified; only a genuinely absent file counts as zero.

Set `BORG_CLIENT_SPEC` to exercise another explicitly published client version. Set `BORG_242_SERVER_ROOT` to run the client path against a different clean server build.

## Guard-present control

The guard-present control is the same harness against a clean build of the pre-change base, with an explicit expected-refusal mode:

```sh
git worktree add --detach /tmp/borg-server-242-base 734051375d77013f8fd5b396af12feb53d5af96d
npm --prefix /tmp/borg-server-242-base ci --ignore-scripts --registry=https://registry.npmjs.org
npm --prefix /tmp/borg-server-242-base run build
BORG_242_SERVER_ROOT=/tmp/borg-server-242-base \
  node scripts/cube-binding-operator-gate.mjs --expect-guard-present
```

The expected result is a real link prompt followed by refusal at association: association count `1`, second-client drone count `0`, no attach, and no invitation in either full PTY capture. The base worktree can then be removed with `git worktree remove /tmp/borg-server-242-base`; its exact SHA remains the durable reconstruction anchor.

The committed harness does not claim that this control runs in CI. Its purpose is to preserve the exact operator acceptance and the guard-present mutation control as a repeatable, manually runnable gate for future association changes.
