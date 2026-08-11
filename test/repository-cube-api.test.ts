import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  REPOSITORY_CUBE_ASSOCIATION_PATH,
  REPOSITORY_CUBE_RESOLVE_PATH,
} from "borgmcp-shared/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CoordinationApi } from "../src/coordination-api.js";
import {
  CredentialAuthority,
  CredentialDigester,
  generateSecret,
} from "../src/credentials.js";
import { clientPrincipal, type Principal } from "../src/principal.js";
import {
  openStore,
  type OpenStoreOptions,
  type StoreRuntime,
} from "../src/store.js";

const directories: string[] = [];
const runtimes: StoreRuntime[] = [];
const digesters: CredentialDigester[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const digester of digesters.splice(0)) digester.destroy();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("repository cube API", () => {
  it("adopts and resolves a worker-class legacy human seat through the API", async () => {
    const fixture = await apiFixture();
    const repository = {
      kind: "origin",
      value: "https://github.com/Byte-Ventures/borg-mcp",
    };
    const before = fixture.runtime.maintenance.observeAuthorityState();
    const none = await request(
      fixture,
      "POST",
      REPOSITORY_CUBE_RESOLVE_PATH,
      "resolve-none",
      {
      working_repo_name: "borg-mcp",
      repository,
      },
    );
    expect(none).toEqual({
      status: 200,
      body: {
        protocol_version: PROTOCOL_VERSION,
        request_id: "resolve-none",
        payload: { result: "none" },
      },
    });
    expect(fixture.runtime.maintenance.observeAuthorityState()).toEqual(before);

    const associated = await request(fixture, "PUT", REPOSITORY_CUBE_ASSOCIATION_PATH, "associate", {
      cube_id: fixture.cubeId,
      working_repo_name: "borg-mcp",
      repository,
    });
    expect(associated).toEqual({
      status: 200,
      body: {
        protocol_version: PROTOCOL_VERSION,
        request_id: "associate",
        payload: {
          result: "resolved",
          cube_id: fixture.cubeId,
          name: "borg-mcp",
          working_repo_name: "borg-mcp",
          repository,
          template: "default",
          human_seat_role_id: fixture.humanRoleId,
          default_worker_role_id: fixture.workerRoleId,
          access: "manage",
        },
      },
    });
    expect(await request(fixture, "PUT", REPOSITORY_CUBE_ASSOCIATION_PATH, "associate-idempotent", {
      cube_id: fixture.cubeId,
      working_repo_name: "borg-mcp",
      repository,
    })).toMatchObject({
      status: 200,
      body: { payload: { result: "resolved", cube_id: fixture.cubeId } },
    });
    expect(await request(fixture, "POST", REPOSITORY_CUBE_RESOLVE_PATH, "resolve-existing", {
      working_repo_name: "borg-mcp",
      repository,
    })).toMatchObject({
      status: 200,
      body: {
        payload: {
          result: "resolved",
          cube_id: fixture.cubeId,
          name: "borg-mcp",
          human_seat_role_id: fixture.humanRoleId,
          default_worker_role_id: fixture.workerRoleId,
        },
      },
    });
    expect(fixture.runtime.maintenance.observeAuthorityState()).toMatchObject({
      cubes: 1,
      cube_create_bindings: 0,
      repository_associations: 1,
    });
  });

  it("rejects non-strict requests before mutation", async () => {
    const fixture = await apiFixture();
    const response = await request(
      fixture,
      "PUT",
      REPOSITORY_CUBE_ASSOCIATION_PATH,
      "associate-extra",
      {
      cube_id: fixture.cubeId,
      working_repo_name: "borg-mcp",
      repository: { kind: "local", value: randomUUID(), extra: true },
      },
    );
    expect(response).toMatchObject({
      status: 400,
      body: {
        request_id: "associate-extra",
        error: { code: "INVALID_INPUT", message: "Invalid protocol request." },
      },
    });
    expect(fixture.runtime.maintenance.observeAuthorityState().repository_associations).toBe(0);
  });

  it("returns typed secret-free conflict and authority errors with zero partial mutation", async () => {
    const fixture = await apiFixture();
    const otherCubeId = randomUUID();
    fixture.runtime.maintenance.createCube({
      id: otherCubeId,
      ownerId: fixture.principal.id,
      name: "Other",
      directive: "",
    });
    fixture.runtime.maintenance.grantClientCube({
      clientId: fixture.principal.id,
      cubeId: otherCubeId,
      access: "manage",
    });
    addRequiredRoles(fixture.runtime, fixture.principal.id, otherCubeId);
    const repository = { kind: "local", value: randomUUID() };
    await request(fixture, "PUT", REPOSITORY_CUBE_ASSOCIATION_PATH, "associate-first", {
      cube_id: fixture.cubeId,
      working_repo_name: "borg-mcp",
      repository,
    });

    const conflict = await request(
      fixture,
      "PUT",
      REPOSITORY_CUBE_ASSOCIATION_PATH,
      "associate-conflict",
      {
      cube_id: otherCubeId,
      working_repo_name: "other",
      repository,
      },
    );
    expect(conflict).toMatchObject({
      status: 409,
      body: {
        request_id: "associate-conflict",
        error: {
          code: "REPOSITORY_ALREADY_ASSOCIATED",
          message: "The repository is already associated with another cube.",
        },
      },
    });
    expect(JSON.stringify(conflict)).not.toContain(repository.value);

    const otherRepository = { kind: "local", value: randomUUID() };
    const cubeConflict = await request(
      fixture,
      "PUT",
      REPOSITORY_CUBE_ASSOCIATION_PATH,
      "associate-cube-conflict",
      {
        cube_id: fixture.cubeId,
        working_repo_name: "other",
        repository: otherRepository,
      },
    );
    expect(cubeConflict).toMatchObject({
      status: 200,
      body: {
        request_id: "associate-cube-conflict",
        payload: {
          result: "resolved",
          cube_id: fixture.cubeId,
          repository: otherRepository,
        },
      },
    });

    const invalidRolesCubeId = randomUUID();
    fixture.runtime.maintenance.createCube({
      id: invalidRolesCubeId,
      ownerId: fixture.principal.id,
      name: "Invalid roles",
      directive: "",
    });
    fixture.runtime.maintenance.grantClientCube({
      clientId: fixture.principal.id,
      cubeId: invalidRolesCubeId,
      access: "manage",
    });
    const invalidRoles = await request(
      fixture,
      "PUT",
      REPOSITORY_CUBE_ASSOCIATION_PATH,
      "associate-invalid-roles",
      {
        cube_id: invalidRolesCubeId,
        working_repo_name: "invalid-roles",
        repository: { kind: "local", value: randomUUID() },
      },
    );
    expect(invalidRoles).toMatchObject({
      status: 409,
      body: {
        request_id: "associate-invalid-roles",
        error: {
          code: "INVALID_INPUT",
          message: "The cube does not have one valid human seat and one valid default worker role.",
        },
      },
    });
    expect(JSON.stringify(invalidRoles)).not.toContain(invalidRolesCubeId);

    const readClient = await enrollClient(fixture.authority, false, fixture.ownerCredential);
    fixture.runtime.maintenance.grantClientCube({
      clientId: readClient.principal.id,
      cubeId: otherCubeId,
      access: "read",
    });
    expect(await request(
      { ...fixture, principal: readClient.principal },
      "PUT",
      REPOSITORY_CUBE_ASSOCIATION_PATH,
      "associate-denied",
      {
        cube_id: otherCubeId,
        working_repo_name: "other",
        repository: { kind: "local", value: randomUUID() },
      },
    )).toMatchObject({
      status: 403,
      body: { error: { code: "ACCESS_DENIED", message: "Access denied." } },
    });
    expect(fixture.runtime.maintenance.observeAuthorityState().repository_associations).toBe(2);
  });

  it("maps association capacity rejection without partial mutation", async () => {
    let capacity = { databaseBytes: 0, freeDiskBytes: 2_000_000 };
    const fixture = await apiFixture({
      storageLimits: {
        maxActivityEntriesPerCube: 10,
        maxDatabaseBytes: 1_000_000,
        minFreeDiskBytes: 10_000,
      },
      capacityProbe: () => capacity,
    });
    capacity = { databaseBytes: 1_000_000, freeDiskBytes: 2_000_000 };
    const response = await request(
      fixture,
      "PUT",
      REPOSITORY_CUBE_ASSOCIATION_PATH,
      "associate-capacity",
      {
        cube_id: fixture.cubeId,
        working_repo_name: "borg-mcp",
        repository: { kind: "local", value: randomUUID() },
      },
    );

    expect(response).toMatchObject({
      status: 507,
      body: {
        request_id: "associate-capacity",
        error: {
          code: "CAPACITY_EXCEEDED",
          message: "Storage capacity is unavailable.",
        },
      },
    });
    expect(fixture.runtime.maintenance.observeAuthorityState().repository_associations).toBe(0);
  });
});

