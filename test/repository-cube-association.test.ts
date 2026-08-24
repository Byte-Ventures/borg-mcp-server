import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { clientPrincipal } from "../src/principal.js";
import {
  AccessDeniedError,
  RepositoryAssociationConflictError,
  StorageCapacityError,
  openStore,
  type StoreRuntime,
} from "../src/store.js";

const directories: string[] = [];
const runtimes: StoreRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("repository cube association", () => {
  it("adopts and resolves a worker-class legacy human seat without creating a duplicate", async () => {
    const fixture = await legacyCubeFixture();
    const store = fixture.runtime.forPrincipal(clientPrincipal(fixture.clientId));
    const repository = {
      kind: "origin" as const,
      value: "https://github.com/Byte-Ventures/borg-mcp",
    };

    expect(store.resolveRepositoryCube({
      workingRepoName: "borg-mcp",
      repository,
    })).toBeNull();

    const adopted = store.associateRepositoryCube({
      cubeId: fixture.cubeId,
      workingRepoName: "borg-mcp",
      repository,
    });
    expect(adopted).toEqual({
      cubeId: fixture.cubeId,
      name: "borg-mcp",
      workingRepoName: "borg-mcp",
      repository,
      template: "default",
      humanSeatRoleId: fixture.humanRoleId,
      defaultWorkerRoleId: fixture.workerRoleId,
      access: "manage",
    });
    expect(store.associateRepositoryCube({
      cubeId: fixture.cubeId,
      workingRepoName: "borg-mcp",
      repository,
    })).toEqual(adopted);
    expect(store.resolveRepositoryCube({
      workingRepoName: "borg-mcp",
      repository,
    })).toEqual(adopted);

    fixture.runtime.maintenance.grantCreateCubeCapability(fixture.clientId);
    expect(store.createCube({
      retryKey: randomUUID(),
      name: "Must not be created",
      workingRepoName: "replacement-display",
      repository,
      template: "starter",
    })).toEqual({ result: "resolved", ...adopted });
    expect(fixture.runtime.maintenance.observeAuthorityState()).toMatchObject({
      cubes: 1,
      cube_create_bindings: 0,
      repository_associations: 1,
    });
  });

  it("keeps repository conflicts while allowing multiple repositories on one cube", async () => {
    const fixture = await legacyCubeFixture();
    const otherCubeId = randomUUID();
    fixture.runtime.maintenance.createCube({
      id: otherCubeId,
      ownerId: fixture.clientId,
      name: "Other",
      directive: "",
    });
    fixture.runtime.maintenance.grantClientCube({
      clientId: fixture.clientId,
      cubeId: otherCubeId,
      access: "manage",
    });
    addRequiredRoles(fixture.runtime, fixture.clientId, otherCubeId);
    const store = fixture.runtime.forPrincipal(clientPrincipal(fixture.clientId));
    const repository = { kind: "local" as const, value: randomUUID() };
    store.associateRepositoryCube({
      cubeId: fixture.cubeId,
      workingRepoName: "legacy",
      repository,
    });

    expect(() => store.associateRepositoryCube({
      cubeId: otherCubeId,
      workingRepoName: "other",
      repository,
    })).toThrowError(new RepositoryAssociationConflictError("repository_conflict"));
    const secondRepository = { kind: "local" as const, value: randomUUID() };
    expect(store.associateRepositoryCube({
      cubeId: fixture.cubeId,
      workingRepoName: "second",
      repository: secondRepository,
    })).toMatchObject({ cubeId: fixture.cubeId, repository: secondRepository });
    expect(fixture.runtime.maintenance.observeAuthorityState().repository_associations).toBe(2);
  });

  it("inspects the created cube through the requested repository row", async () => {
    const fixture = await legacyCubeFixture();
    fixture.runtime.maintenance.grantCreateCubeCapability(fixture.clientId);
    const store = fixture.runtime.forPrincipal(clientPrincipal(fixture.clientId));
    const primaryRepository = { kind: "local" as const, value: randomUUID() };
    const created = store.createCube({
      retryKey: randomUUID(),
      name: "Multi-repository cube",
      workingRepoName: "primary",
      repository: primaryRepository,
      template: "starter",
    });
    const secondaryRepository = { kind: "local" as const, value: randomUUID() };
    store.associateRepositoryCube({
      cubeId: created.cubeId,
      workingRepoName: "secondary",
      repository: secondaryRepository,
    });

    expect(fixture.runtime.maintenance.inspectCreatedCube(fixture.clientId, created)).toMatchObject({
      cube_exists: true,
      working_repo_name: "primary",
      repository: primaryRepository,
    });
  });

  it("requires cube-manage authority without leaking inaccessible cubes", async () => {
    let targetAuthorizationReached = false;
    const fixture = await legacyCubeFixture((phase) => {
      if (phase === "repository-association.target-authorized") {
        targetAuthorizationReached = true;
        throw new Error("target authorization was bypassed");
      }
    });
    const readClientId = randomUUID();
    const foreignClientId = randomUUID();
    fixture.runtime.maintenance.createClient({ id: readClientId, name: "Read client" });
    fixture.runtime.maintenance.createClient({ id: foreignClientId, name: "Foreign client" });
    fixture.runtime.maintenance.grantClientCube({
      clientId: readClientId,
      cubeId: fixture.cubeId,
      access: "read",
    });
    const input = {
      cubeId: fixture.cubeId,
      workingRepoName: "legacy",
      repository: { kind: "local" as const, value: randomUUID() },
    };

    expect(() => fixture.runtime.forPrincipal(clientPrincipal(readClientId))
      .associateRepositoryCube(input)).toThrowError(AccessDeniedError);
    expect(() => fixture.runtime.forPrincipal(clientPrincipal(foreignClientId))
      .associateRepositoryCube(input)).toThrowError(AccessDeniedError);
    expect(targetAuthorizationReached).toBe(false);
    expect(fixture.runtime.maintenance.observeAuthorityState().repository_associations).toBe(0);
  });

  it("hides stale same-client bindings and rejects reassociation without an oracle", async () => {
    const fixture = await legacyCubeFixture();
    const otherCubeId = randomUUID();
    fixture.runtime.maintenance.createCube({
      id: otherCubeId,
      ownerId: fixture.clientId,
      name: "Other",
      directive: "",
    });
    fixture.runtime.maintenance.grantClientCube({
      clientId: fixture.clientId,
      cubeId: otherCubeId,
      access: "manage",
    });
    addRequiredRoles(fixture.runtime, fixture.clientId, otherCubeId);
    const store = fixture.runtime.forPrincipal(clientPrincipal(fixture.clientId));
    const repository = { kind: "local" as const, value: randomUUID() };
    store.associateRepositoryCube({
      cubeId: fixture.cubeId,
      workingRepoName: "legacy",
      repository,
    });
    fixture.runtime.maintenance.removeClientCubeGrant(fixture.clientId, fixture.cubeId);

    expect(store.resolveRepositoryCube({
      workingRepoName: "legacy",
      repository,
    })).toBeNull();
    expect(() => store.associateRepositoryCube({
      cubeId: otherCubeId,
      workingRepoName: "other",
      repository,
    })).toThrowError(AccessDeniedError);
    expect(fixture.runtime.maintenance.observeAuthorityState().repository_associations).toBe(1);
  });

  it("keeps revoked associations stored and unusable without affecting another client", async () => {
    const fixture = await legacyCubeFixture();
    const secondClientId = randomUUID();
    fixture.runtime.maintenance.createClient({ id: secondClientId, name: "Second client" });
    fixture.runtime.maintenance.grantClientCube({
      clientId: secondClientId,
      cubeId: fixture.cubeId,
      access: "manage",
    });
    const ownerStore = fixture.runtime.forPrincipal(clientPrincipal(fixture.clientId));
    const secondStore = fixture.runtime.forPrincipal(clientPrincipal(secondClientId));
    const ownerRepository = { kind: "local" as const, value: randomUUID() };
    const secondRepository = { kind: "local" as const, value: randomUUID() };
    ownerStore.associateRepositoryCube({
      cubeId: fixture.cubeId,
      workingRepoName: "owner",
      repository: ownerRepository,
    });
    secondStore.associateRepositoryCube({
      cubeId: fixture.cubeId,
      workingRepoName: "second",
      repository: secondRepository,
    });

    fixture.runtime.maintenance.revokeClient(fixture.clientId);

    expect(fixture.runtime.maintenance.observeAuthorityState().repository_associations).toBe(2);
    expect(ownerStore.resolveRepositoryCube({
      workingRepoName: "owner",
      repository: ownerRepository,
    })).toBeNull();
    expect(() => ownerStore.associateRepositoryCube({
      cubeId: fixture.cubeId,
      workingRepoName: "revoked",
      repository: { kind: "local", value: randomUUID() },
    })).toThrowError(AccessDeniedError);
    expect(secondStore.resolveRepositoryCube({
      workingRepoName: "second",
      repository: secondRepository,
    })).toMatchObject({ cubeId: fixture.cubeId, repository: secondRepository });
    expect(secondStore.appendActivity(fixture.cubeId, "still active")).toMatchObject({
      cubeId: fixture.cubeId,
    });
  });

  it("scopes repository identities by authenticated client without cross-client conflicts", async () => {
    const fixture = await legacyCubeFixture();
    const secondClientId = randomUUID();
    const secondCubeId = randomUUID();
    fixture.runtime.maintenance.createClient({ id: secondClientId, name: "Second owner" });
    fixture.runtime.maintenance.createCube({
      id: secondCubeId,
      ownerId: secondClientId,
      name: "Second legacy",
      directive: "",
    });
    fixture.runtime.maintenance.grantClientCube({
      clientId: secondClientId,
      cubeId: secondCubeId,
      access: "manage",
    });
    addRequiredRoles(fixture.runtime, secondClientId, secondCubeId);
    const repository = { kind: "local" as const, value: randomUUID() };
    fixture.runtime.forPrincipal(clientPrincipal(fixture.clientId)).associateRepositoryCube({
      cubeId: fixture.cubeId,
      workingRepoName: "first",
      repository,
    });
    const secondStore = fixture.runtime.forPrincipal(clientPrincipal(secondClientId));

    expect(secondStore.resolveRepositoryCube({
      workingRepoName: "second",
      repository,
    })).toBeNull();
    expect(secondStore.associateRepositoryCube({
      cubeId: secondCubeId,
      workingRepoName: "second",
      repository,
    })).toMatchObject({ cubeId: secondCubeId, repository });
    expect(fixture.runtime.maintenance.observeAuthorityState().repository_associations).toBe(2);
  });

  it("fails closed when legacy human/default roles are absent or ambiguous", async () => {
    const directory = await createDirectory();
    const runtime = await openStore({ path: join(directory, "borg.db") });
    runtimes.push(runtime);
    const clientId = randomUUID();
    const cubeId = randomUUID();
    runtime.maintenance.createClient({ id: clientId, name: "Owner" });
    runtime.maintenance.createCube({ id: cubeId, ownerId: clientId, name: "Legacy", directive: "" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    const store = runtime.forPrincipal(clientPrincipal(clientId));
    const input = {
      cubeId,
      workingRepoName: "legacy",
      repository: { kind: "local" as const, value: randomUUID() },
    };

    expect(() => store.associateRepositoryCube(input))
      .toThrowError(new RepositoryAssociationConflictError("roles_invalid"));

    store.createRole(cubeId, {
      name: "Coordinator A",
      isHumanSeat: true,
      roleClass: "queen",
    });
    store.createRole(cubeId, {
      name: "Coordinator B",
      isHumanSeat: true,
      roleClass: "queen",
    });
    store.createRole(cubeId, {
      name: "Builder",
      isDefault: true,
      roleClass: "worker",
    });
    expect(() => store.associateRepositoryCube(input))
      .toThrowError(new RepositoryAssociationConflictError("roles_invalid"));
    expect(runtime.maintenance.observeAuthorityState().repository_associations).toBe(0);
  });

  it("rolls back an interrupted association mutation", async () => {
    const directory = await createDirectory();
    const runtime = await openStore({
      path: join(directory, "borg.db"),
      mutationHook: (phase) => {
        if (phase === "repository-association.insert") {
          throw new Error("injected association failure");
        }
      },
    });
    runtimes.push(runtime);
    const fixture = createLegacyCube(runtime);
    const store = runtime.forPrincipal(clientPrincipal(fixture.clientId));
    const repository = { kind: "local" as const, value: randomUUID() };

    expect(() => store.associateRepositoryCube({
      cubeId: fixture.cubeId,
      workingRepoName: "legacy",
      repository,
    })).toThrow("injected association failure");
    expect(runtime.maintenance.observeAuthorityState().repository_associations).toBe(0);
    expect(store.resolveRepositoryCube({
      workingRepoName: "legacy",
      repository,
    })).toBeNull();
  });

  it("fails before association mutation when storage capacity is unavailable", async () => {
    const directory = await createDirectory();
    let capacity = { databaseBytes: 0, freeDiskBytes: 2_000_000 };
    const runtime = await openStore({
      path: join(directory, "borg.db"),
      storageLimits: {
        maxActivityEntriesPerCube: 10,
        maxDatabaseBytes: 1_000_000,
        minFreeDiskBytes: 10_000,
      },
      capacityProbe: () => capacity,
    });
    runtimes.push(runtime);
    const fixture = createLegacyCube(runtime);
    const store = runtime.forPrincipal(clientPrincipal(fixture.clientId));
    const repository = { kind: "local" as const, value: randomUUID() };
    capacity = { databaseBytes: 1_000_000, freeDiskBytes: 2_000_000 };

    expect(() => store.associateRepositoryCube({
      cubeId: fixture.cubeId,
      workingRepoName: "legacy",
      repository,
    })).toThrowError(StorageCapacityError);
    expect(runtime.maintenance.observeAuthorityState().repository_associations).toBe(0);
    expect(store.resolveRepositoryCube({
      workingRepoName: "legacy",
      repository,
    })).toBeNull();
  });

  it("serializes competing bindings across store connections", async () => {
    const directory = await createDirectory();
    const databasePath = join(directory, "borg.db");
    const firstRuntime = await openStore({ path: databasePath });
    runtimes.push(firstRuntime);
    const fixture = createLegacyCube(firstRuntime);
    const secondClientId = randomUUID();
    firstRuntime.maintenance.createClient({ id: secondClientId, name: "Second owner" });
    firstRuntime.maintenance.grantClientCube({
      clientId: secondClientId,
      cubeId: fixture.cubeId,
      access: "manage",
    });
    const secondRuntime = await openStore({ path: databasePath, migrationMode: "require-current" });
    runtimes.push(secondRuntime);
    const firstRepository = { kind: "local" as const, value: randomUUID() };
    const secondRepository = { kind: "local" as const, value: randomUUID() };

    firstRuntime.forPrincipal(clientPrincipal(fixture.clientId)).associateRepositoryCube({
      cubeId: fixture.cubeId,
      workingRepoName: "legacy",
      repository: firstRepository,
    });
    expect(secondRuntime.forPrincipal(clientPrincipal(secondClientId))
      .associateRepositoryCube({
        cubeId: fixture.cubeId,
        workingRepoName: "legacy",
        repository: secondRepository,
      })).toMatchObject({ cubeId: fixture.cubeId, repository: secondRepository });
    expect(secondRuntime.maintenance.observeAuthorityState().repository_associations).toBe(2);
  });
});

async function legacyCubeFixture(mutationHook?: (phase: string) => void) {
  const directory = await createDirectory();
  const runtime = await openStore({
    path: join(directory, "borg.db"),
    ...(mutationHook === undefined ? {} : { mutationHook }),
  });
  runtimes.push(runtime);
  return { runtime, ...createLegacyCube(runtime) };
}

function createLegacyCube(runtime: StoreRuntime) {
  const clientId = randomUUID();
  const cubeId = randomUUID();
  runtime.maintenance.createClient({ id: clientId, name: "Legacy owner" });
  runtime.maintenance.createCube({
    id: cubeId,
    ownerId: clientId,
    name: "borg-mcp",
    directive: "legacy",
  });
  runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
  return { clientId, cubeId, ...addRequiredRoles(runtime, clientId, cubeId) };
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

async function createDirectory() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-repository-association-")));
  directories.push(directory);
  return directory;
}
