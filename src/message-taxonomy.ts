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
    readonly fellOpen: boolean;
    readonly message: string | null;
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
    const routing = record["routing"];
    if (routing !== "broadcast" && routing !== "directed") {
      throw new TypeError("Message taxonomy routing must be broadcast or directed.");
    }
    const classPrefixes = taxonomyStringArray(record["prefixes"], "Taxonomy prefixes", 64);
    for (const prefix of classPrefixes) {
      const key = normalize(prefix);
      if (prefixes.has(key)) throw new TypeError("Message taxonomy prefixes must be unique.");
      prefixes.add(key);
    }
    const defaultTo = taxonomyStringArray(record["default_to"], "Taxonomy default recipients");
    if (routing === "directed" && defaultTo.length === 0) {
      throw new TypeError("Directed taxonomy classes require default recipients.");
    }
    const lifecycle = record["lifecycle"];
    if (lifecycle !== undefined && lifecycle !== "dispatch" && lifecycle !== "completion") {
      throw new TypeError("Message taxonomy lifecycle must be dispatch or completion.");
    }
    return {
      class: className,
      prefixes: classPrefixes,
      routing,
      ...(defaultTo.length === 0 ? {} : { default_to: defaultTo }),
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
    readonly visibility?: "broadcast" | "direct";
    readonly recipientDroneIds?: readonly string[];
    readonly className?: string;
    readonly to?: readonly string[];
  },
  taxonomy: MessageTaxonomy | null,
  roles: readonly RoutingRole[],
  drones: readonly RoutingDrone[],
): MessageRouting {
  if (input.visibility === "broadcast" &&
      ((input.recipientDroneIds?.length ?? 0) > 0 || input.to !== undefined)) {
    throw new TypeError("Broadcast activity cannot name direct recipients.");
  }
  if (input.visibility !== undefined || input.recipientDroneIds !== undefined) {
    const visibility = input.visibility ?? "direct";
    const recipients = visibility === "direct"
      ? input.recipientDroneIds?.length
        ? [...new Set(input.recipientDroneIds)]
        : resolveSelectors(input.to ?? [], roles, drones, true)
      : [];
    if (visibility === "direct" && recipients.length === 0) {
      throw new TypeError("Direct activity requires a recipient.");
    }
    return routingResult(visibility, recipients, null, false, null);
  }

  const explicitClass = input.className === undefined
    ? null
    : taxonomyClass(taxonomy, input.className);
  if (input.className !== undefined && explicitClass === null) {
    throw new TypeError("Message taxonomy class is not declared by this cube.");
  }
  if (input.to !== undefined) {
    const recipients = resolveSelectors(input.to, roles, drones, true);
    return routingResult("direct", recipients, explicitClass?.class ?? null, false, null);
  }
  if (taxonomy === null) return routingResult("broadcast", [], null, false, null);

  const matched = explicitClass ?? classifyMessage(taxonomy, input.message);
  if (matched === null || matched.routing === "broadcast") {
    return routingResult("broadcast", [], matched?.class ?? null, false, null);
  }
  const recipients = resolveSelectors(matched.default_to ?? [], roles, drones, false);
  if (recipients.length === 0) {
    return routingResult(
      "broadcast",
      [],
      matched.class,
      true,
      "No active default recipient resolved; delivered as broadcast.",
    );
  }
  return routingResult("direct", recipients, matched.class, false, null);
}

function resolveSelectors(
  selectors: readonly string[],
  roles: readonly RoutingRole[],
  drones: readonly RoutingDrone[],
  strict: boolean,
): string[] {
  if (strict && selectors.length === 0) throw new TypeError("Direct recipients cannot be empty.");
  const recipients = new Set<string>();
  for (const selector of selectors) {
    try {
      for (const drone of resolveSelector(selector, roles, drones)) recipients.add(drone.id);
    } catch (error) {
      if (strict) throw error;
    }
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

function classifyMessage(taxonomy: MessageTaxonomy, message: string): MessageTaxonomyClass | null {
  const token = message.split(/[:\s]/u, 1)[0] ?? "";
  const key = normalize(token);
  return taxonomy.find((entry) => (entry.prefixes ?? []).some((prefix) => normalize(prefix) === key)) ?? null;
}

function taxonomyClass(
  taxonomy: MessageTaxonomy | null,
  className: string,
): MessageTaxonomyClass | null {
  if (taxonomy === null) return null;
  const key = normalize(className);
  return taxonomy.find((entry) => normalize(entry.class) === key) ?? null;
}

function routingResult(
  visibility: "broadcast" | "direct",
  recipientDroneIds: string[],
  className: string | null,
  fellOpen: boolean,
  message: string | null,
): MessageRouting {
  return {
    visibility,
    recipientDroneIds,
    routing: { class: className, recipients: recipientDroneIds, fellOpen, message },
  };
}

function taxonomyObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Message taxonomy classes must be objects.");
  }
  return value as Record<string, unknown>;
}

function exactTaxonomyKeys(record: Record<string, unknown>): void {
  const allowed = new Set(["class", "prefixes", "routing", "default_to", "lifecycle"]);
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
