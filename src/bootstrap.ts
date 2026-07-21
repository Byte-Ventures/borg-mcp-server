import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { lstat, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generate } from "selfsigned";

import { CredentialAuthority, CredentialDigester, generateSecret } from "./credentials.js";
import type { PortableServerCredential } from "./portable-credential-store.js";
import { openStore } from "./store.js";

export interface BootstrapResult {
  readonly serverId: string;
  readonly caFingerprint: string;
  /** @deprecated Retained for offline administrative compatibility; never rendered by setup. */
  readonly recoveryCredential: string;
  /** @deprecated The already-consumed bootstrap invitation; never rendered by setup. */
  readonly initialInvitation: string;
  readonly ownerAccess: {
    readonly clientId: string;
    readonly serverCapabilities: readonly ["create_cube"];
  };
  readonly paths: {
    readonly database: string;
    readonly digestKey: string;
    readonly caKey: string;
    readonly caCertificate: string;
    readonly serverKey: string;
    readonly serverCertificate: string;
    readonly config: string;
  };
}

export async function bootstrapServer(
  dataDirectory: string,
  bindHost = "127.0.0.1",
  clock: () => Date = () => new Date(),
  persistOwnerCredential: (record: PortableServerCredential) => Promise<void> = async () => undefined,
): Promise<BootstrapResult> {
  const directory = resolve(dataDirectory);
  const paths = {
    database: join(directory, "borg.db"),
    digestKey: join(directory, "credential-digest.key"),
    caKey: join(directory, "ca.key"),
    caCertificate: join(directory, "ca.crt"),
    serverKey: join(directory, "server.key"),
    serverCertificate: join(directory, "server.crt"),
    config: join(directory, "server.json"),
  };
  const ca = await generate([{ name: "commonName", value: "Borg Local CA" }], {
    algorithm: "sha256",
    keyType: "ec",
    extensions: [
      { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    ],
  });
  const server = await generate([{ name: "commonName", value: "Borg Local Server" }], {
    algorithm: "sha256",
    keyType: "ec",
    ca: { key: ca.private, cert: ca.cert },
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, keyAgreement: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 7, ip: bindHost }] },
    ],
  });
  const serverId = randomUUID();
  const caCertificate = new X509Certificate(ca.cert);
  const caFingerprint = createHash("sha256")
    .update(caCertificate.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const digestKey = randomBytes(32);
  const runtime = await openStore({ path: paths.database, clock });
  let completed = false;
  try {
    await Promise.all([
      writePrivate(paths.digestKey, digestKey),
      writePrivate(paths.caKey, ca.private),
      writePrivate(paths.caCertificate, ca.cert),
      writePrivate(paths.serverKey, server.private),
      writePrivate(paths.serverCertificate, server.cert),
      writePrivate(paths.config, JSON.stringify({
        server_id: serverId,
        ca_spki_sha256: caFingerprint,
        bind_host: bindHost,
      }, null, 2)),
    ]);
    const digester = new CredentialDigester(digestKey);
    digestKey.fill(0);
    try {
      const authority = new CredentialAuthority(runtime.credentials, digester, clock);
      const recoveryCredential = authority.createRecoveryCredential();
      const invitation = authority.createBootstrapInvitation(15 * 60_000);
      const credential = generateSecret();
      const enrollment = authority.exchangeInvitation({
        invitation,
        retryKey: randomUUID(),
        clientCredential: credential,
        clientName: "Local owner",
      });
      if (enrollment?.purpose !== "owner" || enrollment.serverCapabilities[0] !== "create_cube") {
        throw new Error("Local owner provisioning failed.");
      }
      await persistOwnerCredential(Object.freeze({
        version: 2,
        origin: `https://${bindHost === "::1" ? "[::1]" : bindHost}:7091`,
        trustIdentity: `spki-sha256:${caFingerprint}`,
        credential,
        clientId: enrollment.clientId,
        serverCapabilities: ["create_cube"] as const,
      }));
      const result = {
        serverId,
        caFingerprint,
        recoveryCredential,
        initialInvitation: invitation,
        ownerAccess: {
          clientId: enrollment.clientId,
          serverCapabilities: ["create_cube"] as const,
        },
        paths,
      };
      completed = true;
      return result;
    } finally {
      digester.destroy();
    }
  } finally {
    digestKey.fill(0);
    runtime.close();
    if (!completed) {
      await Promise.all([
        ...Object.values(paths),
        `${paths.database}-wal`,
        `${paths.database}-shm`,
        `${paths.database}-journal`,
      ].map((path) => unlink(path).catch(() => undefined)));
    }
  }
}

async function writePrivate(path: string, value: string | Buffer): Promise<void> {
  await writeFile(path, value, { flag: "wx", mode: 0o600 });
  if (((await stat(path)).mode & 0o777) !== 0o600) {
    throw new Error("Bootstrap file permissions are not private.");
  }
}

export async function loadDigestKey(path: string): Promise<Buffer> {
  const key = await loadPrivateFile(path, "Credential digest key");
  if (key.length !== 32) {
    key.fill(0);
    throw new Error("Credential digest key is invalid or not private.");
  }
  return key;
}

export async function loadTlsPrivateKey(path: string): Promise<Buffer> {
  return loadPrivateFile(path, "TLS private key");
}

async function loadPrivateFile(path: string, label: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} is invalid or not private.`);
  }
  return readFile(path);
}
