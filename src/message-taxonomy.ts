import type { MessageTaxonomy, MessageTaxonomyClass } from "borgmcp-shared/domain";

export interface RoutingRole {
  readonly id: string;
  readonly name: string;
  readonly is_human_seat: boolean;
}

export interface RoutingDrone {
  readonly id: string;
  readonly label: string;
  readonly role_id: string;
  readonly posture: "observer" | "participant";
}

export interface MessageRouting {
  readonly visibility: "broadcast" | "direct";
  readonly recipientDroneIds: string[];
  readonly routing: {
    readonly class: string | null;
    readonly recipients: string[];
  };
}

export type TaxonomyPatch =
  | { readonly action: "add" | "replace"; readonly classDef: MessageTaxonomyClass }
  | { readonly action: "remove"; readonly className: string };

const MAX_TAXONOMY_CLASSES = 50;
const MAX_LIST_ITEMS = 100;
const MAX_NAME_LENGTH = 120;

export function validateMessageTaxonomy(value: unknown): MessageTaxonomy | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_TAXONOMY_CLASSES) {
    throw new TypeError("Message taxonomy must be null or an array of at most 50 classes.");
  }
  const classes = new Set<string>();
  const prefixes = new Set<string>();
  return value.map((candidate) => {
    const record = taxonomyObject(candidate);
    exactTaxonomyKeys(record);
    const className = boundedTaxonomyString(record["class"], "Taxonomy class", 64);
    const classKey = normalize(className);
    if (classes.has(classKey)) throw new TypeError("Message taxonomy class names must be unique.");
    classes.add(classKey);
    const classPrefixes = taxonomyStringArray(record["prefixes"], "Taxonomy prefixes", 64);
    for (const prefix of classPrefixes) {
      const key = normalize(prefix);
      if (prefixes.has(key)) throw new TypeError("Message taxonomy prefixes must be unique.");
      prefixes.add(key);
    }
    const lifecycle = record["lifecycle"];
    if (lifecycle !== undefined && lifecycle !== "dispatch" && lifecycle !== "completion") {
      throw new TypeError("Message taxonomy lifecycle must be dispatch or completion.");
    }
    return {
      class: className,
      prefixes: classPrefixes,
      ...(lifecycle === undefined ? {} : { lifecycle }),
    };
  });
}

export function patchMessageTaxonomy(
  taxonomy: MessageTaxonomy | null,
  patch: TaxonomyPatch,
): MessageTaxonomy | null {
  const current = taxonomy ?? [];
  if (patch.action === "remove") {
    const index = classIndex(current, patch.className);
    if (index < 0) throw new TypeError("Message taxonomy class does not exist.");
    const next = [...current.slice(0, index), ...current.slice(index + 1)];
    return next.length === 0 ? null : validateMessageTaxonomy(next);
  }
  const validated = validateMessageTaxonomy([patch.classDef])![0]!;
  const index = classIndex(current, validated.class);
  if (patch.action === "add") {
    if (index >= 0) throw new TypeError("Message taxonomy class already exists.");
    return validateMessageTaxonomy([...current, validated]);
  }
  if (index < 0) throw new TypeError("Message taxonomy class does not exist.");
  return validateMessageTaxonomy([
    ...current.slice(0, index),
    validated,
    ...current.slice(index + 1),
  ]);
}

export function resolveMessageRouting(
  input: {
    readonly message: string;
    readonly className?: string;
    readonly to: "broadcast" | readonly string[];
  },
  taxonomy: MessageTaxonomy | null,
  roles: readonly RoutingRole[],
  drones: readonly RoutingDrone[],
): MessageRouting {
  const className = input.className ?? classifyMessage(taxonomy, input.message)?.class ?? null;
  if (input.to === "broadcast") return routingResult("broadcast", [], className);
  return routingResult("direct", resolveSelectors(input.to, roles, drones), className);
}

