import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  clientPrincipal,
  droneSessionPrincipal,
  type Principal,
} from "./principal.js";
import type {
  CredentialStore,
  DigestPair,
  InvitationCubeScope,
  ScopedStore,
  SeatAttachRecord,
} from "./store.js";
import { operatorErrors } from "./operator-error.js";
import { disabledDebugLogger, type DebugLogger } from "./debug-log.js";

const tokenPattern = /^[A-Za-z0-9_-]{43,1024}$/u;
const dummyVerifier = Buffer.alloc(32);
type CredentialPurpose = "recovery" | "invitation" | "client" | "drone-session";

export interface EnrollmentRequest {
  readonly invitation: string;
  readonly retryKey: string;
  readonly clientCredential: string;
  readonly clientName?: string;
}

export interface EnrollmentResponse {
  readonly purpose: "owner" | "client";
  readonly clientId: string;
  readonly serverCapabilities: readonly [] | readonly ["create_cube"];
}

export interface CubeInvitationResult extends InvitationCubeScope {
  readonly invitation: string;
}

export type SeatAttachResponse = SeatAttachRecord;

export class CredentialDigester {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("Credential digest key must contain 32 bytes.");
    this.#key = Buffer.from(key);
  }

  digest(secret: string, purpose: CredentialPurpose): DigestPair {
    if (!tokenPattern.test(secret)) throw new Error("Credential must be unpadded base64url.");
    const lookup = createHmac("sha256", this.#key)
      .update(`lookup:${purpose}:`)
      .update(secret)
      .digest()
      .subarray(0, 16);
    const verifier = createHmac("sha256", this.#key)
      .update(`verify:${purpose}:`)
      .update(secret)
      .digest();
    return { lookup, verifier };
  }

  verify(secret: string, purpose: CredentialPurpose, stored?: Buffer): boolean {
    let candidate: Buffer;
    let valid = true;
    try {
      candidate = this.digest(secret, purpose).verifier;
    } catch {
      candidate = dummyVerifier;
      valid = false;
    }
    const expected = stored?.length === 32 ? stored : dummyVerifier;
    return timingSafeEqual(candidate, expected) && stored !== undefined && valid;
  }

  destroy(): void {
    this.#key.fill(0);
  }
}

export class LiveCredentialRegistry {
  readonly #sessions = new Map<string, Set<AbortController>>();
  readonly #keys = new Map<AbortController, readonly string[]>();
  register(identities: string | readonly string[]): {
    readonly signal: AbortSignal;
    readonly release: () => void;
  } {
    const controller = new AbortController();
    const keys = [...new Set(typeof identities === "string" ? [identities] : identities)];
    this.#keys.set(controller, keys);
    for (const key of keys) {
      const sessions = this.#sessions.get(key) ?? new Set<AbortController>();
      sessions.add(controller);
      this.#sessions.set(key, sessions);
    }
    return {
      signal: controller.signal,
      release: () => this.#release(controller),
    };
  }

  invalidate(identity: string): void {
    const sessions = this.#sessions.get(identity);
    if (sessions === undefined) return;
    for (const controller of [...sessions]) {
      this.#release(controller);
      controller.abort();
    }
  }

  activeSessionCount(clientId: string): number {
    return this.#sessions.get(clientId)?.size ?? 0;
  }

  #release(controller: AbortController): void {
    const keys = this.#keys.get(controller);
    if (keys === undefined) return;
    this.#keys.delete(controller);
    for (const key of keys) {
      const sessions = this.#sessions.get(key);
      sessions?.delete(controller);
      if (sessions?.size === 0) this.#sessions.delete(key);
    }
  }

}

export class CredentialAuthority {
  readonly #store: CredentialStore;
  readonly #digester: CredentialDigester;
  readonly #clock: () => Date;
  readonly #registry: LiveCredentialRegistry;
  readonly #debugLogger: DebugLogger;

  constructor(
    store: CredentialStore,
    digester: CredentialDigester,
    clock: () => Date = () => new Date(),
    registry = new LiveCredentialRegistry(),
    debugLogger: DebugLogger = disabledDebugLogger,
  ) {
    this.#store = store;
    this.#digester = digester;
    this.#clock = clock;
    this.#registry = registry;
    this.#debugLogger = debugLogger;
  }

