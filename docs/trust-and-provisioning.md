# Trust Artifacts and Separate-Machine Provisioning

This guide covers the server operator's side of connecting a client on another
machine. The server defaults to loopback. Do not expose it on a private LAN
unless the network is trusted and the client-side enrollment flow is available
in the installed `borg` client.

## Trust Artifacts

With the default `BORG_SERVER_DATA_DIR`, setup stores these files in
`~/.borg/server`:

| File | Purpose | Handling |
| --- | --- | --- |
| `ca.crt` | Public CA certificate used to validate the server certificate | Copy only through a trusted channel when a client explicitly requires the CA certificate. |
| `server.json` | Server identity metadata: `server_id`, `bind_host`, and `ca_spki_sha256` | Treat as local configuration; do not edit the CA fingerprint. |
| `server.crt` | TLS certificate presented by the server | Keep with the server installation. |
| `server.key` | TLS private key | Never copy to a client machine. Keep mode `0600`. |
| `ca.key` | CA private key used only to issue server certificates | Keep offline. Move it out of the runtime data directory before LAN startup. |
| `credential-digest.key` | Server-side credential verification key | Never copy or disclose it. |
| `borg.db` | Server state, clients, invitations, and cube grants | Keep private and back it up using encrypted storage. |

The client trust identity is the literal value
`spki-sha256:<64 lowercase hexadecimal characters>`. It is the SHA-256 digest
of the CA public-key SPKI, not the digest of `ca.crt` and not a password. The
same value is recorded as `ca_spki_sha256` in `server.json` and is included in
the enrollment artifact.

Never copy `ca.key`, `server.key`, `credential-digest.key`, `borg.db`, or the
owner credential to the client machine. Never place an invitation in a command
line, environment variable, issue, or chat transcript.

## Prepare A Private-LAN Server

Run setup on the server machine, then stop the foreground server before
certificate reissue or other offline identity operations:

```sh
borg-mcp-server setup
borg-mcp-server cert-reissue --host 192.168.1.20
```

The `--host` value must be the server's private-LAN IP address. The command
keeps the existing CA and reissues only `server.crt` and `server.key`, so the
CA fingerprint and already-issued trust identities remain stable. Move
`ca.key` to encrypted offline storage and confirm that it no longer exists in
the server data directory. Then start the server with explicit LAN consent:

```sh
borg-mcp-server start --host 192.168.1.20 --port 7091 --lan
```

The server must be reachable at the resulting HTTPS endpoint from the client
machine. A firewall may restrict access to the intended client network; `--lan`
is consent to bind a private address, not a firewall or authentication
substitute.

## Create A Client Enrollment

On the server machine, with the owner credential available and a private
interactive terminal, create a named, single-use invitation:

```sh
borg-mcp-server invite "Alice laptop"
```

The command displays the enrollment artifact once. It contains the server
endpoint, the CA SPKI fingerprint, the enrollment authority, and a short-lived
secret. Share the complete artifact only with the intended operator through a
trusted private channel. It expires after 15 minutes and grants no cube access
by itself; grant the enrolled client access with `client-grant` after enrollment.

The invitation endpoint is derived from the running server endpoint, or from
`bind_host` and port `7091` when the server is stopped. If the invitation says
`127.0.0.1` or `::1`, it is a same-machine invitation and cannot provision a
separate machine. Reissue the certificate, restart with the private-LAN host,
and mint a new invitation after the server is reachable on the LAN.

The receiving machine must use the enrollment command supported by its
installed `borg` client. Do not invent a URL, disable certificate verification,
or substitute the server private key. The client must verify both the HTTPS
certificate chain and the exact `spki-sha256` trust identity from the artifact
before sending the invitation.

## Grant Cube Access

After the client enrollment succeeds, list clients on the server and grant the
minimum required access to a specific cube:

```sh
borg-mcp-server client-list
borg-mcp-server client-grant <client-name-or-handle> <cube-id> read
```

Use `write` when the client must post coordination activity and `manage` only
when it must administer the cube. Enrollment does not grant access. Invitations,
credentials, and client administration output are secrets; keep them out of
logs and support reports.

## Recovery And Rotation

If a client invitation is lost or exposed, do not reuse it. Let it expire or
revoke the client after enrollment, then create a new invitation. If the CA key
is exposed, stop the server and treat the server identity as compromised;
reinitialize only after preserving any required encrypted backup and following
the recovery procedure for the installation.

If only the server's LAN address changes, keep `ca.key` available for the
offline operation, run `cert-reissue --host <new-private-ip>`, then move
`ca.key` back offline before restarting with `--lan`. Existing client trust
identities remain valid because the CA is preserved.
