/**
 * Test-only provisioning support for the Sprint 4 joined E2E gate.
 *
 * This deliberately exercises the same operator CLI and HTTPS routes used by
 * a real installation. It is not shipped in the package and must only be
 * called by an explicit test-mode runner with a fresh disposable directory.
 */
import { randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
}

export interface Sprint4ProvisionedRun {
  readonly endpoint: string;
  readonly cubeId: string;
  readonly trustMaterialReference: string;
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
  /** Stops the owned listener and removes all created credentials and state. */
  readonly cleanup: () => Promise<void>;
}

interface Enrollment {
  readonly clientId: string;
  readonly credential: string;
}

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
    await server?.close();
    runtime?.close();
    digester?.destroy();
    await runtimeLock?.release();
    await rm(dataDirectory, { recursive: true, force: true });
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

    const owner = await enroll(server.origin, ca, ownerInvitation, "s4-owner");
    const cube = await postJson(server.origin, ca, "/api/cubes", {
      protocol_version: "2",
      request_id: randomUUID(),
      payload: { retry_key: randomUUID(), name: "Sprint 4 joined E2E", template: "default" },
    }, owner.credential);
    expectStatus(cube, 201, "create cube");
    const cubePayload = decodePayload<{ cube_id: string }>(cube.body, "create cube");

    const reader = await enrollInvitation(service, recovery, cubePayload.cube_id, "read", server.origin, ca, "s4-reader");
    const writerA = await enrollInvitation(service, recovery, cubePayload.cube_id, "write", server.origin, ca, "s4-writer-a");
    const writerB = await enrollInvitation(service, recovery, cubePayload.cube_id, "write", server.origin, ca, "s4-writer-b");
    if (new Set([reader.clientId, writerA.clientId, writerB.clientId]).size !== 3) {
      throw new Error("Sprint 4 provisioning requires three distinct enrolled identities.");
    }
    const otherCube = await postJson(server.origin, ca, "/api/cubes", {
      protocol_version: "2",
      request_id: randomUUID(),
      payload: { retry_key: randomUUID(), name: "Sprint 4 scoped-access sentinel", template: "default" },
    }, owner.credential);
    expectStatus(otherCube, 201, "create scoped-access sentinel");
    const otherCubeId = decodePayload<{ cube_id: string }>(otherCube.body, "create scoped-access sentinel").cube_id;
    const crossCubeRead = await getStatus(
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
      reader: await writeCredentialReference(credentialDirectory, "reader.json", reader, server.origin, trustMaterialReference, cubePayload.cube_id),
      writerA: await writeCredentialReference(credentialDirectory, "writer-a.json", writerA, server.origin, trustMaterialReference, cubePayload.cube_id),
      writerB: await writeCredentialReference(credentialDirectory, "writer-b.json", writerB, server.origin, trustMaterialReference, cubePayload.cube_id),
    };

    return {
      endpoint: server.origin,
      cubeId: cubePayload.cube_id,
      trustMaterialReference,
      credentialReferences,
      clientIds: { reader: reader.clientId, writerA: writerA.clientId, writerB: writerB.clientId },
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
  enrollment: Enrollment,
  endpoint: string,
  trustMaterialReference: string,
  cubeId: string,
): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify({
    endpoint,
    trust_material_reference: trustMaterialReference,
    cube_id: cubeId,
    client_id: enrollment.clientId,
    credential: enrollment.credential,
  }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (((await stat(path)).mode & 0o777) !== 0o600) {
    throw new Error("Sprint 4 credential references must be mode 0600.");
  }
  return path;
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
  return new Promise((resolve, reject) => {
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
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

async function getStatus(origin: string, ca: Buffer, path: string, credential: string): Promise<number> {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
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
    outgoing.on("error", reject);
    outgoing.end();
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
