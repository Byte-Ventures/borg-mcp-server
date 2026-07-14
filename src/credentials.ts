import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { clientPrincipal, type ClientPrincipal } from "./principal.js";
import type { CredentialStore, DigestPair } from "./store.js";

const tokenPattern = /^[A-Za-z0-9_-]{43,1024}$/u;
const dummyVerifier = Buffer.alloc(32);

export interface EnrollmentRequest {
  readonly invitation: string;
  readonly clientName?: string;
}

export interface EnrollmentResponse {
  readonly clientId: string;
  readonly credential: string;
  readonly credentialExpiresAt: null;
}

export class CredentialDigester {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("Credential digest key must contain 32 bytes.");
    this.#key = Buffer.from(key);
  }

  digest(secret: string, purpose: "recovery" | "invitation" | "client"): DigestPair {
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

  verify(secret: string, purpose: "recovery" | "invitation" | "client", stored?: Buffer): boolean {
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

  register(clientId: string): { readonly signal: AbortSignal; readonly release: () => void } {
    const controller = new AbortController();
    const sessions = this.#sessions.get(clientId) ?? new Set<AbortController>();
    sessions.add(controller);
    this.#sessions.set(clientId, sessions);
    return {
      signal: controller.signal,
      release: () => {
        sessions.delete(controller);
        if (sessions.size === 0) this.#sessions.delete(clientId);
      },
    };
  }

  invalidate(clientId: string): void {
    const sessions = this.#sessions.get(clientId);
    if (sessions === undefined) return;
    for (const controller of sessions) controller.abort();
    this.#sessions.delete(clientId);
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

  authenticate(authorization: string | undefined): ClientPrincipal | null {
    const result = this.authenticateStatus(authorization);
    return typeof result === "object" ? result : null;
  }

  authenticateStatus(
    authorization: string | undefined,
  ): ClientPrincipal | "missing" | "invalid" | "revoked" {
    if (authorization === undefined) return "missing";
    const secret = bearerSecret(authorization);
    const digest = safeDigest(this.#digester, secret, "client");
    const stored = this.#store.findClientCredential(digest.lookup);
    if (!this.#digester.verify(secret, "client", stored?.verifier) ||
        stored?.clientId === undefined) return "invalid";
    if (stored.revokedAt != null) return "revoked";
    return clientPrincipal(stored.clientId);
  }

  rotateClient(clientId: string): string {
    const secret = generateSecret();
    this.#store.rotateClientCredential({
      clientId,
      credentialId: randomUUID(),
      credentialDigest: this.#digester.digest(secret, "client"),
    });
    this.#registry.invalidate(clientId);
    return secret;
  }

  revokeClient(clientId: string): void {
    this.#store.revokeClientCredentials(clientId);
    this.#registry.invalidate(clientId);
  }

  registerLiveSession(clientId: string) {
    return this.#registry.register(clientId);
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
  purpose: "recovery" | "invitation" | "client",
): DigestPair {
  try {
    return digester.digest(secret, purpose);
  } catch {
    return { lookup: Buffer.alloc(16), verifier: dummyVerifier };
  }
}