async function apiFixture(options: Omit<OpenStoreOptions, "path"> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-repository-api-")));
  directories.push(directory);
  const runtime = await openStore({ path: join(directory, "borg.db"), ...options });
  runtimes.push(runtime);
  const digester = new CredentialDigester(Buffer.alloc(32, 29));
  digesters.push(digester);
  const authority = new CredentialAuthority(runtime.credentials, digester);
  const enrollment = await enrollClient(authority, true);
  const cubeId = randomUUID();
  runtime.maintenance.createCube({
    id: cubeId,
    ownerId: enrollment.principal.id,
    name: "borg-mcp",
    directive: "legacy",
  });
  runtime.maintenance.grantClientCube({
    clientId: enrollment.principal.id,
    cubeId,
    access: "manage",
  });
  const roles = addRequiredRoles(runtime, enrollment.principal.id, cubeId);
  return {
    runtime,
    authority,
    api: new CoordinationApi(runtime, authority),
    principal: enrollment.principal,
    ownerCredential: enrollment.credential,
    cubeId,
    ...roles,
  };
}

async function enrollClient(
  authority: CredentialAuthority,
  owner = false,
  ownerCredential?: string,
) {
  const credential = generateSecret();
  const invitation = owner
    ? authority.createBootstrapInvitation(60_000)
    : authority.createInvitationForOwnerCredential(ownerCredential ?? "", 60_000)!;
  authority.exchangeInvitation({
    invitation,
    retryKey: randomUUID(),
    clientCredential: credential,
  });
  const principal = authority.authenticate(`Bearer ${credential}`)!;
  if (principal.kind !== "client") throw new Error("Expected a client principal.");
  return { principal, credential };
}

function addRequiredRoles(runtime: StoreRuntime, clientId: string, cubeId: string) {
  const store = runtime.forPrincipal(clientPrincipal(clientId));
  const humanRoleId = store.createRole(cubeId, {
    name: "Coordinator",
    isHumanSeat: true,
    roleClass: "worker",
  }).id;
  store.createRole(cubeId, { name: "Queen", roleClass: "queen" });
  const workerRoleId = store.createRole(cubeId, {
    name: "Builder",
    isDefault: true,
    roleClass: "worker",
  }).id;
  return { humanRoleId, workerRoleId };
}

async function request(
  fixture: { readonly api: CoordinationApi; readonly principal: Principal },
  method: string,
  path: string,
  requestId: string,
  payload: Record<string, unknown>,
) {
  return fixture.api.handle({
    method,
    path,
    principal: fixture.principal,
    body: {
      protocol_version: PROTOCOL_VERSION,
      request_id: requestId,
      payload,
    },
    signal: new AbortController().signal,
  });
}
