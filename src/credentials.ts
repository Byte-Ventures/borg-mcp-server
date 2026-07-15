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
  ScopedStore,
  SeatAttachRecord,
} from "./store.js";
import { operatorErrors } from "./operator-error.js";

const tokenPattern = /^[A-Za-z0-9_-]{43,1024}$/u;
const dummyVerifier = Buffer.alloc(32);
type CredentialPurpose = "recovery" | "invitation" | "client" | "drone-session";

export interface EnrollmentRequest {
  readonly invitation: string;
  readonly clientName?: string;
}

export interface EnrollmentResponse {
  readonly clientId: string;
  readonly credential: string;
  readonly credentialExpiresAt: null;
}

export interface SeatAttachResponse extends SeatAttachRecord {
  readonly credential: string;
}

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

  constructor(
    store: CredentialStore,
    digester: CredentialDigester,
    clock: () => Date = () => new Date(),
    registry = new LiveCredentialRegistry(),
  ) {
    this.#store = store;
    this.#digester = digester;
    this.#clock = clock;
    this.#registry = registry;
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
    return this.#createInvitation(ttlMs);
  }

  createInvitation(recoveryCredential: string, ttlMs: number): string | null {
    const digest = safeDigest(this.#digester, recoveryCredential, "recovery");
    const stored = this.#store.findRecoveryCredential(digest.lookup);
    if (!this.#digester.verify(recoveryCredential, "recovery", stored?.verifier)) return null;
    return this.#createInvitation(ttlMs);
  }

  #createInvitation(ttlMs: number): string {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000) {
      throw new Error("Invitation TTL must be an integer from 1000 to 86400000 milliseconds.");
    }
    const secret = generateSecret();
    this.#store.createInvitation(
      randomUUID(),
      this.#digester.digest(secret, "invitation"),
      new Date(this.#clock().getTime() + ttlMs).toISOString(),
    );
    return secret;
  }

  exchangeInvitation(request: EnrollmentRequest): EnrollmentResponse | null {
    const invitationDigest = safeDigest(this.#digester, request.invitation, "invitation");
    const stored = this.#store.findInvitation(invitationDigest.lookup);
    const verified = this.#digester.verify(
      request.invitation,
      "invitation",
      stored?.verifier,
    );
    if (!verified || stored?.expiresAt === undefined || stored.consumedAt != null ||
        stored.expiresAt <= this.#clock().toISOString()) return null;

    const credential = generateSecret();
    const clientId = randomUUID();
    const consumed = this.#store.consumeInvitation({
      invitationId: stored.id,
      clientId,
      clientName: request.clientName ?? "Local client",
      credentialId: randomUUID(),
      credentialDigest: this.#digester.digest(credential, "client"),
    });
    return consumed ? { clientId, credential, credentialExpiresAt: null } : null;
  }

  authenticate(authorization: string | undefined): Principal | null {
    const result = this.authenticateStatus(authorization);
    return typeof result === "object" ? result : null;
  }

  authenticateStatus(
    authorization: string | undefined,
  ): Principal | "missing" | "invalid" | "revoked" {
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
      if (drone!.revokedAt != null || drone!.expiresAt <= this.#clock().toISOString()) {
        return "revoked";
      }
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
    request: { readonly cubeId: string; readonly roleId: string; readonly retryKey: string },
  ): SeatAttachResponse {
    const credential = generateSecret();
    const record = store.attachSeat({
      ...request,
      droneId: randomUUID(),
      sessionId: randomUUID(),
      credentialId: randomUUID(),
      credentialDigest: this.#digester.digest(credential, "drone-session"),
      expiresAt: new Date(this.#clock().getTime() + 86_400_000).toISOString(),
    });
    for (const sessionId of record.revokedSessionIds) this.#registry.invalidate(sessionId);
    return { ...record, credential };
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
    return secret;
  }

  revokeClient(clientId: string): void {
    if (!this.#store.clientExists(clientId)) throw operatorErrors.CLIENT_NOT_FOUND;
    this.#store.revokeClientCredentials(clientId);
    this.#registry.invalidate(clientId);
  }

  registerLiveSession(principal: string | Principal) {
    if (typeof principal === "string") return this.#registry.register(principal);
    return this.#registry.register(
      principal.kind === "drone-session"
        ? [principal.id, principal.clientId]
        : principal.id,
    );
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
