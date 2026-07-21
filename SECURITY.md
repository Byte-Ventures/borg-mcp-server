# Security policy

## Supported versions

Security fixes are provided for the latest release of `borgmcp-server`. Upgrade
to the newest published version before reporting a problem that may already be
resolved.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

https://github.com/Byte-Ventures/borg-mcp-server/security/advisories/new

Do not open a public issue for a suspected vulnerability. Include the affected
version, impact, prerequisites, and minimal reproduction steps. Remove all real
credentials, invitation tokens, private keys, database contents, and private
deployment details from the report.

We will acknowledge the report through the private advisory and coordinate
validation, remediation, and disclosure there. Please do not disclose the
issue publicly until a release or other mitigation is available and disclosure
has been coordinated.

## Deployment guidance

- Keep the default loopback binding unless private-LAN access is necessary.
- Treat `--lan` as explicit consent to network exposure, not as a firewall or
  access-control substitute.
- Keep the local CA private key offline whenever the server is running on a
  private LAN.
- Restrict the data directory and all generated credentials to the service
  account.
- Keep `~/.borg/credentials` owner-only (`0700`) and its credential files
  owner-only (`0600`); setup never prints the local owner credential.
- Create single-use invitations only in a private interactive terminal.
- Stop the server before offline credential rotation or revocation.
- Back up sensitive state using encrypted storage and test restoration in a
  separate environment.
- Review dependency and release provenance before upgrading.
- Use the verified runtime lifecycle rather than pointing a service at a mutable
  source checkout. Activation verifies npm integrity and the staged artifact
  tree, switches the `current` target atomically, and accepts a restarted process
  only when its authenticated runtime identity matches the selected artifact.
- Review generated launchd or systemd definitions before enabling them. They
  must retain the intended data directory and execute the immutable `current`
  artifact target.
