# Release runbook

Each release requires separate exact-source review and human publication authorization.
The tag-triggered workflow in `.github/workflows/release.yml` supports the existing public npm
package, but committing or merging release preparation does not authorize a tag, protected
environment approval, package publication, or deployment.

## Hard blockers

Every item below must be complete before a release tag is authorized:

1. The server preview threat model in `docs/threat-model.md` passes for the exact release commit.
2. The final license is the unmodified canonical Functional Source License, Version 1.1,
   ALv2 Future License (`FSL-1.1-ALv2`) with the notice `Copyright 2026 Byte Ventures`.
   No Additional Permission, Additional Use Grant, or other addendum may be appended. The approval
   and exact-byte audit trail are included in the release evidence.
3. The exact approved text is committed as `LICENSE`, `package.json` uses
   `"license": "SEE LICENSE IN LICENSE"`, and the tag workflow compares the file with the reviewed
   SHA-256 `9535abd9881dc5af88523e24e0bed77df8dddd0f255bb74710533ac71140d2a1`.
4. The repository has completed public-boundary CR, SR, Release Quality, documentation,
   sensitivity, credential-history, dependency, and vulnerability review for the exact commit.
5. `README.md`, `CONTRIBUTING.md`, and `SECURITY.md` are complete for a standalone public repository.
6. `borgmcp-shared` is consumed from its audited public registry release, not a Git or SSH dependency.
7. All declared dependencies are exact registry versions, a publishable `npm-shrinkwrap.json` locks
   the complete build and consumer trees without non-registry sources, and the production tree has no
   install scripts. Source maps reference shipped files, and
   `node scripts/verify-packed-artifact.mjs <tarball>` accepts the exact package. NOTICE and
   third-party license disclosures must match that tree. Any useful SBOM or supplemental report is
   generated outside the publish-critical path and cannot change publication outcome.
8. The Coordinator has recorded a separate release authorization for the exact version, tag,
   and commit under the ratified `release-tag-coordinator-autonomy` decision after all prior gates.

The workflow binds the source-contained release boundaries directly:

- the remote annotated tag peels to the checked-out `GITHUB_SHA` and that commit is on protected
  `main`;
- the tag equals `v<package version>` and package identity is exactly `borgmcp-server`;
- the canonical FSL file, manifest license declaration, repository visibility, and required public
  documentation are exact; and
- the source lock and packed artifact verifiers preserve dependency, license, notice, entrypoint,
  lifecycle-script, and public-package boundaries.

External review and authorization are deliberately not reconstructed as repository variables or
cross-run tuples. They are prerequisites to tag creation and the protected environment's human
approval, and remain independently attributable in the cube record.

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
- The `npm-publish` environment allows only protected `v*.*.*` tags, has no admin bypass, and
  requires the designated Queen operator to approve the exact same-run artifact deployment.
- npm ownership is verified and Trusted Publishing is bound to this repository,
  `.github/workflows/release.yml`, and the `npm-publish` environment. Owned-package releases use
  tokenless OIDC; the environment contains only the reviewed `NPM_EXPECTED_OWNER` variable and no
  npm token. Bootstrap mode and long-lived credentials must never be restored for an owned package.

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
image, native installer, service unit, signing key, or update channel. Any hardened OCI or native
service artifacts must derive from the same audited npm tarball, pin base images by digest, carry
their own SBOM and signatures, and pass separate exact-artifact CR/SR/Release Quality gates before
any preview.

## Verification and artifact audit

1. Merge reviewed source to protected `main`, verify the merge commit and required CI checks, and
   obtain separate release authorization naming the immutable version, annotated tag, and commit.
2. Create the annotated tag once. Never move, reuse, force-update, or rerun a failed release tag.
3. The tag workflow verifies the remote annotated tag through an isolated ref, binds its peeled
   commit to `GITHUB_SHA`, requires that commit on protected `main`, and rejects repository npm
   configuration before running dependency code.
4. The unprivileged `verify` job is the one build, test, package, and artifact-verification authority.
   It verifies the source lock, installs with lifecycle scripts disabled, audits, runs the complete
   check/test/build gate, packs once, verifies once, and installs/imports/runs that exact server
   tarball once in clean consumer prefixes.
5. The verify job uploads only the same-run tarball and verifier report. The report contains the
   package identity, version, and canonical SHA-512 SRI; no checksum bundle, run tuple, rebuild,
   duplicate verification, or critical-path SBOM is needed.
6. The protected publish job downloads that same-run tarball and verifier report. Its read-only
   preflight rejects a wrong package or version, an existing immutable version, an unclaimed package,
   or ownership other than the sole reviewed `NPM_EXPECTED_OWNER`. It then publishes the tarball once
   through npm Trusted Publishing with provenance, lifecycle scripts disabled, and no long-lived npm
   token.
7. A separate read-only job performs one bounded registry integrity comparison with the verifier
   report, installs the exact registry version with lifecycle scripts disabled, and runs
   `npm audit signatures` to verify registry signatures and the Trusted Publishing attestation.
   A successful publish job remains recorded as successful if this later readback fails; such a
   failure is a release incident and never authorizes a rerun or second publication.
