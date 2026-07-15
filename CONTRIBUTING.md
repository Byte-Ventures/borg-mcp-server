# Contributing

Thank you for helping improve `borgmcp-server`.

## Before opening an issue

Search existing issues first. Use GitHub Issues for non-sensitive defects and
feature proposals. Do not include credentials, invitation tokens, private
keys, database contents, private network addresses, or other confidential
deployment details. Report suspected vulnerabilities through the private
process in [SECURITY.md](SECURITY.md).

## Development setup

Use Node.js 22.12 or later and install the locked dependency tree without
running dependency lifecycle scripts:

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run check
```

The check builds the package, type-checks it, and runs the test suite. Add or
update tests for behavioral changes. Security-sensitive changes should include
negative tests that demonstrate the rejected path as well as the accepted
path.

## Pull requests

- Keep each pull request focused on one coherent change.
- Explain the user impact, security impact, and verification performed.
- Preserve the loopback-first network policy and fail-closed release checks.
- Do not add install scripts, bundled dependencies, Git dependencies, or
  registry redirects.
- Do not commit generated credentials, local databases, `.npmrc` files, or
  release tarballs.
- Update standalone documentation when behavior or operating requirements
  change.

By contributing, you agree that your contribution may be distributed under
the repository's license.