  createRecoveryCredential(): string {
    const secret = generateSecret();
    this.#store.createRecoveryCredential(
      randomUUID(),
      this.#digester.digest(secret, "recovery"),
    );
    return secret;
  }

  createBootstrapInvitation(ttlMs: number): string {
    return this.#createInvitation("owner", ttlMs);
  }

  createInvitation(recoveryCredential: string, ttlMs: number): string | null {
    const digest = safeDigest(this.#digester, recoveryCredential, "recovery");
    const stored = this.#store.findRecoveryCredential(digest.lookup);
    if (!this.#digester.verify(recoveryCredential, "recovery", stored?.verifier)) return null;
    return this.#createInvitation("client", ttlMs);
  }

  createInvitationForOwnerCredential(clientCredential: string, ttlMs: number): string | null {
    const principal = this.authenticate(`Bearer ${clientCredential}`);
    if (principal?.kind !== "client" ||
        !this.#store.clientHasServerCapability(principal.id, "create_cube")) return null;
    return this.#createInvitation("client", ttlMs);
  }

  createCubeInvitation(
    recoveryCredential: string,
    cubeSelector: { readonly kind: "id" | "name"; readonly value: string },
    access: "read" | "write" | "manage",
    ttlMs: number,
  ): CubeInvitationResult | null {
    const digest = safeDigest(this.#digester, recoveryCredential, "recovery");
    const stored = this.#store.findRecoveryCredential(digest.lookup);
    if (!this.#digester.verify(recoveryCredential, "recovery", stored?.verifier)) return null;
    return this.#createInvitation("client", ttlMs, { cubeSelector, access });
  }

  replaceOwnerInvitation(recoveryCredential: string, ttlMs: number): string | null {
    const digest = safeDigest(this.#digester, recoveryCredential, "recovery");
    const stored = this.#store.findRecoveryCredential(digest.lookup);
    if (!this.#digester.verify(recoveryCredential, "recovery", stored?.verifier)) return null;
    return this.#createInvitation("owner", ttlMs);
  }

  #createInvitation(purpose: "owner" | "client", ttlMs: number): string;
  #createInvitation(
    purpose: "client",
    ttlMs: number,
    scoped: {
      readonly cubeSelector: { readonly kind: "id" | "name"; readonly value: string };
      readonly access: "read" | "write" | "manage";
    },
  ): CubeInvitationResult;
  #createInvitation(
    purpose: "owner" | "client",
    ttlMs: number,
    scoped?: {
      readonly cubeSelector: { readonly kind: "id" | "name"; readonly value: string };
      readonly access: "read" | "write" | "manage";
    },
  ): string | CubeInvitationResult {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000) {
      throw new Error("Invitation TTL must be an integer from 1000 to 86400000 milliseconds.");
    }
    const secret = generateSecret();
    const scope = this.#store.createInvitation({
      id: randomUUID(),
      digest: this.#digester.digest(secret, "invitation"),
      expiresAt: new Date(this.#clock().getTime() + ttlMs).toISOString(),
      purpose,
      ...(scoped === undefined ? {} : scoped),
    });
    this.#debugLogger.emit({
      event: "credential",
      action: "invitation_created",
      purpose,
      ...(scope === null ? {} : { cubeId: scope.cubeId }),
    });
    return scope === null ? secret : { invitation: secret, ...scope };
  }

  exchangeInvitation(request: EnrollmentRequest): EnrollmentResponse | null {
    const invitationDigest = safeDigest(this.#digester, request.invitation, "invitation");
    const stored = this.#store.findInvitation(invitationDigest.lookup);
    const verified = this.#digester.verify(
      request.invitation,
      "invitation",
      stored?.verifier,
    );
    const clientId = randomUUID();
    const claimed = this.#store.claimInvitation({
      invitationId: stored?.id ?? "00000000-0000-4000-8000-000000000000",
      clientId,
      requestedClientName: request.clientName ?? null,
      retryKey: request.retryKey,
      credentialId: randomUUID(),
      credentialDigest: safeDigest(this.#digester, request.clientCredential, "client"),
    });
    const result = !verified || stored?.expiresAt === undefined || claimed === null ? null : {
      purpose: claimed.purpose,
      clientId: claimed.clientId,
      serverCapabilities: claimed.serverCapabilities,
    };
    this.#debugLogger.emit(result === null
      ? { event: "credential", action: "enrollment_rejected" }
      : {
          event: "credential",
          action: "enrollment_accepted",
          purpose: result.purpose,
          clientId: result.clientId,
        });
    return result;
  }

  authenticate(authorization: string | undefined): Principal | null {
    const result = this.authenticateStatus(authorization);
    return typeof result === "object" ? result : null;
  }

  authenticateStatus(
    authorization: string | undefined,
  ): Principal | "missing" | "invalid" | "revoked" | "evicted" | "rejected" {
    if (authorization === undefined) return "missing";
    const secret = bearerSecret(authorization);
    const clientDigest = safeDigest(this.#digester, secret, "client");
    const droneDigest = safeDigest(this.#digester, secret, "drone-session");
    const client = this.#store.findClientCredential(clientDigest.lookup);
    const drone = this.#store.findDroneSessionCredential(droneDigest.lookup);
    const clientValid = this.#digester.verify(secret, "client", client?.verifier) &&
      client?.clientId !== undefined;
    const droneValid = this.#digester.verify(secret, "drone-session", drone?.verifier) &&
      drone !== null;
    if (clientValid) {
      if (client!.revokedAt != null) return "revoked";
      return clientPrincipal(client!.clientId!);
    }
    if (droneValid) {
      if (drone!.evictedAt !== null) return "evicted";
      if (drone!.revokedAt != null) return "revoked";
      if (drone!.takenOver) return "rejected";
      return droneSessionPrincipal({
        id: drone!.sessionId,
        clientId: drone!.clientId,
        cubeId: drone!.cubeId,
        droneId: drone!.droneId,
      });
    }
    return "invalid";
  }

  attachSeat(
    store: ScopedStore,
    request: {
      readonly cubeId: string;
      readonly roleId: string;
      readonly sessionCredential: string;
      readonly priorDroneId?: string;
    },
  ): SeatAttachResponse {
    const record = store.attachSeat({
      cubeId: request.cubeId,
      roleId: request.roleId,
      ...(request.priorDroneId === undefined ? {} : { priorDroneId: request.priorDroneId }),
      droneId: randomUUID(),
      sessionId: randomUUID(),
      credentialId: randomUUID(),
      credentialDigest: this.#digester.digest(request.sessionCredential, "drone-session"),
    });
    if (record.result === "created") {
      this.#debugLogger.emit({
        event: "credential",
        action: "session_created",
        sessionId: record.sessionId,
        cubeId: record.cube.id,
        droneId: record.drone.id,
      });
    }
    return record;
  }

  rotateClient(clientId: string): string {
    if (!this.#store.clientIsActive(clientId)) throw operatorErrors.CLIENT_NOT_FOUND;
    const secret = generateSecret();
    const rotated = this.#store.rotateClientCredential({
      clientId,
      credentialId: randomUUID(),
      credentialDigest: this.#digester.digest(secret, "client"),
    });
    if (!rotated) throw operatorErrors.CLIENT_NOT_FOUND;
    this.#registry.invalidate(clientId);
    this.#debugLogger.emit({ event: "credential", action: "client_rotated", clientId });
    return secret;
  }

  revokeClient(clientId: string): void {
    if (!this.#store.clientExists(clientId)) throw operatorErrors.CLIENT_NOT_FOUND;
    this.#store.revokeClientCredentials(clientId);
    this.#registry.invalidate(clientId);
    this.#debugLogger.emit({ event: "credential", action: "client_revoked", clientId });
  }

  registerLiveSession(principal: string | Principal) {
    if (typeof principal === "string") return this.#registry.register(principal);
    if (principal.kind !== "drone-session") return this.#registry.register(principal.id);
    return this.#registry.register([principal.id, principal.clientId]);
  }
}

export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

function bearerSecret(authorization: string | undefined): string {
  if (authorization === undefined) return "";
  const match = /^Bearer ([A-Za-z0-9_-]{43,1024})$/u.exec(authorization);
  return match?.[1] ?? "";
}

function safeDigest(
  digester: CredentialDigester,
  secret: string,
  purpose: CredentialPurpose,
): DigestPair {
  try {
    return digester.digest(secret, purpose);
  } catch {
    return { lookup: Buffer.alloc(16), verifier: dummyVerifier };
  }
}
