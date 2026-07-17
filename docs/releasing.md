# Release runbook

Each release requires separate exact-source and exact-artifact authorization.
The workflow in `.github/workflows/release.yml` supports the existing public npm
package, but committing or merging release preparation does not authorize a tag,
package publication, or deployment.

## Hard blockers

Every item below must be complete before a release tag is authorized:

1. The server preview threat model in `docs/threat-model.md` passes the `#1016` gate for the exact
   release commit.
2. The final license is the unmodified canonical Functional Source License, Version 1.1,
   ALv2 Future License (`FSL-1.1-ALv2`) with the notice `Copyright 2026 Byte Ventures`.
   No Additional Permission, Additional Use Grant, or other addendum may be appended. The approval
   and exact-byte audit trail is tracked by `#1026`.
3. The exact approved text is committed as `LICENSE`, `package.json` uses
   `"license": "SEE LICENSE IN LICENSE"`, and the license SHA-256 is recorded in
   `SERVER_FSL_COUNSEL_LICENSE_SHA256`.
4. The repository has completed public-boundary CR, SR, Release Quality, documentation,
   sensitivity, credential-history, dependency, and vulnerability review for the exact commit.
5. `README.md`, `CONTRIBUTING.md`, and `SECURITY.md` are complete for a standalone public repository.
6. `borgmcp-shared` is consumed from its audited public registry release, not a Git or SSH dependency.
7. All declared dependencies are exact registry versions, a publishable `npm-shrinkwrap.json` locks
   the complete build and consumer trees without non-registry sources, and the production tree has no
   install scripts. Source maps reference shipped files, and
   `node scripts/verify-packed-artifact.mjs <tarball>` accepts the exact package. NOTICE, third-party
   license disclosures, and the normalized, fail-closed-verified CycloneDX SBOM must match that tree.
8. After any tokenless authentication-path change or failed OIDC release, a Queen-approved,
   first-attempt preflight from protected `main` has completed the GitHub-to-npm exchange without
   publishing, staging, printing, storing, or uploading either token.
9. The Coordinator has recorded a separate release authorization for the exact version, tag,
   and commit under the ratified `release-tag-coordinator-autonomy` decision after all prior gates.

The verify job enforces these approvals by exact value rather than by presence:

- `SERVER_1016_APPROVED_SHA` equals the tagged commit.
- `SERVER_PUBLIC_REVIEW_APPROVED_SHA` equals the tagged commit.
- `SERVER_FSL_COUNSEL_LICENSE_SHA256` equals `sha256sum LICENSE`.
- `SERVER_RELEASE_AUTHORIZATION` equals `v<version>@<commit>`.

The repository must already be public and `package.json` must have the separately approved version,
`private: false`, the exact repository URL, and public npm publish metadata. These are outputs of
separately reviewed work, never edits performed by the release workflow.

## GitHub controls

Before any tag is authorized, the Coordinator configures and verifies:

- Actions allow only reviewed actions, require full commit SHA pinning, use read-only default
  workflow permissions, and cannot approve pull requests.
- Vulnerability alerts, Dependabot security updates, secret scanning, push protection, and code
  scanning are enabled where the repository plan supports them.
- `main` requires pull requests, resolved conversations, the strict current `test` status check, and
  has no bypass actors; deletion and non-fast-forward updates are blocked. Merge commits are allowed.
  The GitHub approval count is deliberately zero because there is one trusted repository operator;
  independent CR, Security, and Release Quality approvals are enforced as cube exact-SHA release
  gates rather than GitHub review approvals, avoiding a sole-operator deadlock.
- An active tag ruleset protects `refs/tags/v*.*.*` from update, deletion, and non-fast-forward;
  only the designated release operator may create a tag after exact authorization by the Coordinator.
- The `npm-publish` environment allows protected `main` for the dispatch-only OIDC preflight and
  `v*.*.*` for publication, has no admin bypass, and requires the designated Queen operator to
  approve both preflight and exact-artifact deployments.
- npm ownership is verified and Trusted Publishing is bound to this repository,
  `.github/workflows/release.yml`, and the `npm-publish` environment. Owned-package releases use
  tokenless OIDC: `ALLOW_UNCLAIMED_FIRST_PUBLISH` must be `false` and the environment must contain no
  `NPM_TOKEN`. Bootstrap mode and its token were first-publication-only exceptions and must never be
  restored for an owned package.

Repository visibility must not be changed under this runbook. Visibility requires its own explicit
authorization after all public-boundary and license gates.

The tag workflow's read-only token cannot read repository-administration controls. Immediately before
authorizing a tag, an authorized operator must run the fail-closed live guard with an
administration-capable token:

```sh
GITHUB_TOKEN="$(gh auth token)" node scripts/verify-main-ruleset.mjs
```

The tag authorization record must name the reviewed verifier commit and include its fresh JSON result.
Any authentication, API, ruleset-ID, scope, enforcement, pull-request, status-check, merge-method,
history-protection, or bypass mismatch blocks authorization; never skip or substitute a manual check.

