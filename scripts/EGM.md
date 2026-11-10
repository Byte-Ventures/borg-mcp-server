# scripts

## Overview

Release tooling for the `borgmcp-server` npm package. These Node ES module scripts change version literals, verify lockfiles and the packed tarball, smoke-test the tarball as a consumer, check registry state before and after publish, and create the GitHub Release. They are not part of the shipped package: `verify-packed-artifact.mjs` only allows `dist`, `docs`, `src`, and the root legal and manifest files in the tarball. Each `.d.mts` file declares the types of the `.mjs` script with the same name.

Callers: the npm scripts in `package.json`, and the workflows `.github/workflows/ci.yml`, `release.yml`, and `release-identity.yml`.

## Interface

### Release identity (`release-identity.mjs`, `release-identity-allowlist.json`)

- `node scripts/release-identity.mjs prepare <x.y.z>` (npm `release:prepare`) calls `prepareRelease(root, targetVersion)`. It writes the new version into `package.json`, `npm-shrinkwrap.json` (`.version` and `.packages[""].version`), the single `SERVER_PACKAGE_VERSION` literal in `src/runtime-identity.ts`, and every file in the allowlist `versionPins` [release-identity.mjs:prepareRelease].
- `node scripts/release-identity.mjs verify --base <ref> --candidate <ref>` (npm `verify:release-identity`) calls `verifyReleaseIdentity(root, base, candidate)` [release-identity.mjs:verifyReleaseIdentity].
- `node scripts/release-identity.mjs classify --base --candidate --repository --head-repository --head-ref` (called by `release-identity.yml`) calls `classifyReleasePullRequest(root, input)` [release-identity.mjs:classifyReleasePullRequest].
- `release-identity-allowlist.json` lists the `versionPins` test files that contain the version literal. `decodePins` reads it [release-identity.mjs:decodePins].

### Lockfile verification (`verify-lock-registry.mjs`, `verify-source-lock.mjs`)

- `verifyLockfile(manifest, lockfile, options)` and `isExactVersion(value)` are library functions with no CLI. `verify-packed-artifact.mjs` imports both. `verify-source-lock.mjs` imports only `verifyLockfile` [verify-lock-registry.mjs:verifyLockfile].
- `node scripts/verify-source-lock.mjs` (called by `release.yml`) calls `verifySourceLocks(root = ".")` on `package-lock.json` and/or `npm-shrinkwrap.json` [verify-source-lock.mjs:verifySourceLocks].

### Packed artifact (`verify-packed-artifact.mjs`, `exercise-packed-artifact.mjs`)

- `node scripts/verify-packed-artifact.mjs <package.tgz>` (npm `verify:artifact`, `ci.yml`, `release.yml`) calls `verifyPackedArtifact(tarballPath)` and prints a JSON report `{name, version, fileCount, packedBytes, unpackedBytes, integrity}` [verify-packed-artifact.mjs:verifyPackedArtifact].
- `node scripts/exercise-packed-artifact.mjs <package.tgz>` (called by `release.yml`) calls `exercisePackedArtifact(tarballPath)`. It installs the tarball locally and globally, runs an import probe, runs `borg-mcp-server --help`, and runs `npm ls` [exercise-packed-artifact.mjs:exercisePackedArtifact].

### Registry and GitHub release (`verify-registry-release.mjs`, `create-github-release.mjs`)

- `node scripts/verify-registry-release.mjs <prepublish|postpublish> <artifact-report.json>` reads the environment variables `EXPECTED_VERSION` and `NPM_EXPECTED_OWNER`. `NPM_EXPECTED_OWNER` is read for prepublish only. `release.yml` calls the `prepublish` mode. The script exports `verifyArtifactReport`, `verifyOwner`, `verifyPrepublish`, `verifyPostpublish`, and `readWithPropagationRetry` [verify-registry-release.mjs].
- `node scripts/create-github-release.mjs <version>` reads the environment variable `GITHUB_TOKEN`. It exports `createGithubRelease(version, options)` and `assembleReleaseBody(...)`. No workflow calls this script [create-github-release.mjs:createGithubRelease].

## Invariants

