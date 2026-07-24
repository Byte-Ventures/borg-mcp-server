import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getTemplate } from "borgmcp-shared/templates";

import { CredentialAuthority, CredentialDigester, generateSecret } from "../src/credentials.js";
import {
  PLATFORM_QUEEN_DETAILED_DESCRIPTION,
  PLATFORM_QUEEN_SHORT_DESCRIPTION,
} from "../src/platform-queen.js";
import { clientPrincipal } from "../src/principal.js";
import { StorageCapacityError, openStore, type StoreRuntime } from "../src/store.js";

const directories: string[] = [];
const enrollmentPhases = [
  "enrollment.insert-client",
  "enrollment.insert-credential",
  "enrollment.insert-capability",
  "enrollment.insert-claim",
  "enrollment.consume-invitation",
  "enrollment.claim-owner",
  "enrollment.after-commit",
] as const;
const scopedEnrollmentPhases = [
  "enrollment.insert-client",
  "enrollment.insert-credential",
  "enrollment.insert-grant",
  "enrollment.insert-claim",
  "enrollment.consume-invitation",
  "enrollment.after-commit",
] as const;
const cubePhases = [
  "cube.insert-cube",
  "cube.insert-role",
  "cube.insert-human-role",
  "cube.insert-worker-role",
  "cube.insert-grant",
  "cube.insert-binding",
  "cube.insert-association",
  "cube.after-commit",
] as const;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("owner enrollment and multi-cube creation", () => {
  it.each(enrollmentPhases)("leaves owner enrollment wholly absent or committed after %s", async (phase) => {
    const fixture = await authorityFixture();
    let failAt: string | undefined;
    fixture.runtime.close();
    fixture.digester.destroy();
    const runtime = await openStore({
      path: fixture.path,
      mutationHook: (current) => {
        if (current === failAt) throw new Error(`fault:${current}`);
      },
    });
    const digester = new CredentialDigester(Buffer.alloc(32, 7));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const invitation = authority.createBootstrapInvitation(60_000);
    const credential = generateSecret();
    const request = {
      invitation,
      retryKey: randomUUID(),
      clientCredential: credential,
      clientName: "owner",
    };
    failAt = phase;
    expect(() => authority.exchangeInvitation(request)).toThrow(`fault:${phase}`);
    runtime.close();
    digester.destroy();

    const reopened = await openStore({ path: fixture.path });
    const state = reopened.maintenance.observeAuthorityState();
    if (phase === "enrollment.after-commit") {
      expect(state).toMatchObject({ enrolled_clients: 1, enrollment_claims: 1, server_capabilities: 1 });
    } else {
      expect(state).toMatchObject({ enrolled_clients: 0, enrollment_claims: 0, server_capabilities: 0 });
    }
    reopened.close();
  });

  it.each(scopedEnrollmentPhases)("leaves scoped enrollment wholly absent or committed after %s", async (phase) => {
    const fixture = await authorityFixture();
    const cubeId = randomUUID();
    fixture.runtime.maintenance.createCube({ id: cubeId, name: "Scoped", directive: "" });
    const recovery = fixture.authority.createRecoveryCredential();
    fixture.runtime.close();
    fixture.digester.destroy();
    let failAt: string | undefined;
    const runtime = await openStore({
      path: fixture.path,
      mutationHook: (current) => {
        if (current === failAt) throw new Error(`fault:${current}`);
      },
    });
    const digester = new CredentialDigester(Buffer.alloc(32, 7));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const minted = authority.createCubeInvitation(
      recovery,
      { kind: "id", value: cubeId },
      "read",
      60_000,
    );
    if (minted === null) throw new Error("Scoped invitation creation failed.");
    failAt = phase;
    expect(() => authority.exchangeInvitation({
      invitation: minted.invitation,
      retryKey: randomUUID(),
      clientCredential: generateSecret(),
    })).toThrow(`fault:${phase}`);
    runtime.close();
    digester.destroy();

    const reopened = await openStore({ path: fixture.path });
    const state = reopened.maintenance.observeAuthorityState();
    if (phase === "enrollment.after-commit") {
      expect(state).toMatchObject({ enrolled_clients: 1, enrollment_claims: 1, grants: 1 });
    } else {
      expect(state).toMatchObject({ enrolled_clients: 0, enrollment_claims: 0, grants: 0 });
    }
    reopened.close();
  });

  it.each(cubePhases)("leaves cube creation wholly absent or committed after %s", async (phase) => {
    const fixture = await authorityFixture();
    const credential = generateSecret();
    const enrolled = fixture.authority.exchangeInvitation({
      invitation: fixture.authority.createBootstrapInvitation(60_000),
      retryKey: randomUUID(),
      clientCredential: credential,
    });
    if (enrolled === null) throw new Error("Owner enrollment failed.");
    fixture.runtime.close();
    fixture.digester.destroy();

    const runtime = await openStore({
      path: fixture.path,
      mutationHook: (current) => {
        if (current === phase) throw new Error(`fault:${current}`);
      },
    });
    const digester = new CredentialDigester(Buffer.alloc(32, 7));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const principal = authority.authenticate(`Bearer ${credential}`);
    if (principal === null) throw new Error("Owner authentication failed.");
    expect(() => runtime.forPrincipal(principal).createCube({
      retryKey: randomUUID(),
      name: "Repository",
      workingRepoName: "repository",
      repository: { kind: "local", value: randomUUID() },
      template: "default",
    })).toThrow(`fault:${phase}`);
    runtime.close();
    digester.destroy();

    const reopened = await openStore({ path: fixture.path });
    const state = reopened.maintenance.observeAuthorityState();
    if (phase === "cube.after-commit") {
      expect(state).toMatchObject({
        cubes: 1,
        roles: 2,
        grants: 1,
        cube_create_bindings: 1,
        repository_associations: 1,
        drones: 0,
        drone_sessions: 0,
        drone_session_credentials: 0,
      });
    } else {
      expect(state).toMatchObject({
        cubes: 0,
        roles: 0,
        grants: 0,
        cube_create_bindings: 0,
        repository_associations: 0,
        drones: 0,
        drone_sessions: 0,
        drone_session_credentials: 0,
      });
    }
    reopened.close();
  });

  it("enforces per-client cube quotas without charging exact retries", async () => {
    const fixture = await authorityFixture({ maxCubesPerClient: 1, maxCubesTotal: 2 });
    const credential = generateSecret();
    const enrolled = fixture.authority.exchangeInvitation({
      invitation: fixture.authority.createBootstrapInvitation(60_000),
      retryKey: randomUUID(),
      clientCredential: credential,
    });
    if (enrolled === null) throw new Error("Owner enrollment failed.");
    const principal = fixture.authority.authenticate(`Bearer ${credential}`);
    if (principal === null) throw new Error("Owner authentication failed.");
    const store = fixture.runtime.forPrincipal(principal);
    const request = {
      retryKey: randomUUID(),
      name: "One",
      workingRepoName: "one",
      repository: { kind: "local" as const, value: randomUUID() },
      template: "default" as const,
    };
    const first = store.createCube(request);
    expect(store.createCube(request)).toEqual({ ...first, result: "resolved" });
    expect(store.createCube({
      ...request,
      retryKey: randomUUID(),
      name: "Ignored",
      workingRepoName: "ignored",
      template: "starter",
    })).toEqual({ ...first, result: "resolved" });
    expect(() => store.createCube({
      ...request,
      retryKey: randomUUID(),
      name: "Two",
      workingRepoName: "two",
      repository: { kind: "local", value: randomUUID() },
    }))
      .toThrow(StorageCapacityError);
    expect(fixture.runtime.maintenance.observeAuthorityState()).toMatchObject({
      cubes: 1, roles: 2, grants: 1, cube_create_bindings: 1, repository_associations: 1,
    });
    fixture.runtime.close();
    fixture.digester.destroy();
  });

  it("serializes simultaneous association requests and isolates the identity by client", async () => {
    const fixture = await authorityFixture();
    const credential = generateSecret();
    const enrolled = fixture.authority.exchangeInvitation({
      invitation: fixture.authority.createBootstrapInvitation(60_000),
      retryKey: randomUUID(),
      clientCredential: credential,
    });
    if (enrolled === null) throw new Error("Owner enrollment failed.");
    const principal = fixture.authority.authenticate(`Bearer ${credential}`);
    if (principal === null) throw new Error("Owner authentication failed.");
    const repository = { kind: "local" as const, value: randomUUID() };
    const store = fixture.runtime.forPrincipal(principal);
    const request = {
      name: "Concurrent repository",
      workingRepoName: "concurrent-repository",
      repository,
      template: "default" as const,
    };
    const responses = await Promise.all([
      Promise.resolve().then(() => store.createCube({ ...request, retryKey: randomUUID() })),
      Promise.resolve().then(() => store.createCube({ ...request, retryKey: randomUUID() })),
    ]);
    expect(responses.map((response) => response.result).sort()).toEqual(["created", "resolved"]);
    expect(responses[0]!.cubeId).toBe(responses[1]!.cubeId);
    expect(fixture.runtime.maintenance.observeAuthorityState()).toMatchObject({
      cubes: 1,
      cube_create_bindings: 1,
      repository_associations: 1,
    });

    const otherClientId = randomUUID();
    fixture.runtime.maintenance.createClient({ id: otherClientId, name: "other client" });
    fixture.runtime.maintenance.grantCreateCubeCapability(otherClientId);
    const other = fixture.runtime.forPrincipal(clientPrincipal(otherClientId)).createCube({
      ...request,
      retryKey: randomUUID(),
    });
    expect(other.result).toBe("created");
    expect(other.cubeId).not.toBe(responses[0]!.cubeId);
    expect(fixture.runtime.maintenance.observeAuthorityState()).toMatchObject({
      cubes: 2,
      cube_create_bindings: 2,
      repository_associations: 2,
    });
    fixture.runtime.close();
    fixture.digester.destroy();
  });

  it("creates a generic platform queen-class coordinating seat independently of the cube template", async () => {
    const fixture = await authorityFixture();
    const credential = generateSecret();
    const enrolled = fixture.authority.exchangeInvitation({
      invitation: fixture.authority.createBootstrapInvitation(60_000),
      retryKey: randomUUID(),
      clientCredential: credential,
    });
    if (enrolled === null) throw new Error("Owner enrollment failed.");
    const principal = fixture.authority.authenticate(`Bearer ${credential}`);
    if (principal === null) throw new Error("Owner authentication failed.");

    const store = fixture.runtime.forPrincipal(principal);
    const created = store.createCube({
      retryKey: randomUUID(),
      name: "Any kind of work",
      workingRepoName: "any-kind-of-work",
      repository: { kind: "local", value: randomUUID() },
      template: "default",
    });
    const queen = store.listRoles(created.cubeId).find((role) => role.id === created.humanSeatRoleId);

    expect(queen).toMatchObject({
      short_description: PLATFORM_QUEEN_SHORT_DESCRIPTION,
      detailed_description: PLATFORM_QUEEN_DETAILED_DESCRIPTION,
      is_default: false,
      is_human_seat: true,
      role_class: "queen",
    });
    expect(PLATFORM_QUEEN_DETAILED_DESCRIPTION).not.toMatch(
      /software|code|git|branch|commit|pull request|security review|release quality/i,
    );
    expect(store.listRoles(created.cubeId).filter((role) => role.role_class === "queen")).toHaveLength(1);

    fixture.runtime.close();
    fixture.digester.destroy();
  });

  it.each(["software-dev", "starter"] as const)(
    "seeds every shared %s template surface atomically without creating a seat",
    async (templateName) => {
      const fixture = await authorityFixture();
      const credential = generateSecret();
      const enrolled = fixture.authority.exchangeInvitation({
        invitation: fixture.authority.createBootstrapInvitation(60_000),
        retryKey: randomUUID(),
        clientCredential: credential,
      });
      if (enrolled === null) throw new Error("Owner enrollment failed.");
      const principal = fixture.authority.authenticate(`Bearer ${credential}`);
      if (principal === null) throw new Error("Owner authentication failed.");
      const store = fixture.runtime.forPrincipal(principal);
      const template = getTemplate(templateName);
      if (template === null) throw new Error("Shared template is unavailable.");

      const created = store.createCube({
        retryKey: randomUUID(),
        name: `${template.label} cube`,
        workingRepoName: `${templateName}-repository`,
        repository: { kind: "local", value: randomUUID() },
        template: templateName,
      });

      expect(created).toMatchObject({
        result: "created",
        name: `${template.label} cube`,
        workingRepoName: `${templateName}-repository`,
        template: templateName,
        access: "manage",
      });
      expect(store.getCube(created.cubeId)).toMatchObject({
        directive: template.cube_directive,
        messageTaxonomy: template.message_taxonomy,
      });
      const roles = store.listRoles(created.cubeId);
      expect(roles).toHaveLength(template.roles.length);
      for (const expected of template.roles) {
        expect(roles.find((role) => role.name === expected.name)).toMatchObject({
          short_description: expected.short_description,
          detailed_description: expected.detailed_description,
          is_default: expected.is_default ?? false,
          is_mandatory: expected.is_mandatory ?? false,
          is_human_seat: expected.is_human_seat ?? false,
          can_broadcast: expected.can_broadcast ?? false,
          receives_all_direct: expected.receives_all_direct ?? false,
          role_class: expected.is_human_seat ? "queen" : "worker",
        });
      }
      expect(store.listDrones(created.cubeId)).toEqual([]);
      expect(fixture.runtime.maintenance.observeAuthorityState()).toMatchObject({
        cubes: 1,
        roles: template.roles.length,
        grants: 1,
        cube_create_bindings: 1,
        repository_associations: 1,
        drones: 0,
        drone_sessions: 0,
        drone_session_credentials: 0,
      });
      fixture.runtime.close();
      fixture.digester.destroy();
    },
  );

  it("recovers an ambiguous enrollment response after reopen without storing plaintext secrets", async () => {
    const fixture = await authorityFixture();
    const invitation = fixture.authority.createBootstrapInvitation(60_000);
    const credential = generateSecret();
    const request = {
      invitation,
      retryKey: randomUUID(),
      clientCredential: credential,
      clientName: "owner",
    };
    const initial = fixture.authority.exchangeInvitation(request);
    expect(initial).not.toBeNull();
    fixture.runtime.close();
    fixture.digester.destroy();

    const reopened = await openStore({ path: fixture.path });
    const digester = new CredentialDigester(Buffer.alloc(32, 7));
    const authority = new CredentialAuthority(reopened.credentials, digester);
    expect(authority.exchangeInvitation(request)).toEqual(initial);
    for (const path of [fixture.path, `${fixture.path}-wal`, `${fixture.path}-shm`]) {
      const bytes = await readFile(path).catch(() => Buffer.alloc(0));
      expect(bytes.includes(Buffer.from(invitation))).toBe(false);
      expect(bytes.includes(Buffer.from(credential))).toBe(false);
    }
    reopened.close();
    digester.destroy();
  });
});

async function authorityFixture(cubeLimits?: { maxCubesPerClient: number; maxCubesTotal: number }): Promise<{
  path: string;
  runtime: StoreRuntime;
  digester: CredentialDigester;
  authority: CredentialAuthority;
}> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-owner-enrollment-")));
  directories.push(directory);
  const path = join(directory, "borg.db");
  const runtime = await openStore({ path, ...(cubeLimits === undefined ? {} : { cubeLimits }) });
  const digester = new CredentialDigester(Buffer.alloc(32, 7));
  return { path, runtime, digester, authority: new CredentialAuthority(runtime.credentials, digester) };
}