This workflow covers the npm service artifact only. It does not authorize or manufacture an OCI
image, native installer, service unit, signing key, or update channel. The hardened OCI and native
service artifacts required by the server architecture remain part of `#1016`: they must derive from
the same audited npm tarball, pin base images by digest, carry their own SBOM and signatures, and pass
separate exact-artifact CR/SR/Release Quality gates before any preview.

## Verification and artifact audit

1. Merge reviewed source to protected `main` and verify the merge commit and required CI checks.
2. After any tokenless authentication-path change or failed OIDC release, run the dispatch-only
   preflight from exactly `refs/heads/main` in the Queen-approved `npm-publish` environment and require
   an accepted, short-lived npm exchange token before selecting or preparing a recovery version.
3. Obtain separate authorization naming the immutable version, annotated tag, and exact commit.
4. Create the annotated tag once. Never move, reuse, force-update, or rerun a failed release tag.
5. The tag-push workflow verifies the remote annotated tag object through an isolated ref, binds its
   peeled commit to `GITHUB_SHA`, and requires that commit to be on `origin/main`.
6. Both jobs reject workflow reruns and repository npm configuration before bootstrapping exact npm
   from the official registry with isolated configuration. Before `npm ci` or any repository build
   tool runs, a builtins-only verifier binds every source-lock dependency to its exact official
   registry metadata. The unprivileged `verify` job then installs with scripts disabled, audits
   dependencies, runs all checks, creates one npm tarball, binds its lock
   entries to official registry metadata, verifies its allowlist and entrypoints, installs/imports/runs
   that exact tarball in clean consumer prefixes, normalizes npm's checkout-derived SBOM root name,
   verifies the CycloneDX root identity, lock-bound components, hashes, distribution URLs, and complete
   dependency graph, records run evidence and SHA-512, performs an npm dry run, and uploads only the
   verified SBOM and exact files. It has no environment, publish token, or OIDC permission.
7. SR downloads and audits the workflow artifact itself, including the tarball, report, SBOM, and
   checksum. Source review or a locally rebuilt tarball cannot substitute for this gate.
8. After `SECURITY-APPROVED` names the exact SHA-512, the Coordinator sets the protected environment
   `ARTIFACT_SR_SHA512` to that value. The Queen operator separately reviews and approves the pending
   environment deployment.
9. The publish job downloads rather than rebuilds the artifact, checks SHA-512, re-runs artifact and
   registry ownership checks, requires GitHub to expose both OIDC request variables, rejects any
   retained `NODE_AUTH_TOKEN`, and publishes that tarball with tokenless npm OIDC and provenance.
10. The job verifies registry integrity, sole expected ownership, in-toto/SLSA provenance identity,
   Git commit, workflow/tag binding, and npm signatures/attestations.
11. Stop immediately on any mismatch. Preserve the run and tag as immutable evidence; recovery uses
    a newly reviewed source fix, a new version, and a newly authorized tag.

## Current audit state

The repository is public; visibility is complete, and `borgmcp-server@0.1.1` is live on npm under the
sole expected maintainer. Versions `0.1.2` and `0.1.3` are unpublished immutable failure evidence and
must never be customer, install, or dogfood targets. Before any recovery version is selected or
prepared, the source-only OIDC fix must pass exact-SHA Code Review, Security, and Release Quality,
merge to protected `main`, and complete a first-attempt `workflow_dispatch` preflight from exactly
`refs/heads/main`. The Queen-approved preflight must run in the `npm-publish` environment and prove
that GitHub exposes the OIDC request capability and npm accepts the repository, workflow, environment,
runner, and audience claims by returning a valid short-lived exchange token. The preflight never
publishes, stages, stores, prints, or uploads either token. A missing permission, claim mismatch,
non-201 exchange, malformed response, or expired token blocks recovery before another tag is created.

The immutable annotated `v0.1.1` tag object
`e3f6ee268d5cd4f1e88adabdc6171c1e732cd096` peels to protected-main commit
`f7f65ffb9af2853b0c4adb4bd9e2b0958db04e63`; it is the release-delta baseline and must never be
moved, deleted, or reused. The failed `0.1.3` candidate retained that audited baseline: purpose-bound
owner enrollment, idempotent multi-cube creation, the client attach lifecycle, and stable prior-seat
reattachment. The protected-main changes after `v0.1.1` are exactly these reviewed merges:

- PR #17 (`73b31bd`) adds the bounded retry envelope for transient postpublication registry 404s.
- PR #14 (`031ae96`) records the completed `0.1.1` publication state without changing runtime code.
- PR #12 (`b1eefb7`) adds server #8 group 1 slice 1: manage-scoped worker-role creation and atomic
  default-role transition.
- PR #19 (`c86d7af`) makes repeated setup fail closed, adds explicit destructive
  `setup --reinitialize`, and aligns the canonical owner-enrollment transcript and terminology.