- Release versions use stable `X.Y.Z` format. Tags are annotated `v<version>` tags with a non-empty message [create-github-release.mjs:createGithubRelease; release-identity.mjs].
- `prepare` refuses to run in these cases: the target version is not a stable `x.y.z`, the working tree is not clean (`git status --porcelain` is not empty), the `package.json` name is not `borgmcp-server`, the target version is not newer than the current one, the shrinkwrap root identity does not match the current version, the current `SERVER_PACKAGE_VERSION` literal does not occur exactly once in `src/runtime-identity.ts`, or a pin file does not contain the current version [release-identity.mjs:prepareRelease].
- `verify` requires all of these: the base and candidate `package.json` names are `borgmcp-server`, the candidate version is newer than the base version, the candidate shrinkwrap names and versions agree, the runtime constant carries the new version, and every pin file contains the new version and no longer contains the old one [release-identity.mjs:verifyReleaseIdentity].
- `classify` accepts only the repository `Byte-Ventures/borg-mcp-server`, a head repository that is the same repository, and a head ref that starts with `release/` [release-identity.mjs:classifyReleasePullRequest].
- Lockfile rules: `lockfileVersion` must be 3. Every dependency must have an exact version. Every `resolved` URL must be `https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz`. Integrity must be a strict 64-byte sha512. `link` entries are not allowed, and duplicate entries must not diverge. `hasInstallScript` is rejected when `rejectInstallScripts` applies [verify-lock-registry.mjs:verifyLockfile].
- Tarball limits: packed size at most 2 MiB, unpacked size at most 8 MiB, at most 512 files, and each file at most 1 MiB. Entries must be regular files or directories under `package/`, with no `.`/`..` segments and no symlinks. Root entries must be in `ALLOWED_ROOTS`. Secret-shaped content (`FORBIDDEN_CONTENT`) and install hooks (`FORBIDDEN_HOOKS`) are rejected. A repo-local `.npmrc` is forbidden. Manifest fields (`bin`, `exports`, `engines`, `files`, `publishConfig`) must equal the reviewed values [verify-packed-artifact.mjs:verifyPackedArtifact].
- The rows in `THIRD_PARTY_NOTICES.md` must match the production packages in the shrinkwrap [verify-packed-artifact.mjs:verifyThirdPartyNotices].
- Source maps must be v3, must not contain `sourcesContent`, and must resolve only to shipped files [verify-packed-artifact.mjs:verifyPackedArtifact].
- Prepublish: the version must not exist in the registry (versions are immutable), and the package must already exist with exactly one maintainer, `byteventures` [verify-registry-release.mjs:verifyPrepublish, verifyOwner].
- Postpublish: the registry `dist.integrity` must equal the integrity in the report. The script reads the registry at most 18 times while it returns 404 (at most 17 retries), with exponential backoff from 1 s, capped at 15 s [verify-registry-release.mjs:verifyPostpublish, readWithPropagationRetry].
- Before `create-github-release.mjs` creates a release, all of these must be true: `docs/releases/<version>.md` exists at the tagged commit, the version is published to the registry, and no GitHub release exists yet for the tag [create-github-release.mjs:createGithubRelease].

## Side Effects

- `prepare` rewrites `package.json`, `npm-shrinkwrap.json`, `src/runtime-identity.ts`, and the `versionPins` files in the working tree [release-identity.mjs:prepareRelease].
- These git commands only read: `git status`, `git show <ref>:<path>`, `git cat-file`, `git rev-parse`, `git for-each-ref` [release-identity.mjs:git; create-github-release.mjs:git].
- `verify-packed-artifact.mjs` runs `tar -tzf`, `tar -tvzf`, and `tar -xzf` into the temporary directory `os.tmpdir()/borgmcp-server-pack-*`, then removes it [verify-packed-artifact.mjs:verifyPackedArtifact].
- `exercise-packed-artifact.mjs` runs `npm install` with `--ignore-scripts` (local and `--global --prefix`) against `https://registry.npmjs.org`, then `npm ls` and the installed `borg-mcp-server --help`. It works in the temporary directory `os.tmpdir()/borgmcp-server-consumer-*` [exercise-packed-artifact.mjs:exercisePackedArtifact].
- Network calls:
  - `GET https://registry.npmjs.org/borgmcp-server[/<version>]` [verify-registry-release.mjs; create-github-release.mjs:registryPackage].
  - `GET https://api.github.com/repos/Byte-Ventures/borg-mcp-server/releases/tags/v<version>` (existence check) and `POST https://api.github.com/repos/Byte-Ventures/borg-mcp-server/releases`, both with a Bearer `GITHUB_TOKEN`. The `POST` creates a public release with `make_latest: "true"`, named with the annotated tag message [create-github-release.mjs:createGithubRelease].
- `verify-source-lock.mjs` and `verify-lock-registry.mjs` only read files. They make no writes, network calls, or subprocess calls.

## Verification

- Run: `npm test` (the `pretest` hook builds first). These test files cover the scripts: `test/release-identity.test.ts`, `test/release-lock.test.ts`, `test/release-artifact.test.ts`, `test/release-provenance.test.ts`, `test/release-workflow.test.ts`, and `test/create-github-release.test.ts`.
- Run: `npm run typecheck`.
- Run the packing checks (`node scripts/verify-source-lock.mjs`, `verify-packed-artifact.mjs`, `exercise-packed-artifact.mjs`) only when you are explicitly preparing an artifact. See `AGENTS.md` and `docs/releasing.md`.
