const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const principalBrand: unique symbol = Symbol("server-derived-principal");

interface ServerDerivedPrincipal {
  readonly [principalBrand]: true;
}

export interface OperatorPrincipal extends ServerDerivedPrincipal {
  readonly kind: "operator";
  readonly id: string;
}

export interface ClientPrincipal extends ServerDerivedPrincipal {
  readonly kind: "client";
  readonly id: string;
}

export interface DroneSessionPrincipal extends ServerDerivedPrincipal {
  readonly kind: "drone-session";
  readonly id: string;
  readonly clientId: string;
  readonly cubeId: string;
  readonly droneId: string;
}

export interface DroneSessionPrincipalInput {
  readonly id: string;
  readonly clientId: string;
  readonly cubeId: string;
  readonly droneId: string;
}

export type Principal = OperatorPrincipal | ClientPrincipal | DroneSessionPrincipal;

export function operatorPrincipal(id: string): OperatorPrincipal {
  assertCanonicalUuid(id, "Principal id");
  return branded({ kind: "operator", id });
}

export function clientPrincipal(id: string): ClientPrincipal {
  assertCanonicalUuid(id, "Principal id");
  return branded({ kind: "client", id });
}

export function droneSessionPrincipal(
  input: DroneSessionPrincipalInput,
): DroneSessionPrincipal {
  assertCanonicalUuid(input.id, "Principal id");
  assertCanonicalUuid(input.clientId, "Client id");
  assertCanonicalUuid(input.cubeId, "Cube id");
  assertCanonicalUuid(input.droneId, "Drone id");
  return branded({ kind: "drone-session", ...input });
}

export function assertServerDerivedPrincipal(value: Principal): void {
  if (value[principalBrand] !== true || !Object.isFrozen(value)) {
    throw new Error("Principal must be created by the server authentication boundary.");
  }
}

export function assertCanonicalUuid(value: string, label: string): void {
  if (!canonicalUuid.test(value)) {
    throw new Error(`${label} must be a canonical UUID.`);
  }
}

function branded<T extends object>(value: T): T & ServerDerivedPrincipal {
  Object.defineProperty(value, principalBrand, { value: true });
  return Object.freeze(value) as T & ServerDerivedPrincipal;
}
