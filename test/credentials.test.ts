import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("persists the owner's invitation label instead of the enrolling client's hint", () => {
    const recovery = authority.createRecoveryCredential();
    const invitation = authority.createInvitation(recovery, 60_000, "Alice laptop");
    if (invitation === null) throw new Error("Recovery authorization failed.");

    const enrolled = authority.exchangeInvitation({
      ...enrollmentRequest(invitation),
      clientName: "Far end self description",
    });
    if (enrolled === null) throw new Error("Test enrollment failed.");

    const database = new DatabaseSync(join(directory, "borg.db"));
    try {
      expect(database.prepare("SELECT name FROM clients WHERE id = ?").get(enrolled.clientId))
        .toEqual({ name: "Alice laptop" });
      expect(database.prepare(`
        SELECT requested_client_name FROM enrollment_claims WHERE client_id = ?
      `).get(enrolled.clientId)).toEqual({ requested_client_name: "Far end self description" });
    } finally {
      database.close();
    }
  });

  it("gives separate unnamed invitations distinct client names", () => {
    const recovery = authority.createRecoveryCredential();
    const firstInvitation = authority.createInvitation(recovery, 60_000);
    const secondInvitation = authority.createInvitation(recovery, 60_000);
    if (firstInvitation === null || secondInvitation === null) {
      throw new Error("Recovery authorization failed.");
    }

    const first = authority.exchangeInvitation(enrollmentRequest(firstInvitation));
    const second = authority.exchangeInvitation(enrollmentRequest(secondInvitation));
    if (first === null || second === null) throw new Error("Test enrollment failed.");

    const database = new DatabaseSync(join(directory, "borg.db"));
    try {
      const rows = database.prepare(`
        SELECT name FROM clients WHERE id IN (?, ?) ORDER BY id
      `).all(first.clientId, second.clientId) as Array<{ readonly name: string }>;
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.name)).size).toBe(2);
      expect(rows.map((row) => row.name)).not.toContain("Local client");
    } finally {
      database.close();
    }
  });

  it("validates client labels at mint and leaves owner-purpose invitations unlabeled", () => {
    const recovery = authority.createRecoveryCredential();
    expect(() => authority.createInvitation(recovery, 60_000, "\u001b]8;;unsafe"))
      .toThrow("Presentation name is invalid.");
    expect(() => authority.createInvitation(recovery, 60_000, "a".repeat(121)))
      .toThrow("Presentation name is invalid.");

    authority.createBootstrapInvitation(60_000);
    expect(authority.createInvitation(recovery, 60_000, "Alice laptop")).not.toBeNull();

    const database = new DatabaseSync(join(directory, "borg.db"));
    try {
      expect(database.prepare(`
        SELECT purpose, client_name FROM enrollment_invitations ORDER BY rowid
      `).all()).toEqual([
        { purpose: "owner", client_name: null },
        { purpose: "client", client_name: "Alice laptop" },
      ]);
    } finally {
      database.close();
    }
  });

  it("refuses a label already held by an active client at mint", () => {
    const recovery = authority.createRecoveryCredential();
    const invitation = authority.createInvitation(recovery, 60_000, "Alice laptop");
    if (invitation === null) throw new Error("Recovery authorization failed.");
    const enrolled = authority.exchangeInvitation(enrollmentRequest(invitation));
    if (enrolled === null) throw new Error("Test enrollment failed.");

    expect(() => authority.createInvitation(recovery, 60_000, "Alice laptop"))
      .toThrow(
        "A client with this name already exists. Choose another name, or revoke the existing client before reusing it.",
      );

    authority.revokeClient(enrolled.clientId);
    expect(authority.createInvitation(recovery, 60_000, "Alice laptop")).not.toBeNull();
  });

  it("refuses a label held by an outstanding invitation at mint", () => {
    const recovery = authority.createRecoveryCredential();
    expect(authority.createInvitation(recovery, 1_000, "Alice laptop")).not.toBeNull();

    expect(() => authority.createInvitation(recovery, 60_000, "Alice laptop"))
      .toThrow(
        "An unclaimed invitation with this label is outstanding. Choose another name, or wait for it to expire before reusing the label.",
      );

    now = new Date("2026-07-14T12:00:01.001Z");
    expect(authority.createInvitation(recovery, 60_000, "Alice laptop")).not.toBeNull();
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

  it("does not turn legacy invitation scope into a cube grant", () => {
    const cubeId = randomUUID();
    runtime.maintenance.createCube({ id: cubeId, name: "legacy-scope", directive: "" });
    const recovery = authority.createRecoveryCredential();
    const invitation = authority.createInvitation(recovery, 60_000);
    if (invitation === null) throw new Error("Invitation creation failed.");

    const database = new DatabaseSync(join(directory, "borg.db"));
    const columns = database.prepare("PRAGMA table_info(enrollment_invitations)").all()
      .map((row) => (row as { name: string }).name);
    if (!columns.includes("cube_id")) {
      database.exec(`
        ALTER TABLE enrollment_invitations ADD COLUMN cube_id TEXT;
        ALTER TABLE enrollment_invitations ADD COLUMN access TEXT;
      `);
    }
    database.prepare(`
      UPDATE enrollment_invitations SET cube_id = ?, access = 'write'
      WHERE id = (SELECT id FROM enrollment_invitations ORDER BY created_at DESC, id DESC LIMIT 1)
    `).run(cubeId);
    database.close();

    const request = enrollmentRequest(invitation);
    const enrolled = authority.exchangeInvitation(request);
    expect(enrolled).toMatchObject({ purpose: "client", serverCapabilities: [] });
    expect(runtime.maintenance.observeAuthorityState()).toMatchObject({
      enrolled_clients: 1,
      enrollment_claims: 1,
      grants: 0,
    });
    const principal = authority.authenticate(`Bearer ${request.clientCredential}`);
    if (principal === null) throw new Error("Client authentication failed.");
    expect(runtime.forPrincipal(principal).listCubes()).toEqual([]);
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

  it("keeps rejected invitation states on one verification and claim path", () => {
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

    const digester = new CredentialDigester(Buffer.alloc(32, 7));
    const tracedAuthority = new CredentialAuthority(runtime.credentials, digester, () => now);
    const digest = vi.spyOn(digester, "digest");
    const verify = vi.spyOn(digester, "verify");
    const findInvitation = vi.spyOn(runtime.credentials, "findInvitation");
    const claimInvitation = vi.spyOn(runtime.credentials, "claimInvitation");

    for (const request of requests) {
      digest.mockClear();
      verify.mockClear();
      findInvitation.mockClear();
      claimInvitation.mockClear();

      expect(tracedAuthority.exchangeInvitation(request)).toBeNull();
      expect(digest.mock.calls.map(([, purpose]) => purpose)).toEqual([
        "invitation",
        "invitation",
        "client",
      ]);
      expect(verify.mock.calls.map(([, purpose]) => purpose)).toEqual(["invitation"]);
      expect(findInvitation).toHaveBeenCalledOnce();
      expect(claimInvitation).toHaveBeenCalledOnce();
    }
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
