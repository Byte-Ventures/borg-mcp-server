import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  runAdapterConformance,
  type ConformanceEnvironment,
  type ConformanceHttpResponse,
} from "borgmcp-shared/conformance";
import {
  ATTACH_PATH,
  REPOSITORY_CUBE_ASSOCIATION_PATH,
  REPOSITORY_CUBE_RESOLVE_PATH,
  type CreateCubeResponse,
  type LogCursor,
} from "borgmcp-shared/protocol";
import { generate } from "selfsigned";
import { afterEach, describe, expect, it } from "vitest";

import { CoordinationApi } from "../src/coordination-api.js";
import { CredentialAuthority, CredentialDigester, generateSecret } from "../src/credentials.js";
import { createEnrollmentExchange } from "../src/enrollment.js";
import {
  DEFAULT_SERVICE_LIMITS,
  startHttpsServer,
  type RunningServer,
} from "../src/https-server.js";
import { clientPrincipal } from "../src/principal.js";
import { openStore, type StoreRuntime } from "../src/store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("borgmcp-shared server adapter", () => {
  it("passes shared adapter conformance", async () => {
    const fixture = await conformanceEnvironment();
    try {
      const report = await runAdapterConformance(fixture.environment, {
        streamDeadlineMs: 2_000,
        pendingProbeMs: 10,
      });

      expect(report.results.filter((result) => !result.ok)).toEqual([]);
      expect(report.results).toHaveLength(34);
    } finally {
      await fixture.server.close();
      fixture.digester.destroy();
      fixture.runtime.close();
    }
  });
});

