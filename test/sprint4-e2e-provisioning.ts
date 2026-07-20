/**
 * Test-only provisioning support for the Sprint 4 joined E2E gate.
 *
 * This deliberately exercises the same operator CLI and HTTPS routes used by
 * a real installation. It is not shipped in the package and must only be
 * called by an explicit test-mode runner with a fresh disposable directory.
 */
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { mkdir, lstat, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import type { ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, dirname, join, resolve } from "node:path";

import { runCli, type CliIo } from "../src/cli.js";
import { loadDigestKey } from "../src/bootstrap.js";
import { CredentialAuthority, CredentialDigester, generateSecret } from "../src/credentials.js";
import { CoordinationApi } from "../src/coordination-api.js";
import { createEnrollmentExchange } from "../src/enrollment.js";
import { startHttpsServer, type RunningServer } from "../src/https-server.js";
import {
  acquireRuntimeLock,
  createOfflineCredentialService,
  setupNodeServerInstallation,
  type ServerService,
} from "../src/service.js";
import { openStore } from "../src/store.js";

export interface Sprint4ProvisioningInput {
  readonly testMode: true;
  /** A path which does not exist yet and is owned by this run. */
  readonly dataDirectory: string;
  /** A numeric loopback address only; host names and LAN addresses are refused. */
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  /** Test-only negative-path fixture; never enabled by the RQ joined run. */
  readonly includeReadOnlyRecipientForRegression?: boolean;
}

export interface Sprint4ProvisionedRun {
  readonly endpoint: string;
  readonly cubeId: string;
  readonly trustMaterialReference: string;
  readonly trustIdentity: string;
  readonly credentialReferences: Readonly<{
    reader: string;
    writerA: string;
    writerB: string;
  }>;
  readonly clientIds: Readonly<{
    reader: string;
    writerA: string;
    writerB: string;
  }>;
  readonly seats: Readonly<{
    reader: SeatIdentity;
    writerA: SeatIdentity;
    writerB: SeatIdentity;
  }>;
  readonly readOnlyRecipient?: SeatIdentity;
  /** Stops the owned listener and removes all created credentials and state. */
  readonly cleanup: () => Promise<void>;
}

interface Enrollment {
  readonly clientId: string;
  readonly credential: string;
}

interface SeatIdentity {
  readonly roleId: string;
  readonly droneId: string;
  readonly sessionId: string;
}

interface AttachedEnrollment extends Enrollment {
  readonly seat: SeatIdentity;
  readonly sessionCredential: string;
}

/** Every owned network operation must leave time for bounded teardown. */
export const SPRINT4_TRANSPORT_TIMEOUT_MS = 2_000;

/**
 * Provision a disposable, real server scenario for one joined client/server
 * execution. The caller must retain the returned object and always call
 * cleanup. No credentials are written to stdout or returned as strings.
 */
export async function provisionSprint4E2e(
  input: Sprint4ProvisioningInput,
): Promise<Sprint4ProvisionedRun> {
  assertProvisioningInput(input);
  // macOS exposes its temporary directory through /var, which is itself a
  // symlink. Canonicalise the existing parent before the setup path is made so
  // setup's deliberate symlink protections still apply to the owned child.
  const requestedDataDirectory = resolve(input.dataDirectory);
  const dataDirectory = join(await realpath(dirname(requestedDataDirectory)), basename(requestedDataDirectory));
  await assertFreshPath(dataDirectory);

  let runtime: Awaited<ReturnType<typeof openStore>> | undefined;
  let digester: CredentialDigester | undefined;
  let runtimeLock: Awaited<ReturnType<typeof acquireRuntimeLock>> | undefined;
  let server: RunningServer | undefined;
  let cleaned = false;

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    let failure: unknown;
    try {
      await closeSprint4Server(server);
    } catch (error) {
      failure = error;
    }
    try { runtime?.close(); } catch (error) { failure ??= error; }
    try { digester?.destroy(); } catch (error) { failure ??= error; }
    try { await runtimeLock?.release(); } catch (error) { failure ??= error; }
    try { await rm(dataDirectory, { recursive: true, force: true }); } catch (error) { failure ??= error; }
    if (failure !== undefined) throw failure;
  };

  try {
    const service = operatorService(dataDirectory, input.host);
    const setupOutput = await invokeCli(["setup"], service);
    const recovery = captureSecret(setupOutput, "Recovery credential (shown once; keep offline): ");
    const ownerInvitation = captureSecret(
      setupOutput,
      "Owner enrollment invitation (single-use, shown once; enroll the owner client): ",
    );

    const bootstrapPaths = {
      database: join(dataDirectory, "borg.db"),
      digestKey: join(dataDirectory, "credential-digest.key"),
      caCertificate: join(dataDirectory, "ca.crt"),
      serverKey: join(dataDirectory, "server.key"),
      serverCertificate: join(dataDirectory, "server.crt"),
    };
    runtime = await openStore({ path: bootstrapPaths.database });
    const digestKey = await loadDigestKey(bootstrapPaths.digestKey);
    digester = new CredentialDigester(digestKey);
    digestKey.fill(0);
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const coordination = new CoordinationApi(runtime, authority);
    runtimeLock = await acquireRuntimeLock(dataDirectory, "server");
    server = await startHttpsServer({
      bind: { host: input.host, port: input.port },
      tls: {
        key: await readFile(bootstrapPaths.serverKey),
        cert: await readFile(bootstrapPaths.serverCertificate),
      },
      exchangeEnrollment: createEnrollmentExchange(authority),
      authorizeCoordination: async (authorization) => authority.authenticateStatus(authorization),
      handleCoordination: (request) => coordination.handle(request),
    });
    const ca = await readFile(bootstrapPaths.caCertificate);
    const trustIdentity = canonicalTrustIdentity(ca);

    const owner = await enroll(server.origin, ca, ownerInvitation, "s4-owner");
    const cube = await postJson(server.origin, ca, "/api/cubes", {
      protocol_version: "2",
      request_id: randomUUID(),
      payload: { retry_key: randomUUID(), name: "Sprint 4 joined E2E", template: "default" },
    }, owner.credential);
    expectStatus(cube, 201, "create cube");
    const cubePayload = decodePayload<{
      cube_id: string;
      default_worker_role_id: string;
    }>(cube.body, "create cube");

    // The active reader receives directed coordination and therefore needs the
    // public write grant. It still performs the harness's log-drain duties.
    const enrolledReader = await enrollInvitation(service, recovery, cubePayload.cube_id, "write", server.origin, ca, "s4-reader");
    const enrolledWriterA = await enrollInvitation(service, recovery, cubePayload.cube_id, "write", server.origin, ca, "s4-writer-a");
    const enrolledWriterB = await enrollInvitation(service, recovery, cubePayload.cube_id, "write", server.origin, ca, "s4-writer-b");
    const reader = await attachIdentity(server.origin, ca, cubePayload.cube_id, cubePayload.default_worker_role_id, enrolledReader);
    const writerA = await attachIdentity(server.origin, ca, cubePayload.cube_id, cubePayload.default_worker_role_id, enrolledWriterA);
    const writerB = await attachIdentity(server.origin, ca, cubePayload.cube_id, cubePayload.default_worker_role_id, enrolledWriterB);
    const readOnlyRecipient = input.includeReadOnlyRecipientForRegression === true
      ? await attachIdentity(
          server.origin,
          ca,
          cubePayload.cube_id,
          cubePayload.default_worker_role_id,
          await enrollInvitation(service, recovery, cubePayload.cube_id, "read", server.origin, ca, "s4-read-only-recipient"),
        )
      : undefined;
    if (new Set([reader.clientId, writerA.clientId, writerB.clientId]).size !== 3) {
      throw new Error("Sprint 4 provisioning requires three distinct enrolled identities.");
    }
    if (new Set([reader.seat.droneId, writerA.seat.droneId, writerB.seat.droneId]).size !== 3) {
      throw new Error("Sprint 4 provisioning requires three distinct attached drone seats.");
    }
    const otherCube = await postJson(server.origin, ca, "/api/cubes", {
      protocol_version: "2",
      request_id: randomUUID(),
      payload: { retry_key: randomUUID(), name: "Sprint 4 scoped-access sentinel", template: "default" },
    }, owner.credential);
    expectStatus(otherCube, 201, "create scoped-access sentinel");
    const otherCubeId = decodePayload<{ cube_id: string }>(otherCube.body, "create scoped-access sentinel").cube_id;
    const crossCubeRead = await getSprint4Status(
      server.origin,
      ca,
      `/api/cubes/${otherCubeId}`,
      reader.credential,
    );
    if (crossCubeRead !== 404) {
      throw new Error("A cube-scoped reader must not access a second owner cube.");
    }

    const credentialDirectory = join(dataDirectory, "s4-e2e-credentials");
    await mkdir(credentialDirectory, { mode: 0o700 });
    const trustMaterialReference = bootstrapPaths.caCertificate;
    const credentialReferences = {
      reader: await writeCredentialReference(credentialDirectory, "reader.json", reader, server.origin, trustMaterialReference, trustIdentity, cubePayload.cube_id),
      writerA: await writeCredentialReference(credentialDirectory, "writer-a.json", writerA, server.origin, trustMaterialReference, trustIdentity, cubePayload.cube_id),
      writerB: await writeCredentialReference(credentialDirectory, "writer-b.json", writerB, server.origin, trustMaterialReference, trustIdentity, cubePayload.cube_id),
    };
    await Promise.all(Object.values(credentialReferences).map((reference) =>
      assertCredentialReferenceTrust(reference, trustIdentity)));

    return {
      endpoint: server.origin,
      cubeId: cubePayload.cube_id,
      trustMaterialReference,
      trustIdentity,
      credentialReferences,
      clientIds: { reader: reader.clientId, writerA: writerA.clientId, writerB: writerB.clientId },
      seats: { reader: reader.seat, writerA: writerA.seat, writerB: writerB.seat },
      ...(readOnlyRecipient === undefined ? {} : { readOnlyRecipient: readOnlyRecipient.seat }),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function operatorService(dataDirectory: string, host: "127.0.0.1" | "::1"): ServerService {
  return {
    start: async () => { throw new Error("The Sprint 4 harness starts its owned HTTPS server directly."); },
    setup: (options) => setupNodeServerInstallation(dataDirectory, host, options),
    ...createOfflineCredentialService(dataDirectory),
  };
}

async function enrollInvitation(
  service: ServerService,
  recovery: string,
  cubeId: string,
  access: "read" | "write",
  origin: string,
  ca: Buffer,
  clientName: string,
): Promise<Enrollment> {
  const output = await invokeCli(["client-invite", cubeId, "--access", access], service, recovery);
  const invitation = captureSecret(output, "Client enrollment invitation (single-use, shown once): ");
  return enroll(origin, ca, invitation, clientName);
}

async function enroll(origin: string, ca: Buffer, invitation: string, clientName: string): Promise<Enrollment> {
  const credential = generateSecret();
  const response = await postJson(origin, ca, "/api/enrollment/exchange", {
    protocol_version: "2",
    request_id: randomUUID(),
    payload: {
      invitation,
      retry_key: randomUUID(),
      client_credential: credential,
      client_name: clientName,
    },
  });
  expectStatus(response, 201, `enroll ${clientName}`);
  return { clientId: decodePayload<{ client_id: string }>(response.body, `enroll ${clientName}`).client_id, credential };
}

async function attachIdentity(
  origin: string,
  ca: Buffer,
  cubeId: string,
  roleId: string,
  enrollment: Enrollment,
): Promise<AttachedEnrollment> {
  const sessionCredential = generateSecret();
  const response = await postJson(origin, ca, "/api/client/attach", {
    protocol_version: "2",
    request_id: randomUUID(),
    payload: {
      cube_id: cubeId,
      role_id: roleId,
      session_credential: sessionCredential,
    },
  }, enrollment.credential);
  expectStatus(response, 201, "attach provisioned identity");
  const attached = decodePayload<{
    cube: { id: string };
    role: { id: string };
    drone: { id: string };
    session: { id: string };
  }>(response.body, "attach provisioned identity");
  if (attached.cube.id !== cubeId || attached.role.id !== roleId ||
      !isUuid(attached.drone.id) || !isUuid(attached.session.id)) {
    throw new Error("Provisioned seat identity did not match the requested cube and role.");
  }
  return {
    ...enrollment,
    sessionCredential,
    seat: { roleId, droneId: attached.drone.id, sessionId: attached.session.id },
  };
}

function assertProvisioningInput(input: Sprint4ProvisioningInput): void {
  if (input.testMode !== true) throw new Error("Sprint 4 provisioning requires explicit test mode.");
  if (input.host !== "127.0.0.1" && input.host !== "::1") {
    throw new Error("Sprint 4 provisioning requires a numeric loopback listener.");
  }
  if (!Number.isInteger(input.port) || input.port < 0 || input.port > 65_535) {
    throw new Error("Sprint 4 provisioning requires a numeric port from 0 to 65535.");
  }
}

async function assertFreshPath(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Sprint 4 provisioning refuses an existing data directory.");
}

async function invokeCli(args: readonly string[], service: ServerService, recovery?: string): Promise<string> {
  const output: string[] = [];
  const io: CliIo = {
    stdout: (message) => output.push(message),
    stderr: (message) => { throw new Error(`CLI failed without exposing its output: ${message}`); },
    ...(recovery === undefined ? {} : {
      readSecret: async (prompt: string) => {
        if (prompt !== "Recovery credential (hidden input): ") throw new Error("Unexpected secret prompt.");
        return recovery;
      },
    }),
  };
  const status = await runCli(args, service, io);
  if (status !== 0) throw new Error("Sprint 4 provisioning CLI operation failed.");
  return output.join("\n");
}

function captureSecret(output: string, label: string): string {
  const line = output.split("\n").find((candidate) => candidate.startsWith(label));
  if (line === undefined) throw new Error("Expected CLI secret output was missing.");
  const secret = line.slice(label.length);
  if (secret.length < 32) throw new Error("CLI secret output was invalid.");
  return secret;
}

async function writeCredentialReference(
  directory: string,
  name: string,
  enrollment: AttachedEnrollment,
  endpoint: string,
  trustMaterialReference: string,
  trustIdentity: string,
  cubeId: string,
): Promise<string> {
  assertTrustIdentityContract(trustIdentity, trustIdentity);
  const path = join(directory, name);
  await writeFile(path, JSON.stringify({
    endpoint,
    trust_material_reference: trustMaterialReference,
    trust_identity: trustIdentity,
    cube_id: cubeId,
    client_id: enrollment.clientId,
    client_credential: enrollment.credential,
    role_id: enrollment.seat.roleId,
    drone_id: enrollment.seat.droneId,
    session_id: enrollment.seat.sessionId,
    session_credential: enrollment.sessionCredential,
  }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (((await stat(path)).mode & 0o777) !== 0o600) {
    throw new Error("Sprint 4 credential references must be mode 0600.");
  }
  return path;
}

/** Test-only trust binding guard shared by emitted reader and writer references. */
export function assertTrustIdentityContract(expected: string, actual: unknown): void {
  if (!/^spki-sha256:[0-9a-f]{64}$/u.test(expected) || actual !== expected) {
    throw new Error("Sprint 4 credential reference trust identity mismatch.");
  }
}

async function assertCredentialReferenceTrust(path: string, expected: string): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8")) as { trust_identity?: unknown };
  assertTrustIdentityContract(expected, value.trust_identity);
}

// bootstrapServer writes the bare CA public-key (SPKI) SHA-256 to server.json.
// The client authority contract prefixes that same lowercase digest to make its
// algorithm explicit; the emitted identity is portable and never a path.
function canonicalTrustIdentity(certificate: Buffer): string {
  const ca = new X509Certificate(certificate);
  const fingerprint = createHash("sha256")
    .update(ca.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  return `spki-sha256:${fingerprint}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

async function postJson(
  origin: string,
  ca: Buffer,
  path: string,
  payload: unknown,
  credential?: string,
): Promise<{ readonly status: number; readonly body: string }> {
  const body = JSON.stringify(payload);
  const url = new URL(path, origin);
  return requestWithDeadline("HTTPS POST", (resolve, reject) => {
    const outgoing = httpsRequest({
      hostname: url.hostname,
      port: url.port,
      path,
      method: "POST",
      ca,
      agent: false,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      },
    }, (response) => {
      response.setEncoding("utf8");
      let responseBody = "";
      response.on("data", (chunk: string) => { responseBody += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: responseBody }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
    return outgoing;
  });
}

/** Test-only access to the provisioner's bounded POST transport. */
export async function postSprint4Json(
  origin: string,
  ca: Buffer,
  path: string,
  payload: unknown,
  credential?: string,
): Promise<{ readonly status: number; readonly body: string }> {
  return postJson(origin, ca, path, payload, credential);
}

/** Test-only hostile-transport probe used to prove the request deadline. */
export async function getSprint4Status(
  origin: string,
  ca: Buffer,
  path: string,
  credential: string,
): Promise<number> {
  const url = new URL(path, origin);
  return requestWithDeadline("HTTPS GET", (resolve, reject) => {
    const outgoing = httpsRequest({
      hostname: url.hostname,
      port: url.port,
      path,
      ca,
      agent: false,
      headers: { authorization: `Bearer ${credential}` },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.once("error", reject);
    outgoing.end();
    return outgoing;
  });
}

/** Test-only bounded wrapper around the server-owned close operation. */
export async function closeSprint4Server(server: RunningServer | undefined): Promise<void> {
  if (server === undefined) return;
  await withDeadline("HTTPS server close", () => server.close());
}

function requestWithDeadline<T>(
  operation: string,
  start: (
    resolve: (value: T) => void,
    reject: (reason: unknown) => void,
  ) => ClientRequest,
): Promise<T> {
  let outgoing: ClientRequest | undefined;
  return withDeadline(operation, () => new Promise<T>((resolve, reject) => {
    outgoing = start(resolve, reject);
  }), () => outgoing?.destroy());
}

function withDeadline<T>(
  operation: string,
  work: () => Promise<T>,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* Preserve the bounded timeout error. */ }
      fail(new Error(`Sprint 4 ${operation} timed out.`));
    }, SPRINT4_TRANSPORT_TIMEOUT_MS);
    timer.unref();
    work().then((value) => settle(resolve, value), fail);
  });
}

function expectStatus(response: { readonly status: number }, expected: number, operation: string): void {
  if (response.status !== expected) throw new Error(`Sprint 4 provisioning failed to ${operation}.`);
}

function decodePayload<T>(body: string, operation: string): T {
  try {
    const value = JSON.parse(body) as { payload?: T };
    if (value.payload === undefined) throw new Error();
    return value.payload;
  } catch {
    throw new Error(`Sprint 4 provisioning returned an invalid ${operation} response.`);
  }
}
