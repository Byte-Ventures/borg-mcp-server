# Release runbook

This repository does not currently have release authorization. The workflow in
`.github/workflows/release.yml` is preparation for a future public npm release;
committing or merging it does not authorize a tag, repository visibility change,
preview, package publication, or deployment.

## Hard blockers

Every item below must be complete before a release tag is authorized:

1. The server preview threat model in `docs/threat-model.md` passes the `#1016` gate for the exact
   release commit.
2. Counsel has approved the final FSL-1.1 license text and Additional Use Grant tracked by `#1026`.
3. The exact counsel-approved text is committed as `LICENSE`, `package.json` uses
   `"license": "SEE LICENSE IN LICENSE"`, and the license SHA-256 is recorded in
   `SERVER_FSL_COUNSEL_LICENSE_SHA256`.
4. The repository has completed public-boundary CR, SR, Release Quality, documentation,
   sensitivity, credential-history, dependency, and vulnerability review for the exact commit.
5. `README.md`, `CONTRIBUTING.md`, and `SECURITY.md` are complete for a standalone public repository.
6. `borgmcp-shared` is consumed from its audited public registry release, not a Git or SSH dependency.
7. Runtime dependencies are exact registry versions, a publishable `npm-shrinkwrap.json` locks the
   consumer tree without install scripts or non-registry sources, source maps reference shipped files,
   and `node scripts/verify-packed-artifact.mjs <tarball>` accepts the exact package.
8. The Coordinator has recorded a separate release authorization for the exact version, tag,
   and commit. The `client-server-release-lanes-autonomy` decision authorizes lane preparation only.

The verify job enforces these approvals by exact value rather than by presence:

- `SERVER_1016_APPROVED_SHA` equals the tagged commit.
- `SERVER_PUBLIC_REVIEW_APPROVED_SHA` equals the tagged commit.
- `SERVER_FSL_COUNSEL_LICENSE_SHA256` equals `sha256sum LICENSE`.
- `SERVER_RELEASE_AUTHORIZATION` equals `v<version>@<commit>`.

The repository must already be public and `package.json` must have a non-placeholder version,
`private: false`, the exact repository URL, and public npm publish metadata. These are outputs of
separately reviewed work, never edits performed by the release workflow.

## GitHub controls

Before any tag is authorized, the Coordinator configures and verifies:

- Actions allow only reviewed actions, require full commit SHA pinning, use read-only default
  workflow permissions, and cannot approve pull requests.
- Vulnerability alerts, Dependabot security updates, secret scanning, push protection, and code
  scanning are enabled where the repository plan supports them.
- `main` requires pull requests, CR and SR approvals, passing `CI / test`, resolved conversations,
  linear history, and no admin bypass.
- An active tag ruleset protects `refs/tags/v*.*.*` from update, deletion, and non-fast-forward;
  only the designated Queen operator may create a release tag.
- The `npm-publish` environment allows only `v*.*.*`, has no admin bypass, and requires the
  designated Queen operator to approve the exact artifact after SR.
- npm ownership is verified and Trusted Publishing is bound to this repository and
  `.github/workflows/release.yml`. A bootstrap `NPM_TOKEN`, if first-publication ownership requires
  one, exists only in the protected environment and is deleted immediately after ownership and OIDC
  publishing are verified.

Repository visibility must not be changed under this runbook. Visibility requires its own explicit
authorization after all public-boundary and license gates.

This workflow covers the npm service artifact only. It does not authorize or manufacture an OCI
image, native installer, service unit, signing key, or update channel. The hardened OCI and native
service artifacts required by the server architecture remain part of `#1016`: they must derive from
the same audited npm tarball, pin base images by digest, carry their own SBOM and signatures, and pass
separate exact-artifact CR/SR/Release Quality gates before any preview.

## Verification and artifact audit

1. Merge reviewed source to protected `main` and verify the merge commit and required CI checks.
2. Obtain separate authorization naming the immutable version, annotated tag, and exact commit.
3. Create the annotated tag once. Never move, reuse, force-update, or rerun a failed release tag.
4. The tag-push workflow verifies the remote annotated tag object through an isolated ref, binds its
   peeled commit to `GITHUB_SHA`, and requires that commit to be on `origin/main`.
5. Both jobs reject workflow reruns and repository npm configuration before bootstrapping exact npm
   from the official registry with isolated configuration. Before `npm ci` or any repository build
   tool runs, a builtins-only verifier binds every source-lock dependency to its exact official
   registry metadata. The unprivileged `verify` job then installs with scripts disabled, audits
   dependencies, runs all checks, creates one npm tarball, binds its lock
   entries to official registry metadata, verifies its allowlist and entrypoints, installs/imports/runs
   that exact tarball in clean consumer prefixes, generates a CycloneDX SBOM, records run evidence and
   SHA-512, performs an npm dry run, and uploads the exact files. It has no environment, publish token,
   or OIDC permission.
6. SR downloads and audits the workflow artifact itself, including the tarball, report, SBOM, and
   checksum. Source review or a locally rebuilt tarball cannot substitute for this gate.
7. After `SECURITY-APPROVED` names the exact SHA-512, the Coordinator sets the protected environment
   `ARTIFACT_SR_SHA512` to that value. The Queen operator separately reviews and approves the pending
   environment deployment.
8. The publish job downloads rather than rebuilds the artifact, checks SHA-512, re-runs artifact and
   registry ownership checks, and publishes that tarball with npm provenance.
9. The job verifies registry integrity, sole expected ownership, in-toto/SLSA provenance identity,
   Git commit, workflow/tag binding, and npm signatures/attestations.
10. Stop immediately on any mismatch. Preserve the run and tag as immutable evidence; recovery uses
    a newly reviewed source fix, a new version, and a newly authorized tag.

## Current audit state

The repository is public; visibility is complete and is no longer a release blocker. The protected
publish environment, required branch/tag rulesets, and scanning controls still require live
verification before a tag is authorized. Vulnerability alerts and automated security updates are
enabled. Actions are restricted to GitHub-owned actions with full-SHA pinning required; the workflow
token defaults to read-only and cannot approve pull requests. The repository does not yet contain the
final FSL license or standalone public documentation. `package.json` remains private at version
`0.0.0`, uses a Git+SSH development dependency, and has non-exact runtime dependency ranges. Those
remaining facts intentionally make release verification fail closed.