async function conformanceEnvironment(): Promise<{
  readonly environment: ConformanceEnvironment;
  readonly runtime: StoreRuntime;
  readonly digester: CredentialDigester;
  readonly server: RunningServer;
}> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-conformance-")));
  directories.push(directory);
  const databasePath = join(directory, "borg.db");
  let runtime = await openStore({ path: databasePath });
  const digester = new CredentialDigester(Buffer.alloc(32, 7));
  let authority = new CredentialAuthority(runtime.credentials, digester);
  let api = new CoordinationApi(runtime, authority);
  let exchangeEnrollment = createEnrollmentExchange(authority);
  const principalCubes = new Map<string, Map<string, "read" | "write" | "manage">>();
  const principalCubeOrder = new Map<string, string[]>();
  const invitations = new Map<string, string>();
  const enrolledClients = new Map<string, string>();
  const principalCredentials = new Map<string, string>();
  const createdByPrincipal = new Map<string, CreateCubeResponse>();
  const pendingCreateCapability = new Set<string>();
  const managedSessions = new Map<string, { sessionId: string; credential: string }>();
  const sessionCredentialPrincipals = new Map<string, string>();
  const material = await generate([{ name: "commonName", value: "localhost" }], {
    algorithm: "sha256",
    keyType: "ec",
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, keyAgreement: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
    ],
  });
  const startFixtureServer = () => startHttpsServer({
    bind: { port: 0 },
    // Shared 1.1.0 peaks at 156 requests per credential in one reset epoch, above the default 120.
    limits: { ...DEFAULT_SERVICE_LIMITS, maxRequestsPerWindow: 192 },
    tls: { key: material.private, cert: material.cert },
    authorizeCoordination: async (authorization) => authority.authenticateStatus(authorization),
    exchangeEnrollment: (request) => exchangeEnrollment(request),
    handleCoordination: (request) => api.handle(request),
  });
  let server = await startFixtureServer();
  const transport = new HttpsConformanceTransport(
    server.origin,
    material.cert,
  );

  const environment: ConformanceEnvironment = {
    admin: {
      reset: async () => {
        await server.close();
        runtime.maintenance.resetAuthorityState();
        principalCubes.clear();
        principalCubeOrder.clear();
        invitations.clear();
        enrolledClients.clear();
        principalCredentials.clear();
        createdByPrincipal.clear();
        pendingCreateCapability.clear();
        managedSessions.clear();
        sessionCredentialPrincipals.clear();
        authority = new CredentialAuthority(runtime.credentials, digester);
        api = new CoordinationApi(runtime, authority);
        exchangeEnrollment = createEnrollmentExchange(authority);
        server = await startFixtureServer();
        transport.setOrigin(server.origin);
      },
      createPrincipal: async () => ({ id: randomUUID() }),
      createCube: async (name) => {
        const id = randomUUID();
        runtime.maintenance.createCube({ id, name, directive: "" });
        return { id };
      },
      grantCube: async (principal, cube, access = "manage") => {
        const grants = principalCubes.get(principal.id) ?? new Map();
        grants.set(cube.id, access);
        principalCubes.set(principal.id, grants);
        const order = principalCubeOrder.get(principal.id) ?? [];
        if (!order.includes(cube.id)) order.push(cube.id);
        principalCubeOrder.set(principal.id, order);
        const clientId = enrolledClients.get(principal.id);
        if (clientId !== undefined) {
          runtime.maintenance.grantClientCube({ clientId, cubeId: cube.id, access });
        }
      },
      revokeCubeGrant: async (principal, cube) => {
        principalCubes.get(principal.id)?.delete(cube.id);
        const clientId = enrolledClients.get(principal.id);
        if (clientId !== undefined) runtime.maintenance.removeClientCubeGrant(clientId, cube.id);
      },
      createRole: async (cube, input) => {
        const roleAdminId = randomUUID();
        runtime.maintenance.createClient({ id: roleAdminId, name: "Conformance role admin" });
        runtime.maintenance.grantClientCube({ clientId: roleAdminId, cubeId: cube.id, access: "manage" });
        const role = runtime.forPrincipal(clientPrincipal(roleAdminId)).createRole(cube.id, {
          name: input.name ?? `Conformance ${randomUUID().slice(-8)}`,
          roleClass: input.roleClass,
          isHumanSeat: input.isHumanSeat,
          ...(input.detailedDescription === undefined
            ? {}
            : { detailedDescription: input.detailedDescription }),
          ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
          ...(input.isMandatory === undefined ? {} : { isMandatory: input.isMandatory }),
        });
        return { id: role.id };
      },
      seedEntryQueryIds: async (cube, entries) => {
        for (const entry of entries) {
          runtime.maintenance.replaceLogEntryId(cube.id, entry.current_id, entry.query_id);
        }
      },
      createDrone: async (principal, cube, role) => {
        const credential = principalCredentials.get(principal.id);
        if (credential === undefined) throw new Error("Principal is not enrolled.");
        const authenticated = authority.authenticate(`Bearer ${credential}`);
        if (authenticated === null) throw new Error("Principal credential is invalid.");
        const sessionCredential = generateSecret();
        const attachment = authority.attachSeat(runtime.forPrincipal(authenticated), {
          cubeId: cube.id,
          roleId: role.id,
          sessionCredential,
        });
        managedSessions.set(attachment.drone.id, {
          sessionId: attachment.sessionId,
          credential: sessionCredential,
        });
        return { id: attachment.drone.id };
      },
      issueManagedDroneSession: async (drone) => {
        const session = managedSessions.get(drone.id);
        if (session === undefined) throw new Error("Managed drone session is unavailable.");
        return session.credential;
      },
      revokeManagedDroneSession: async (drone) => {
        const session = managedSessions.get(drone.id);
        if (session === undefined) throw new Error("Managed drone session is unavailable.");
        runtime.maintenance.revokeDroneSession(session.sessionId);
      },
      grantCreateCubeCapability: async (principal) => {
        const clientId = enrolledClients.get(principal.id);
        if (clientId === undefined) pendingCreateCapability.add(principal.id);
        else runtime.maintenance.grantCreateCubeCapability(clientId);
      },
      issueDroneSession: async (principal) => {
        const clientId = enrolledClients.get(principal.id);
        let resolvedClientId = clientId;
        if (resolvedClientId === undefined) {
          const invitation = createFixtureClientInvitation(runtime, authority, digester, databasePath);
          const credential = generateSecret();
          const enrolled = authority.exchangeInvitation({
            invitation,
            retryKey: randomUUID(),
            clientCredential: credential,
          });
          if (enrolled === null) throw new Error("Principal enrollment failed.");
          resolvedClientId = enrolled.clientId;
          enrolledClients.set(principal.id, resolvedClientId);
          principalCredentials.set(principal.id, credential);
          for (const [grantedCubeId, access] of principalCubes.get(principal.id) ?? []) {
            runtime.maintenance.grantClientCube({ clientId: resolvedClientId, cubeId: grantedCubeId, access });
          }
        }
        const grants = principalCubes.get(principal.id);
        const grantedCubeId = principalCubeOrder.get(principal.id)
          ?.find((cubeId) => grants?.has(cubeId));
        const cubeId = grantedCubeId ?? randomUUID();
        const roleId = randomUUID();
        if (grantedCubeId === undefined) {
          runtime.maintenance.createCube({ id: cubeId, ownerId: resolvedClientId, name: "Session fixture", directive: "" });
          runtime.maintenance.grantClientCube({ clientId: resolvedClientId, cubeId, access: "manage" });
        }
        runtime.maintenance.createRole({ id: roleId, cubeId, name: `Session ${roleId.slice(-8)}` });
        const sessionCredential = generateSecret();
        authority.attachSeat(runtime.forPrincipal(authority.authenticate(
          `Bearer ${principalCredentials.get(principal.id) ?? ""}`,
        )!), {
          cubeId,
          roleId,
          sessionCredential,
        });
        sessionCredentialPrincipals.set(sessionCredential, principal.id);
        return sessionCredential;
      },
      issueSingleUseInvitation: async (principal, purpose) => {
        const invitation = purpose === "owner"
          ? authority.createBootstrapInvitation(60_000)
          : createFixtureClientInvitation(runtime, authority, digester, databasePath);
        if (invitation === null) throw new Error("Invitation creation failed.");
        invitations.set(invitation, principal.id);
        return invitation;
      },
      prepareRepositoryCube: async (cube, input) => {
        const prepared = runtime.maintenance.prepareRepositoryCube({
          cubeId: cube.id,
          name: input.name,
          template: input.template,
        });
        return {
          cube_id: prepared.cubeId,
          name: prepared.name,
          template: prepared.template,
          human_seat_role_id: prepared.humanSeatRoleId,
          default_worker_role_id: prepared.defaultWorkerRoleId,
          access: prepared.access,
        };
      },
      revokePrincipal: async (principal) => {
        const clientId = enrolledClients.get(principal.id);
        if (clientId !== undefined) authority.revokeClient(clientId);
      },
      expireCursor: async (cube, cursor) => {
        runtime.maintenance.expireActivityCursor(cube.id, cursor);
      },
      armReplayTransition: () => api.armReplayTransition(),
    },
    operations: {
      health: async () => transport.request("GET", "/healthz"),
      protocol: async () => transport.request("GET", "/api/protocol"),
      attach: async (credential, request) =>
        transport.request("POST", ATTACH_PATH, JSON.stringify(request), credential),
      selfMetadataUpdate: async (credential, cube, request) => transport.request(
        "PATCH",
        `/api/cubes/${cube.id}/drones/self/metadata`,
        JSON.stringify(request),
        credential,
      ),
      enroll: async (request) => {
        const result = await transport.request(
          "POST",
          "/api/enrollment/exchange",
          JSON.stringify(request),
        );
        if (result.status === 201) {
          const record = request as {
            payload: { invitation: string; client_credential: string };
          };
          const body = result.body as {
            payload: { client_id: string };
          };
          const principalId = invitations.get(record.payload.invitation);
          const grants = principalId === undefined ? undefined : principalCubes.get(principalId);
          if (principalId !== undefined) {
            enrolledClients.set(principalId, body.payload.client_id);
            principalCredentials.set(principalId, record.payload.client_credential);
            for (const [cubeId, access] of grants ?? []) runtime.maintenance.grantClientCube({
              clientId: body.payload.client_id, cubeId, access,
            });
            if (pendingCreateCapability.has(principalId)) {
              runtime.maintenance.grantCreateCubeCapability(body.payload.client_id);
            }
          }
        }
        return result;
      },
      createCube: async (credential, request) => {
        const result = await transport.request("POST", "/api/cubes", JSON.stringify(request), credential);
        if (result.status === 201 && credential !== null) {
          const principalId = [...principalCredentials.entries()]
            .find(([, candidate]) => candidate === credential)?.[0];
          if (principalId !== undefined) {
            createdByPrincipal.set(
              principalId,
              (result.body as { payload: CreateCubeResponse }).payload,
            );
          }
        }
        return result;
      },
      resolveRepositoryCube: async (credential, request) => transport.request(
        "POST",
        REPOSITORY_CUBE_RESOLVE_PATH,
        JSON.stringify(request),
        credential,
      ),
      associateRepositoryCube: async (credential, request) => transport.request(
        "PUT",
        REPOSITORY_CUBE_ASSOCIATION_PATH,
        JSON.stringify(request),
        credential,
      ),
      append: async (credential, cube, request) =>
        transport.request("POST", `/api/cubes/${cube.id}/logs`, JSON.stringify(request), credential),
      appendRaw: async (credential, cube, body) =>
        transport.request("POST", `/api/cubes/${cube.id}/logs`, body, credential),
      putDocument: async (credential, cube, request) =>
        transport.request("PUT", `/api/cubes/${cube.id}/documents`, JSON.stringify(request),
          documentCredential(credential, sessionCredentialPrincipals, principalCredentials)),
      listDocuments: async (credential, cube, request) =>
        transport.request("GET", `/api/cubes/${cube.id}/documents`, JSON.stringify(request),
          documentCredential(credential, sessionCredentialPrincipals, principalCredentials)),
      getDocument: async (credential, cube, request) => {
        const id = (request as { payload: { id: string } }).payload.id;
        return transport.request("GET", `/api/cubes/${cube.id}/documents/${encodeURIComponent(id)}`, JSON.stringify(request),
          documentCredential(credential, sessionCredentialPrincipals, principalCredentials));
      },
      removeDocument: async (credential, cube, request) => {
        const id = (request as { payload: { id: string } }).payload.id;
        return transport.request("DELETE", `/api/cubes/${cube.id}/documents/${encodeURIComponent(id)}`, JSON.stringify(request),
          documentCredential(credential, sessionCredentialPrincipals, principalCredentials));
      },
      read: async (credential, cube, request) =>
        transport.request("PUT", `/api/cubes/${cube.id}/logs`, JSON.stringify(request), credential),
      entryQuery: async (credential, cube, request) => {
        const entryId = (request as { payload: { entry_id: string } }).payload.entry_id;
        return transport.request(
          "GET",
          `/api/cubes/${cube.id}/logs/${encodeURIComponent(entryId)}`,
          undefined,
          credential,
        );
      },
      ack: async (credential, cube, request) =>
        transport.request("POST", `/api/cubes/${cube.id}/acks`, JSON.stringify(request), credential),
      ackStatus: async (credential, cube, request) => {
        const entryId = (request as { payload: { entry_id: string } }).payload.entry_id;
        return transport.request(
          "GET",
          `/api/cubes/${cube.id}/logs/${encodeURIComponent(entryId)}/ack-status`,
          JSON.stringify(request),
          credential,
        );
      },
      updateCube: async (credential, cube, request) =>
        transport.request("PATCH", `/api/cubes/${cube.id}`, JSON.stringify(request), credential),
      deleteCube: async (credential, cube, request) =>
        transport.request("DELETE", `/api/cubes/${cube.id}`, JSON.stringify(request), credential),
      createRole: async (credential, cube, request) =>
        transport.request("POST", `/api/cubes/${cube.id}/roles`, JSON.stringify(request), credential),
      patchTaxonomy: async (credential, cube, request) => {
        const envelope = request as {
          protocol_version: string;
          request_id: string;
          payload: { marker: string };
        };
        return transport.request(
          "POST",
          `/api/cubes/${cube.id}/taxonomy-patch`,
          JSON.stringify({
            protocol_version: envelope.protocol_version,
            request_id: envelope.request_id,
            payload: {
              action: "add",
              class_def: {
                class: envelope.payload.marker,
                prefixes: [`${envelope.payload.marker}:`],
              },
            },
          }),
          credential,
        );
      },
      recordDecision: async (credential, cube, request) =>
        transport.request("POST", `/api/cubes/${cube.id}/decisions`, JSON.stringify(request), credential),
      listDecisions: async (credential, cube, request) =>
        transport.request("PUT", `/api/cubes/${cube.id}/decisions`, JSON.stringify(request), credential),
      listDrones: async (credential, cube) =>
        transport.request("GET", `/api/cubes/${cube.id}/drones`, undefined, credential),
      reassignDrone: async (credential, cube, drone, request) => transport.request(
        "PATCH",
        `/api/cubes/${cube.id}/drones/${drone.id}`,
        JSON.stringify(request),
        credential,
      ),
      evictDrone: async (credential, cube, drone, request) => transport.request(
        "DELETE",
        `/api/cubes/${cube.id}/drones/${drone.id}`,
        JSON.stringify(request),
        credential,
      ),
      deleteRole: async (credential, cube, role, request) => transport.request(
        "DELETE",
        `/api/cubes/${cube.id}/roles/${role.id}`,
        JSON.stringify(request),
        credential,
      ),
      roleRationale: async (credential, cube, request) => transport.request(
        "POST",
        `/api/cubes/${cube.id}/role-rationale`,
        JSON.stringify(request),
        credential,
      ),
      openStream: async (credential, cube, cursor) => transport.stream(
        `/api/cubes/${cube.id}/stream${cursor === null ? "" : `?cursor=${opaqueCursor(cursor)}`}`,
        credential,
      ),
    },
  };
  return {
    environment,
    get runtime() { return runtime; },
    digester,
    server: {
      get origin() { return server.origin; },
      get limits() { return server.limits; },
      close: () => server.close(),
    },
  };
}

