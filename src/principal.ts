const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const principalBrand: unique symbol = Symbol("server-derived-principal");
const derivedPrincipals = new WeakSet<object>();

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

export function assertServerDerivedPrincipal(value: unknown): asserts value is Principal {
  if (typeof value !== "object" || value === null || !derivedPrincipals.has(value)) {
    throw new Error("Principal must be created by the server authentication boundary.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const kind = frozenDataValue(descriptors, "kind");
  const expectedKeys = kind === "drone-session"
    ? ["kind", "id", "clientId", "cubeId", "droneId"]
    : kind === "operator" || kind === "client" ? ["kind", "id"] : [];
  const ownNames = Object.getOwnPropertyNames(value);
  const brand = Object.getOwnPropertyDescriptor(value, principalBrand);
  if (Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value) ||
      !Object.hasOwn(value, principalBrand) || brand?.value !== true || brand.get !== undefined ||
      brand.set !== undefined || brand.enumerable || brand.configurable || brand.writable ||
      Object.getOwnPropertySymbols(value).length !== 1 || ownNames.length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(value, key)) ||
      ownNames.some((key) => !expectedKeys.includes(key)) ||
      expectedKeys.some((key) => frozenDataValue(descriptors, key) === undefined)) {
    throw new Error("Principal must be created by the server authentication boundary.");
  }
  for (const key of expectedKeys.filter((key) => key !== "kind")) {
    if (!canonicalUuid.test(frozenDataValue(descriptors, key)!)) {
      throw new Error("Principal must be created by the server authentication boundary.");
    }
  }
}

export function assertCanonicalUuid(value: string, label: string): void {
  if (!canonicalUuid.test(value)) {
    throw new Error(`${label} must be a canonical UUID.`);
  }
}

function branded<T extends object>(value: T): T & ServerDerivedPrincipal {
  Object.defineProperty(value, principalBrand, { value: true });
  const principal = Object.freeze(value) as T & ServerDerivedPrincipal;
  derivedPrincipals.add(principal);
  return principal;
}

function frozenDataValue(
  descriptors: PropertyDescriptorMap,
  key: string,
): string | undefined {
  const descriptor = descriptors[key];
  return descriptor !== undefined && typeof descriptor.value === "string" &&
    descriptor.get === undefined && descriptor.set === undefined && descriptor.enumerable === true &&
    descriptor.configurable === false && descriptor.writable === false
    ? descriptor.value
    : undefined;
}
