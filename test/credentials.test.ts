import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CredentialAuthority,
  CredentialDigester,
  generateSecret,
} from "../src/credentials.js";
import { type StoreRuntime, openStore } from "../src/store.js";
import { createDebugLogger } from "../src/debug-log.js";
import { clientPrincipal, droneSessionPrincipal } from "../src/principal.js";

let directory: string;
let runtime: StoreRuntime;
let authority: CredentialAuthority;
let now: Date;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "borg-credentials-")));
  now = new Date("2026-07-14T12:00:00.000Z");
  runtime = await openStore({ path: join(directory, "borg.db"), clock: () => now });
  authority = new CredentialAuthority(
    runtime.credentials,
    new CredentialDigester(Buffer.alloc(32, 7)),
    () => now,
  );
});

afterEach(async () => {
  runtime.close();
  await rm(directory, { recursive: true, force: true });
});

describe("credential authority", () => {
  it("logs only credential lifecycle identifiers through the central projection", () => {
    const lines: string[] = [];
    const debugAuthority = new CredentialAuthority(
      runtime.credentials,
      new CredentialDigester(Buffer.alloc(32, 8)),
      () => now,
      undefined,
      createDebugLogger((line) => lines.push(line)),
    );
    const recovery = debugAuthority.createRecoveryCredential();
    const invitation = debugAuthority.createInvitation(recovery, 60_000)!;
    const clientCredential = generateSecret();
    const retryKey = randomUUID();
    const enrolled = debugAuthority.exchangeInvitation({
      invitation,
      retryKey,
      clientCredential,
      clientName: "secret-client-name",
    });
    expect(enrolled).not.toBeNull();
    debugAuthority.exchangeInvitation({
      invitation: generateSecret(),
      retryKey: randomUUID(),
      clientCredential: generateSecret(),
      clientName: "rejected-secret-name",
    });
    debugAuthority.rotateClient(enrolled!.clientId);
    debugAuthority.revokeClient(enrolled!.clientId);

    const output = lines.join("\n");
    for (const secret of [recovery, invitation, clientCredential, retryKey, "secret-client-name", "rejected-secret-name"]) {
      expect(output).not.toContain(secret);
    }
    expect(lines.map((line) => JSON.parse(line).action)).toEqual([
      "invitation_created",
      "enrollment_accepted",
      "enrollment_rejected",
      "client_rotated",
      "client_revoked",
    ]);
  });

  it("generates independent 256-bit unpadded base64url secrets", () => {
    const first = generateSecret();
    const second = generateSecret();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(second).not.toBe(first);
  });

  it("returns a stable non-secret identity for an exact credential-proven retry", () => {
    const recovery = authority.createRecoveryCredential();
    const invitation = authority.createInvitation(recovery, 60_000);
    if (invitation === null) throw new Error("Recovery authorization failed.");

    const credential = generateSecret();
    const request = {
      invitation,
      retryKey: randomUUID(),
      clientCredential: credential,
      clientName: "operator-laptop",
    };
    const enrolled = authority.exchangeInvitation(request);

    expect(enrolled).toEqual({
      purpose: "client",
      clientId: expect.any(String),
      serverCapabilities: [],
    });
    expect(authority.exchangeInvitation(request)).toEqual(enrolled);
    expect(authority.exchangeInvitation({ ...request, retryKey: randomUUID() })).toBeNull();
    expect(authority.authenticate(`Bearer ${credential}`)).toEqual(
      expect.objectContaining({ kind: "client", id: enrolled?.clientId }),
    );
    expect(authority.authenticate("Bearer invalid")).toBeNull();
    expect(runtime.maintenance.observeAuthorityState()).toMatchObject({ grants: 0 });
  });

  it("rejects expired invitations with the same null result", () => {
    const recovery = authority.createRecoveryCredential();
    const invitation = authority.createInvitation(recovery, 1_000);
    if (invitation === null) throw new Error("Recovery authorization failed.");
    now = new Date("2026-07-14T12:00:01.001Z");

    expect(authority.exchangeInvitation(enrollmentRequest(invitation))).toBeNull();
    expect(authority.exchangeInvitation(enrollmentRequest(generateSecret()))).toBeNull();
  });

  it("rotates and revokes credentials while invalidating active sessions", () => {
    const enrolled = enroll();
    const live = authority.registerLiveSession(enrolled.id);

    const rotated = authority.rotateClient(enrolled.id);

    expect(live.signal.aborted).toBe(true);
    expect(authority.authenticate(`Bearer ${enrolled.credential}`)).toBeNull();
    expect(authority.authenticate(`Bearer ${rotated}`)?.id).toBe(enrolled.id);

    const rotatedLive = authority.registerLiveSession(enrolled.id);
    authority.revokeClient(enrolled.id);
    expect(rotatedLive.signal.aborted).toBe(true);
    expect(authority.authenticate(`Bearer ${rotated}`)).toBeNull();
    expect(() => authority.rotateClient(enrolled.id)).toThrow("Provide an existing active client ID.");
  });

  it("keeps a registered live drone session active as time advances", async () => {
      const clientId = randomUUID();
      const cubeId = randomUUID();
      const roleId = randomUUID();
      const droneId = randomUUID();
      const sessionId = randomUUID();
      runtime.maintenance.createClient({ id: clientId, name: "Expiry client" });
      runtime.maintenance.createCube({ id: cubeId, ownerId: clientId, name: "Expiry cube", directive: "" });
      runtime.maintenance.createRole({ id: roleId, cubeId, name: "Worker" });
      runtime.maintenance.createDrone({ id: droneId, cubeId, roleId, clientId, label: "worker-1" });
      runtime.maintenance.createDroneSession({
        id: sessionId,
        clientId,
        cubeId,
        droneId,
      });
      const live = authority.registerLiveSession(droneSessionPrincipal({
        id: sessionId,
        clientId,
        cubeId,
        droneId,
      }));

      expect(live.signal.aborted).toBe(false);
      now = new Date("2126-07-14T12:00:00.000Z");
      expect(live.signal.aborted).toBe(false);
  });

  it("reuses an existing session without a renewal timer", async () => {
      const clientId = randomUUID();
      const cubeId = randomUUID();
      const roleId = randomUUID();
      runtime.maintenance.createClient({ id: clientId, name: "Renewal client" });
      runtime.maintenance.createCube({ id: cubeId, ownerId: clientId, name: "Renewal cube", directive: "" });
      runtime.maintenance.createRole({ id: roleId, cubeId, name: "Worker" });
      runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
      const parent = clientPrincipal(clientId);
      const sessionCredential = generateSecret();
      const attached = authority.attachSeat(runtime.forPrincipal(parent), {
        cubeId, roleId, sessionCredential,
      });
      const live = authority.registerLiveSession(droneSessionPrincipal({
        id: attached.sessionId,
        clientId,
        cubeId,
        droneId: attached.drone.id,
      }));

      now = new Date("2126-07-14T12:00:00.000Z");
      const renewed = authority.attachSeat(runtime.forPrincipal(parent), {
        cubeId,
        roleId,
        sessionCredential,
        priorDroneId: attached.drone.id,
      });
      expect(renewed).toMatchObject({ result: "reused", sessionId: attached.sessionId });

      expect(live.signal.aborted).toBe(false);
  });

  it("domain-separates keyed lookup and verifier digests", () => {
    const digester = new CredentialDigester(Buffer.alloc(32, 9));
    const secret = generateSecret();

    const invitation = digester.digest(secret, "invitation");
    const client = digester.digest(secret, "client");

    expect(invitation.lookup).not.toEqual(client.lookup);
    expect(invitation.verifier).not.toEqual(client.verifier);
    expect(digester.verify(secret, "invitation", invitation.verifier)).toBe(true);
    expect(digester.verify(secret, "client", invitation.verifier)).toBe(false);
  });

  it("requires the recovery credential to create later invitations", () => {
    const recovery = authority.createRecoveryCredential();
    expect(authority.createInvitation(generateSecret(), 60_000)).toBeNull();
    expect(authority.createInvitation(recovery, 60_000)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("atomically enrolls a client with exactly the invitation cube grant and retries stably", () => {
    const cubeId = randomUUID();
    runtime.maintenance.createCube({ id: cubeId, name: "release-tooling", directive: "" });
    const recovery = authority.createRecoveryCredential();
    const minted = authority.createCubeInvitation(
      recovery,
      { kind: "name", value: "release-tooling" },
      "write",
      60_000,
    );
    if (minted === null) throw new Error("Scoped invitation creation failed.");
    expect(minted).toEqual({
      invitation: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      cubeId,
      cubeName: "release-tooling",
      access: "write",
    });
    const request = enrollmentRequest(minted.invitation);

    const enrolled = authority.exchangeInvitation(request);

    expect(enrolled).toMatchObject({ purpose: "client", serverCapabilities: [] });
    expect(authority.exchangeInvitation(request)).toEqual(enrolled);
    expect(runtime.maintenance.observeAuthorityState()).toMatchObject({
      enrolled_clients: 1,
      enrollment_claims: 1,
      grants: 1,
      server_capabilities: 0,
    });
    const principal = authority.authenticate(`Bearer ${request.clientCredential}`);
    if (principal === null) throw new Error("Scoped client authentication failed.");
    expect(runtime.forPrincipal(principal).listCubes()).toEqual([
      expect.objectContaining({ id: cubeId, name: "release-tooling" }),
    ]);
    expect(() => runtime.forPrincipal(principal).appendActivity(cubeId, "ready")).not.toThrow();
    expect(() => runtime.forPrincipal(principal).updateDirective(cubeId, "admin"))
      .toThrow("Access denied.");
  });

  it("fails a scoped claim without enrollment mutation when its cube was deleted after mint", () => {
    const cubeId = randomUUID();
    runtime.maintenance.createCube({ id: cubeId, name: "temporary", directive: "" });
    const recovery = authority.createRecoveryCredential();
    const minted = authority.createCubeInvitation(
      recovery,
      { kind: "id", value: cubeId },
      "write",
      60_000,
    );
    if (minted === null) throw new Error("Scoped invitation creation failed.");
    const deletion = new DatabaseSync(join(directory, "borg.db"));
    deletion.prepare("DELETE FROM cubes WHERE id = ?").run(cubeId);
    deletion.close();

    expect(authority.exchangeInvitation(enrollmentRequest(minted.invitation))).toBeNull();
    expect(runtime.maintenance.observeAuthorityState()).toMatchObject({
      enrolled_clients: 0,
      enrollment_claims: 0,
      grants: 0,
    });
  });

  it.each(["read", "manage"] as const)("preserves explicit %s invitation access", (access) => {
    const cubeId = randomUUID();
    runtime.maintenance.createCube({ id: cubeId, name: `scope-${access}`, directive: "" });
    const recovery = authority.createRecoveryCredential();
    const minted = authority.createCubeInvitation(
      recovery,
      { kind: "id", value: cubeId },
      access,
      60_000,
    );
    if (minted === null) throw new Error("Scoped invitation creation failed.");
    const request = enrollmentRequest(minted.invitation);
    const enrolled = authority.exchangeInvitation(request);
    if (enrolled === null) throw new Error("Scoped enrollment failed.");
    const principal = authority.authenticate(`Bearer ${request.clientCredential}`);
    if (principal === null) throw new Error("Scoped authentication failed.");
    const scoped = runtime.forPrincipal(principal);

    expect(scoped.listCubes()).toHaveLength(1);
    if (access === "read") {
      expect(() => scoped.appendActivity(cubeId, "denied"))
        .toThrow("The requested resource was not found.");
    } else {
      expect(() => scoped.updateDirective(cubeId, "managed")).not.toThrow();
    }
  });

  it("purpose-binds owner authority and revokes the prior owner epoch on replacement", () => {
    const recovery = authority.createRecoveryCredential();
    const first = authority.createBootstrapInvitation(60_000);
    const replacement = authority.replaceOwnerInvitation(recovery, 60_000);
    if (replacement === null) throw new Error("Owner invitation replacement failed.");
    expect(authority.exchangeInvitation(enrollmentRequest(first))).toBeNull();

    const credential = generateSecret();
    const owner = authority.exchangeInvitation(enrollmentRequest(replacement, credential));
    expect(owner).toEqual({
      purpose: "owner",
      clientId: expect.any(String),
      serverCapabilities: ["create_cube"],
    });
    expect(runtime.maintenance.observeAuthorityState()).toMatchObject({
      enrolled_clients: 1,
      enrollment_claims: 1,
      cubes: 0,
      roles: 0,
      grants: 0,
      server_capabilities: 1,
    });
    expect(() => authority.replaceOwnerInvitation(recovery, 60_000)).toThrow("Access denied.");
  });

  it("keeps rejected invitation states in one timing class", () => {
    const recovery = authority.createRecoveryCredential();
    const revoked = authority.createBootstrapInvitation(60_000);
    if (authority.replaceOwnerInvitation(recovery, 60_000) === null) {
      throw new Error("Owner invitation replacement failed.");
    }
    const expired = authority.createInvitation(recovery, 1_000);
    const consumed = authority.createInvitation(recovery, 60_000);
    if (expired === null || consumed === null) throw new Error("Invitation creation failed.");
    const consumedRequest = enrollmentRequest(consumed);
    expect(authority.exchangeInvitation(consumedRequest)).not.toBeNull();
    now = new Date("2026-07-14T12:00:01.001Z");

    const requests = [
      enrollmentRequest(generateSecret()),
      enrollmentRequest(expired),
      enrollmentRequest(revoked),
      { ...consumedRequest, retryKey: randomUUID(), clientCredential: generateSecret() },
    ] as const;
    for (let iteration = 0; iteration < 200; iteration += 1) {
      for (const request of requests) expect(authority.exchangeInvitation(request)).toBeNull();
    }

    const elapsed = requests.map(() => 0);
    for (let iteration = 0; iteration < 4_000; iteration += 1) {
      const offset = iteration % requests.length;
      for (let index = 0; index < requests.length; index += 1) {
        const requestIndex = (index + offset) % requests.length;
        const startedAt = performance.now();
        authority.exchangeInvitation(requests[requestIndex]!);
        elapsed[requestIndex]! += performance.now() - startedAt;
      }
    }
    expect(Math.max(...elapsed) / Math.min(...elapsed)).toBeLessThan(1.25);
  });
});

function enroll(): { readonly id: string; readonly credential: string } {
  const recovery = authority.createRecoveryCredential();
  const invitation = authority.createInvitation(recovery, 60_000);
  if (invitation === null) throw new Error("Recovery authorization failed.");
  const credential = generateSecret();
  const response = authority.exchangeInvitation(enrollmentRequest(invitation, credential));
  if (response === null) throw new Error("Test enrollment failed.");
  return { id: response.clientId, credential };
}

function enrollmentRequest(invitation: string, clientCredential = generateSecret()) {
  return { invitation, retryKey: randomUUID(), clientCredential };
}