8. Useful SBOM or supplemental report generation may run separately, but cannot gate, invalidate, or
   make an otherwise authentic immutable publication ambiguous.
9. After successful registry verification, update the README and this runbook in a fresh reviewed
   documentation change so public release claims match the shipped package.
10. Stop immediately on any mismatch before publication. Preserve every run and tag as immutable
    evidence; recovery uses a newly reviewed source fix, a new version, and a newly authorized tag.

## Current audit state

The active local/self-hosted product spans the public
[`borg-mcp-client`](https://github.com/Byte-Ventures/borg-mcp-client),
[`borg-mcp-server`](https://github.com/Byte-Ventures/borg-mcp-server), and
[`borg-mcp-shared`](https://github.com/Byte-Ventures/borg-mcp-shared) repositories. This runbook
authorizes only the `borgmcp-server` npm artifact. Portable wire-contract changes are reviewed and
released from `borg-mcp-shared` first; server releases consume an exact audited registry version,
never a Git or SSH dependency. Client releases follow their own repository gates.

The server repository is public; visibility is complete, and `borgmcp-server@0.1.1`,
`borgmcp-server@0.1.4`, and `borgmcp-server@0.1.5` are live on npm under the sole expected maintainer.
The `latest` tag resolves to `0.1.5`. Versions `0.1.2` and `0.1.3` are unpublished immutable failure
evidence and must never be customer, install, or dogfood targets. Version `0.1.5` completed the full
exact-source, tagged-artifact, tokenless OIDC publication, registry verification, provenance,
signature, and attestation gate chain recorded below.

The immutable annotated `v0.1.1` tag object
`e3f6ee268d5cd4f1e88adabdc6171c1e732cd096` peels to protected-main commit
`f7f65ffb9af2853b0c4adb4bd9e2b0958db04e63`; it is the release-delta baseline and must never be
moved, deleted, or reused. Version `0.1.4` retains that audited baseline: purpose-bound
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
- PR #31 (`5508e8f`) prepared the unpublished `0.1.3` tokenless recovery identity and release evidence
  without changing runtime code; its failed publication exposed the missing effective OIDC path.
- PR #33 (`4fa7f2c`) removed long-lived npm credentials from the owned-package release path, added
  fail-closed live-publish OIDC guards, and introduced the protected-main non-publishing preflight.
- PR #34 (`9b16bd7`) added token-safe preflight diagnostics that exposed the npm Trusted Publisher
  binding failure and then the numeric expiry parsing defect.
- PR #35 (`fb6e66b`) validates npm's numeric Unix-seconds expiry response strictly and removes dynamic
  test code construction while retaining the redaction and failure-path coverage.

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
`ALLOW_UNCLAIMED_FIRST_PUBLISH=false`, with readback confirming zero retained secrets. The intended
npm Trusted Publisher identity was repository `Byte-Ventures/borg-mcp-server`, workflow
`release.yml`, and environment `npm-publish`. The complete source, tag, verify, exact-artifact
Security, checksum-binding, and Queen environment-approval chain then ran fresh, but publication
failed as described below because the package binding and effective exchange path were not yet
proven. Neither unpublished `0.1.2` nor unpublished `0.1.3` is a customer release or dogfood target;
their approvals and artifacts do not transfer to `0.1.4`.

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

The first protected-main preflight, workflow run `29573450568` attempt 1 at merge
`4fa7f2c1b5e59201b5886a59ff01b70972c5e601`, passed every event, ref, runtime, empty-token, and OIDC
request-variable guard. This proves GitHub now grants the effective `id-token: write` capability that
was absent from the failed `v0.1.3` job. The exchange probe then failed, but its generic catch hid the
specific assertion or HTTP failure, so the run cannot distinguish a branch-claim mismatch from npm
Trusted Publisher rejection. Never rerun that failed attempt. A fresh source-only diagnostic change
must report the error message and stack, both response statuses, and the npm response body with every
credential-bearing token, authorization, credential, and secret field recursively redacted. Non-JSON
bodies are omitted rather than echoed. No GitHub or npm setting may change until a fresh,
Queen-approved preflight provides that token-safe diagnostic evidence.

After the Queen re-established the npm Trusted Publisher binding, protected-main preflight run
`29574615810` attempt 1 proved the complete exchange path: GitHub returned 200 and npm returned 201
with `token_type` `oidc`, a redacted token, and numeric `created` and `expires` Unix timestamps in
seconds. The probe still failed because it passed the numeric `expires` value to `Date.parse`, which
expects a date string and returned `NaN`. This was a preflight-only false negative, not an expired
credential or Trusted Publisher failure. At that point, recovery remained blocked until reviewed
source validated a numeric safe-integer `expires` value directly against current Unix seconds,
rejected values beyond a one-hour maximum lifetime, and a fresh Queen-approved preflight completed
green. Never rerun that failed attempt; no package version or tag is selected by this correction.

Protected-main preflight run `29575906933` attempt 1 at merge
`fb6e66bcd21eb961a3bdb42af8e26171696411ab` completed green. GitHub's OIDC endpoint returned 200,
npm's Trusted Publisher exchange returned 201, and the response contained a valid short-lived token
with a strictly validated numeric Unix-seconds expiry. The dispatch ran in the protected
`npm-publish` environment from exactly `refs/heads/main` and published nothing. This proves the
repository, workflow, environment, runner, audience, and effective `id-token: write` path before a
new immutable tag is created.

The owned-package publish path is tokenless: no repository or environment `NPM_TOKEN` may exist, and
`ALLOW_UNCLAIMED_FIRST_PUBLISH` must remain `false`. Publication must use only the job's short-lived
OIDC exchange credential. The preflight never publishes, stages, stores, prints, or uploads either
token. A missing permission, retained long-lived token, claim mismatch, non-201 exchange, malformed
response, invalid expiry, or failed readback blocks the release; recovery always uses a new version
and never moves, deletes, reuses, or reruns a failed tag or tag-triggered workflow.

The immutable annotated `v0.1.5` tag object
`d5a7d0d3114397ff514ee4de1a886ba2379362f9` peels to protected-main merge
`4e0602a19de994205e7c97bd48f38302af895cd4`, whose tree is byte-identical to reviewed source
`28e010b079f6d73e25cefb8c45cdfcfcc21f65fd`. Workflow run `29699335144`, attempt 1, built and
published the exact audited 79-file artifact. npm reports integrity
`sha512-NVqwZRZ355wQdR4YAKA3Yj/BYI2LYbjXAf+EMZUkK1xWmZBXzdOWCADdsMPiEufvXwV+18rBR2BkraO2q1X5dQ==`
and `latest` resolves to `0.1.5`. The tokenless OIDC publication and postpublication checks verified
registry ownership, SLSA provenance, signatures, and attestations for this tag and commit.

The immutable annotated `v0.1.4` tag object
`1604077e6249c7c0f7ce17b3f2848caad2bc773e` peels to protected-main merge
`1f7e60a695f27d92b2d46233b0e3cad5aa43bd0d`, whose tree is byte-identical to reviewed source
`9f47c5669e0cd1c3d6cc6e78571daa639f5410ad`. Workflow run `29576759082`, attempt 1, built the exact
79-file audited artifact and completed all verify and publish steps. Its tarball SHA-512 is
`c0ad07ec30e1e7a94c7b9f1faf2b3cbcf252d00673a52fd9ee2bcfd04375c0adb383d21b8c883af4bbc10d9a6bbe4386a8fde52145dd6aaf33efc53061db2366`,
matching npm integrity
`sha512-wK0H7DDh56lMe58frys8vPJS0AZzpS/Z7ivP0EN1wK2zg9IbjIg69LvBDZprvkOGqP3lIUXdaq8z78UwYdsjZg==`.
The tokenless OIDC publication and postpublication checks verified registry integrity and ownership,
SLSA provenance bound to `refs/tags/v0.1.4` and the merge commit, and npm signatures and attestations.
Independent clean-room installation resolved the canonical registry tarball, reproduced its integrity,
and reported 71 packages with verified registry signatures and 35 with verified attestations, with
zero failures. Registry reads completed without a transient 404, confirming the bounded retry
envelope did not mask any terminal mismatch.

First-publication run `29495546749` built and published the exact audited artifact, but its publish job
concluded `failure` when the immediate postpublish ownership read returned HTTP 404 before registry
propagation completed. The run and tag remain immutable and must not be rerun, moved, or reused.

Future postpublish version reads retry only transient HTTP 404 propagation responses. The production
envelope performs at most 18 reads over approximately three and a half minutes (1, 2, 4, and 8 second
waits, then a 15 second cap). Every non-404 response proceeds directly to terminal status and exact
integrity verification. The following `npm audit signatures` readback verifies npm's registry
signatures and Trusted Publishing attestation instead of reconstructing provenance statements locally.

The immutable annotated `v0.1.0` tag object
`0f454997ced06802f0d3a0518c2e294af5a73b56` and first-attempt workflow run `29494436948`
are preserved as failed release evidence. The verify job failed closed before dependency installation
because its four required repository-level gate variables were unset; publish was skipped, zero
artifacts were produced, and `borgmcp-server` remained unclaimed in the npm registry. Never rerun,
move, delete, or reuse that tag. Recovery uses separately authorized version `0.1.1`, a fresh reviewed
source and merge commit, pre-tag repository-variable evidence, and a never-before-used annotated tag.

The live `borgmcp-server@0.1.5` package consumes the audited exact
`borgmcp-shared@0.4.0` registry release. Current source consumes the verified exact
`borgmcp-shared@0.4.2` registry release for the next server publication; the shrinkwrap must resolve
that registry tarball with the matching SRI. The source-lock, artifact, audit, signature, and consumer
gates must pass without Git dependencies before release review; SBOM generation is supplemental and
outside the publication-critical path.
