import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CredentialAuthority,
  CredentialDigester,
  generateSecret,
} from "../src/credentials.js";
import { type StoreRuntime, openStore } from "../src/store.js";

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
