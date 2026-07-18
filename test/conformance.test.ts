import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAdapterConformance,
  type ConformanceEnvironment,
  type ConformanceHttpResponse,
} from "borgmcp-shared/conformance";
import type { LogCursor } from "borgmcp-shared/protocol";
import { generate } from "selfsigned";
import { afterEach, describe, expect, it } from "vitest";

import { CoordinationApi } from "../src/coordination-api.js";
import { CredentialAuthority, CredentialDigester, generateSecret } from "../src/credentials.js";
import { createEnrollmentExchange } from "../src/enrollment.js";
import { startHttpsServer, type RunningServer } from "../src/https-server.js";
import { openStore, type StoreRuntime } from "../src/store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("borgmcp-shared server adapter", () => {
  it("passes the full forward conformance suite", async () => {
    const fixture = await conformanceEnvironment();
    try {
      const report = await runAdapterConformance(fixture.environment, {
        streamDeadlineMs: 2_000,
        pendingProbeMs: 10,
      });

      expect(report.results.filter((result) => !result.ok)).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.results).toHaveLength(13);
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
  const runtime = await openStore({ path: join(directory, "borg.db") });
  const digester = new CredentialDigester(Buffer.alloc(32, 7));
  const authority = new CredentialAuthority(runtime.credentials, digester);
  const api = new CoordinationApi(runtime, authority);
  const exchangeEnrollment = createEnrollmentExchange(authority);
  const principalCubes = new Map<string, string>();
  const invitations = new Map<string, string>();
  const enrolledClients = new Map<string, string>();
  const principalCredentials = new Map<string, string>();
  const createdByPrincipal = new Map<string, {
    cube_id: string;
    human_seat_role_id: string;
    default_worker_role_id: string;
    access: "manage";
  }>();
  const pendingCreateCapability = new Set<string>();
  const recovery = authority.createRecoveryCredential();
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
  const server = await startHttpsServer({
    bind: { port: 0 },
    tls: { key: material.private, cert: material.cert },
    authorizeCoordination: async (authorization) => authority.authenticateStatus(authorization),
    exchangeEnrollment,
    handleCoordination: (request) => api.handle(request),
  });
  const transport = new HttpsConformanceTransport(
    server.origin,
    material.cert,
    server.limits.maxRequestBodyBytes,
  );

  const environment: ConformanceEnvironment = {
    admin: {
      reset: async () => {
        runtime.maintenance.resetAuthorityState();
        principalCubes.clear();
        invitations.clear();
        enrolledClients.clear();
        principalCredentials.clear();
        createdByPrincipal.clear();
        pendingCreateCapability.clear();
      },
      createPrincipal: async () => ({ id: randomUUID() }),
      createCube: async (name) => {
        const id = randomUUID();
        runtime.maintenance.createCube({ id, name, directive: "" });
        return { id };
      },
      grantCube: async (principal, cube) => {
        principalCubes.set(principal.id, cube.id);
        const clientId = enrolledClients.get(principal.id);
        if (clientId !== undefined) {
          runtime.maintenance.grantClientCube({ clientId, cubeId: cube.id, access: "manage" });
        }
      },
      grantCreateCubeCapability: async (principal) => {
        const clientId = enrolledClients.get(principal.id);
        if (clientId === undefined) pendingCreateCapability.add(principal.id);
        else runtime.maintenance.grantCreateCubeCapability(clientId);
      },
      issueDroneSession: async (principal) => {
        const clientId = enrolledClients.get(principal.id);
        if (clientId === undefined) throw new Error("Principal is not enrolled.");
        const cubeId = randomUUID();
        const roleId = randomUUID();
        runtime.maintenance.createCube({ id: cubeId, ownerId: clientId, name: "Session fixture", directive: "" });
        runtime.maintenance.createRole({ id: roleId, cubeId, name: "Worker" });
        runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
        const sessionCredential = generateSecret();
        authority.attachSeat(runtime.forPrincipal(authority.authenticate(
          `Bearer ${principalCredentials.get(principal.id) ?? ""}`,
        )!), {
          cubeId,
          roleId,
          sessionCredential,
        });
        return sessionCredential;
      },
      issueSingleUseInvitation: async (principal, purpose) => {
        const invitation = purpose === "owner"
          ? authority.createBootstrapInvitation(60_000)
          : authority.createInvitation(recovery, 60_000);
        if (invitation === null) throw new Error("Invitation creation failed.");
        invitations.set(invitation, principal.id);
        return invitation;
      },
      observeAuthorityState: async () => runtime.maintenance.observeAuthorityState(),
      inspectCreatedCube: async (creator, response) => {
        const clientId = enrolledClients.get(creator.id);
        if (clientId === undefined) throw new Error("Creator is not enrolled.");
        return runtime.maintenance.inspectCreatedCube(clientId, {
          cubeId: response.cube_id,
          humanSeatRoleId: response.human_seat_role_id,
          defaultWorkerRoleId: response.default_worker_role_id,
          access: response.access,
        });
      },
      inspectEnrollmentPrincipal: async (principal, responseClientId) => {
        const credential = principalCredentials.get(principal.id);
        const authenticated = credential === undefined
          ? null
          : authority.authenticateStatus(`Bearer ${credential}`);
        return {
          response_client_matches: enrolledClients.get(principal.id) === responseClientId,
          ...runtime.maintenance.inspectEnrollmentPrincipal(responseClientId),
          bound_credential_matches_enrollment: authenticated !== null &&
            typeof authenticated === "object" &&
            authenticated.kind === "client" && authenticated.id === responseClientId,
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
          const cubeId = principalId === undefined ? undefined : principalCubes.get(principalId);
          if (principalId !== undefined) {
            enrolledClients.set(principalId, body.payload.client_id);
            principalCredentials.set(principalId, record.payload.client_credential);
            if (cubeId !== undefined) runtime.maintenance.grantClientCube({
              clientId: body.payload.client_id, cubeId, access: "manage",
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
            createdByPrincipal.set(principalId, (result.body as { payload: {
              cube_id: string;
              human_seat_role_id: string;
              default_worker_role_id: string;
              access: "manage";
            } }).payload);
          }
        }
        return result;
      },
      append: async (credential, cube, request) =>
        transport.request("POST", `/api/cubes/${cube.id}/logs`, JSON.stringify(request), credential),
      appendRaw: async (credential, cube, body) =>
        transport.request("POST", `/api/cubes/${cube.id}/logs`, body, credential),
      read: async (credential, cube, request) =>
        transport.request("PUT", `/api/cubes/${cube.id}/logs`, JSON.stringify(request), credential),
      ack: async (credential, cube, request) =>
        transport.request("POST", `/api/cubes/${cube.id}/acks`, JSON.stringify(request), credential),
      recordDecision: async (credential, cube, request) =>
        transport.request("POST", `/api/cubes/${cube.id}/decisions`, JSON.stringify(request), credential),
      listDecisions: async (credential, cube, request) =>
        transport.request("PUT", `/api/cubes/${cube.id}/decisions`, JSON.stringify(request), credential),
      openStream: async (credential, cube, cursor) => transport.stream(
        `/api/cubes/${cube.id}/stream${cursor === null ? "" : `?cursor=${opaqueCursor(cursor)}`}`,
        credential,
      ),
    },
  };
  return { environment, runtime, digester, server };
}

function opaqueCursor(cursor: LogCursor): string {
  return encodeURIComponent(Buffer.from(JSON.stringify(cursor)).toString("base64url"));
}

class HttpsConformanceTransport {
  readonly #origin: string;
  readonly #ca: string;
  readonly #maxRequestBodyBytes: number;

  constructor(origin: string, ca: string, maxRequestBodyBytes: number) {
    this.#origin = origin;
    this.#ca = ca;
    this.#maxRequestBodyBytes = maxRequestBodyBytes;
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
      outgoing.end(body !== undefined && Buffer.byteLength(body) <= this.#maxRequestBodyBytes
        ? body
        : undefined);
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

async function* stringStream(stream: AsyncIterable<unknown>): AsyncIterable<string> {
  for await (const chunk of stream) yield String(chunk);
}