function resolveSelectors(
  selectors: readonly string[],
  roles: readonly RoutingRole[],
  drones: readonly RoutingDrone[],
): string[] {
  if (selectors.length === 0) throw new TypeError("Direct recipients cannot be empty.");
  const recipients = new Set<string>();
  for (const selector of selectors) {
    for (const drone of resolveSelector(selector, roles, drones)) recipients.add(drone.id);
  }
  return [...recipients];
}

function resolveSelector(
  selector: string,
  roles: readonly RoutingRole[],
  allDrones: readonly RoutingDrone[],
): RoutingDrone[] {
  const drones = allDrones.filter((drone) => drone.posture === "participant");
  if (selector === "@human-seat") {
    const roleIds = new Set(roles.filter((role) => role.is_human_seat).map((role) => role.id));
    const matches = drones.filter((drone) => roleIds.has(drone.role_id));
    if (matches.length === 0) throw new TypeError("Recipient has no active drone.");
    return matches;
  }
  const exact = drones.filter((drone) => drone.id === selector || drone.label === selector);
  if (exact.length === 1) return exact;
  if (exact.length > 1) throw new TypeError("Recipient is ambiguous.");

  const shortId = selector.replace(/^`|`$/gu, "").replace(/^id:/iu, "");
  if (/^[0-9a-f]{8,}$/iu.test(shortId)) {
    const matches = drones.filter((drone) => drone.id.toLowerCase().startsWith(shortId.toLowerCase()));
    if (matches.length === 1) return matches;
    if (matches.length > 1) throw new TypeError("Recipient is ambiguous.");
  }

  const matchingRoles = roles.filter((role) => roleSlug(role.name) === roleSlug(selector));
  if (matchingRoles.length > 1) throw new TypeError("Recipient role is ambiguous.");
  if (matchingRoles.length === 1) {
    const matches = drones.filter((drone) => drone.role_id === matchingRoles[0]!.id);
    if (matches.length === 0) throw new TypeError("Recipient role has no active drone.");
    return matches;
  }
  throw new TypeError("Recipient does not exist.");
}

function classifyMessage(taxonomy: MessageTaxonomy | null, message: string): MessageTaxonomyClass | null {
  if (taxonomy === null) return null;
  const token = message.split(/[:\s]/u, 1)[0] ?? "";
  const key = normalize(token);
  return taxonomy.find((entry) => (entry.prefixes ?? []).some((prefix) => normalize(prefix) === key)) ?? null;
}

function routingResult(
  visibility: "broadcast" | "direct",
  recipientDroneIds: string[],
  className: string | null,
): MessageRouting {
  return {
    visibility,
    recipientDroneIds,
    routing: { class: className, recipients: recipientDroneIds },
  };
}

function taxonomyObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Message taxonomy classes must be objects.");
  }
  return value as Record<string, unknown>;
}

function exactTaxonomyKeys(record: Record<string, unknown>): void {
  const allowed = new Set(["class", "prefixes", "lifecycle"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new TypeError("Message taxonomy class contains an unknown field.");
  }
}

function boundedTaxonomyString(value: unknown, label: string, maxLength = MAX_NAME_LENGTH): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} must be non-empty bounded text.`);
  }
  return value.trim();
}

function taxonomyStringArray(value: unknown, label: string, maxLength = MAX_NAME_LENGTH): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new TypeError(`${label} must be a bounded array.`);
  }
  const entries = value.map((entry) => boundedTaxonomyString(entry, label, maxLength));
  if (new Set(entries.map(normalize)).size !== entries.length) {
    throw new TypeError(`${label} must contain unique values.`);
  }
  return entries;
}

function classIndex(taxonomy: MessageTaxonomy, className: string): number {
  const key = normalize(className);
  return taxonomy.findIndex((entry) => normalize(entry.class) === key);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function roleSlug(value: string): string {
  return value.toLowerCase().replace(/[\s_]+/gu, "-").replace(/[^a-z0-9-]/gu, "");
}