- PR #21 (`9a13f22`) adds server #8 group 1 slice 2: sparse role updates, atomic default promotion,
  and granular role-playbook section patches. Role deletion and later server #8 groups are not part
  of this release.
- PR #25 (`c18ec95`) adds explicit per-run, centrally redacted operator debug logging to local stderr.
- PR #27 (`570f37c`) permits live-safe local client and pre-claim owner invitation minting while
  preserving exclusive setup, rotation, revocation, and grant administration.
- PR #29 (`01d72d9`) adds cube-scoped invitations with exact selector resolution, atomic
  enroll-and-grant, and grant-derived observer/participant posture across attach, recipient, log, and
  stream enforcement.
- PR #30 (`33ef975`) prepared the unpublished `0.1.2` package identity and release evidence without
  changing runtime code; its failed publication led to the burned `0.1.3` recovery described below.

The immutable annotated `v0.1.2` tag object
`3886005f444a78acb6a63a8b769f494f134d25c5` peels to protected-main commit
`33ef975ae5f1f4c4149b8e46b8a30764f51d63d2`. Workflow run `29544456658`, attempt 1, verified that
source and built the exact audited artifact, but the publish job failed closed before publication at
`Verify registry ownership and version availability`. Its environment still had first-publication
bootstrap posture (`ALLOW_UNCLAIMED_FIRST_PUBLISH=true` and `NPM_TOKEN_PRESENT=true`) even though
`borgmcp-server@0.1.1` made the package owned. The guard rejected that state with
`Owned package publishing requires OIDC and rejects bootstrap mode/token retention.` The publish,
postpublish registry, provenance, signature, and attestation steps were skipped; npm continued to
report only `0.1.1`. Run, tag, artifact approval, and environment approval are immutable failed
evidence: never rerun, move, delete, reuse, or transfer any of them to `0.1.3`.

Recovery for `0.1.3` removed the environment `NPM_TOKEN` and set
`ALLOW_UNCLAIMED_FIRST_PUBLISH=false`, with readback confirming zero retained secrets. The Queen
operator confirmed npm Trusted Publishing for repository `Byte-Ventures/borg-mcp-server`, workflow
`release.yml`, and environment `npm-publish`. The complete source, tag, verify, exact-artifact
Security, checksum-binding, and Queen environment-approval chain then ran fresh, but publication
failed as described below. Sprint 7's published-version recovery rehearsal remains blocked until a
future registry-verified recovery version is separately selected after the OIDC preflight succeeds;
neither unpublished `0.1.2` nor unpublished `0.1.3` is a customer release or dogfood target.

The immutable annotated `v0.1.3` tag object
`84d5253eba551375eb6f2c064f8322686795f950` peels to protected-main commit
`5508e8f3d0c5ee97db2e4536c8bfe658082008be`. Workflow run `29570177034`, attempt 1, built and passed
Security review for the exact artifact, but publication failed closed with `ENEEDAUTH` before any
registry write. The publish job's effective permission report contained only `Contents: read` and
`Metadata: read`, despite the workflow declaring `id-token: write`; GitHub therefore did not expose
the OIDC request capability needed by npm. The job's tokenless state was correct, npm never received
an exchange credential, postpublication verification was skipped, and the registry remained at
`0.1.1`. Never rerun, move, delete, reuse, or transfer this tag, run, artifact approval, checksum
binding, or environment approval. The source-only recovery first adds a protected-main, dispatch-only
exchange preflight and fail-closed live-publish OIDC guards; it does not select the next version.

First-publication run `29495546749` built and published the exact audited artifact, but its publish job
concluded `failure` when the immediate postpublish ownership read returned HTTP 404 before registry
propagation completed. The run and tag remain immutable and must not be rerun, moved, or reused.

Future postpublish version, ownership, and provenance reads retry only transient HTTP 404 propagation
responses. The production envelope performs at most 18 reads over approximately three and a half
minutes (1, 2, 4, and 8 second waits, then a 15 second cap). Every non-404 response proceeds directly
to the existing terminal status or content verification; integrity, owner, provenance, workflow, tag,
commit, and builder mismatches remain immediate failures.

The immutable annotated `v0.1.0` tag object
`0f454997ced06802f0d3a0518c2e294af5a73b56` and first-attempt workflow run `29494436948`
are preserved as failed release evidence. The verify job failed closed before dependency installation
because its four required repository-level gate variables were unset; publish was skipped, zero
artifacts were produced, and `borgmcp-server` remained unclaimed in the npm registry. Never rerun,
move, delete, or reuse that tag. Recovery uses separately authorized version `0.1.1`, a fresh reviewed
source and merge commit, pre-tag repository-variable evidence, and a never-before-used annotated tag.

The published package consumes the audited exact `borgmcp-shared@0.3.0` registry release. Its
shrinkwrap must retain the canonical registry tarball URL and matching SRI, and the source-lock,
artifact, audit, signature, SBOM, and consumer gates must pass without Git dependencies before
release review.