function createFixtureClientInvitation(
  runtime: StoreRuntime,
  authority: CredentialAuthority,
  digester: CredentialDigester,
  databasePath: string,
): string {
  const clientId = randomUUID();
  const credentialId = randomUUID();
  const credential = generateSecret();
  runtime.maintenance.createClient({ id: clientId, name: `Issuer ${clientId.slice(-8)}` });
  runtime.maintenance.grantCreateCubeCapability(clientId);
  const digest = digester.digest(credential, "client");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  let invitation: string | null = null;
  try {
    database.prepare(`
      INSERT INTO client_credentials (
        id, client_id, lookup_digest, verifier_digest, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      credentialId,
      clientId,
      digest.lookup,
      digest.verifier,
      "2026-08-11T00:00:00.000Z",
    );
    invitation = authority.createInvitationForOwnerCredential(credential, 60_000);
  } finally {
    database.prepare("DELETE FROM clients WHERE id = ?").run(clientId);
    database.close();
  }
  if (invitation === null) throw new Error("Invitation creation failed.");
  return invitation;
}

function opaqueCursor(cursor: LogCursor): string {
  return encodeURIComponent(Buffer.from(JSON.stringify(cursor)).toString("base64url"));
}

class HttpsConformanceTransport {
  #origin: string;
  readonly #ca: string;

  constructor(origin: string, ca: string) {
    this.#origin = origin;
    this.#ca = ca;
  }

  setOrigin(origin: string): void {
    this.#origin = origin;
  }

  request(
    method: string,
    path: string,
    body?: string,
    credential?: string | null,
  ): Promise<ConformanceHttpResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.#origin);
      const outgoing = httpsRequest({
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        ca: this.#ca,
        headers: {
          ...(body === undefined ? {} : {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          }),
          ...(credential == null ? {} : { authorization: `Bearer ${credential}` }),
        },
        agent: false,
      }, (response) => {
        response.setEncoding("utf8");
        let responseBody = "";
        response.on("data", (chunk: string) => { responseBody += chunk; });
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          body: responseBody.length === 0 ? "" : JSON.parse(responseBody),
        }));
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }

  stream(path: string, credential: string): Promise<{
    readonly status: number;
    readonly body: unknown;
    readonly stream: AsyncIterable<string> | null;
  }> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.#origin);
      const outgoing = httpsRequest({
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        ca: this.#ca,
        headers: { authorization: `Bearer ${credential}` },
        agent: false,
      }, (response) => {
        response.setEncoding("utf8");
        const status = response.statusCode ?? 0;
        if (status === 200) {
          resolve({ status, body: "", stream: stringStream(response) });
          return;
        }
        let body = "";
        response.on("data", (chunk: string) => { body += chunk; });
        response.on("end", () => resolve({
          status,
          body: body.length === 0 ? "" : JSON.parse(body),
          stream: null,
        }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
  }
}

function documentCredential(
  credential: string,
  sessionCredentialPrincipals: ReadonlyMap<string, string>,
  principalCredentials: ReadonlyMap<string, string>,
): string {
  const principalId = sessionCredentialPrincipals.get(credential);
  return principalId === undefined ? credential : principalCredentials.get(principalId) ?? credential;
}

async function* stringStream(stream: AsyncIterable<unknown>): AsyncIterable<string> {
  for await (const chunk of stream) yield String(chunk);
}
