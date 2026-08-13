# Releasing borgmcp-server

Releases are immutable npm packages built from annotated tags on protected `main`.

## Prepare

1. Choose the next version from the shipped change: patch for fixes, minor for backward-compatible functionality, major for breaking changes.
2. Add curated public notes at `docs/releases/<version>.md`.
3. From a clean branch based on current `main`, run:

   ```sh
   npm run release:prepare -- <version>
   npm run check
   npm audit --audit-level=high
   ```

4. Open a pull request. CI tests the Node floor and current Node, then audits, typechecks, builds, and verifies the package once.
5. Merge after review and green CI.

`release:prepare` updates package, lock, runtime, and test version literals. `verify:release-identity` checks those identities while allowing reviewed corrections made after preparation.

## Publish

1. Confirm the target version does not exist on npm and the tag does not exist.
2. Create and push the annotated `v<version>` tag on current protected `main`.
3. The tag workflow audits, typechecks, builds, packs, verifies, and exercises one tarball. A rerun before staging is allowed after infrastructure failure; never move or reuse a tag.
4. Approve the protected `npm-publish` environment only after the verification job succeeds.
5. Inspect and approve the npm stage. The stage publishes the exact verified tarball through Trusted Publishing with provenance.

Do not rebuild or retag a published version. A source defect requires a new version.

## GitHub Release

After npm reports the published version and integrity, create the GitHub Release from the annotated tag and curated tagged notes:

```sh
GITHUB_TOKEN="$(gh auth token)" node scripts/create-github-release.mjs <version>
```

The creator requires an annotated tag, non-empty `docs/releases/<version>.md` at the tagged commit, a live matching npm package with integrity, and no existing GitHub Release.
