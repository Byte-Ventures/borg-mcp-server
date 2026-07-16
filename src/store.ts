import { randomUUID } from "node:crypto";
import { statfsSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { applyMigrations, assertMigrationsCurrent } from "./migrations.js";
import { operatorErrors } from "./operator-error.js";
import {
  assertCanonicalUuid,
  assertServerDerivedPrincipal,
  type Principal,
} from "./principal.js";
import { patchRoleSectionText, type RoleSectionPatchOp } from "./role-section.js";

export type CubeAccess = "read" | "write" | "manage";

export interface CubeRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly directive: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ActivityRecord {
  readonly id: string;
  readonly cubeId: string;
  readonly droneId: string | null;
  readonly actorKind: Principal["kind"];
  readonly actorId: string;
  readonly message: string;
  readonly createdAt: string;
}

export interface LogCursor {
  readonly id: string;
  readonly created_at: string;
}

export interface EnrichedActivityRecord {
  readonly id: string;
  readonly cube_id: string;
  readonly drone_id: string | null;
  readonly message: string;
  readonly visibility: "broadcast" | "direct";
  readonly created_at: string;
  readonly drone_label: string | null;
  readonly role_name: string | null;
  readonly recipient_drone_ids: string[];
}

export interface ClaimRecord {
  readonly log_entry_id: string;
  readonly claimant_drone_id: string;
  readonly claimant_label: string | null;
  readonly claimant_role: string | null;
  readonly claimed_at: string;
  readonly stale: false;
}

export interface ActivityPage {
  readonly entries: EnrichedActivityRecord[];
  readonly cursor: LogCursor | null;
  readonly behind_by: number;
  readonly has_more: boolean;
  readonly claims: ClaimRecord[];
}

export interface DecisionRecord {
  readonly id: string;
  readonly cube_id: string;
  readonly topic: string;
  readonly decision: string;
  readonly rationale: string | null;
  readonly ratified_by: string | null;
  readonly status: "active" | "superseded" | "removed";
  readonly supersedes: string | null;
  readonly created_at: string;
}

export interface RoleRecord {
  readonly id: string;
  readonly cube_id: string;
  readonly name: string;
  readonly short_description: string;
  readonly detailed_description: string;
  readonly is_default: boolean;
  readonly is_mandatory: boolean;
  readonly is_human_seat: boolean;
  readonly can_broadcast: boolean;
  readonly receives_all_direct: boolean;
  readonly role_class: "queen" | "worker";
  readonly created_at: string;
}

export interface DroneRecord {
  readonly id: string;
  readonly cube_id: string;
  readonly role_id: string;
  readonly label: string;
  readonly last_seen: string;
  readonly hostname: string | null;
  readonly created_at: string;
}

export interface StoreDiagnostics {
  readonly journalMode: string;
  readonly foreignKeys: boolean;
  readonly schemaVersions: number[];
}

export interface OpenStoreOptions {
  readonly path: string;
  readonly clock?: () => Date;
  readonly storageLimits?: StorageLimits;
  readonly capacityProbe?: () => StorageCapacity;
  readonly cubeLimits?: CubeLimits;
  readonly mutationHook?: (phase: string) => void;
  readonly migrationMode?: "apply" | "require-current";
}

export interface CubeLimits {
  readonly maxCubesPerClient: number;
  readonly maxCubesTotal: number;
}

export const DEFAULT_CUBE_LIMITS: CubeLimits = Object.freeze({
  maxCubesPerClient: 100,
  maxCubesTotal: 1_000,
});

export interface StorageLimits {
  readonly maxActivityEntriesPerCube: number;
  readonly maxDatabaseBytes: number;
  readonly minFreeDiskBytes: number;
}

export interface StorageCapacity {
  readonly databaseBytes: number;
  readonly freeDiskBytes: number;
}

export const DEFAULT_STORAGE_LIMITS: StorageLimits = Object.freeze({
  maxActivityEntriesPerCube: 10_000,
  maxDatabaseBytes: 1_073_741_824,
  minFreeDiskBytes: 67_108_864,
});

export interface StoreRuntime {
  readonly forPrincipal: (principal: Principal) => ScopedStore;
  readonly maintenance: MaintenanceStore;
  readonly credentials: CredentialStore;
  readonly diagnostics: () => StoreDiagnostics;
  readonly close: () => void;
}

export interface DigestPair {
  readonly lookup: Buffer;
  readonly verifier: Buffer;
}

export interface StoredSecretDigest extends DigestPair {
  readonly id: string;
  readonly expiresAt?: string;
  readonly consumedAt?: string | null;
  readonly clientId?: string;
  readonly revokedAt?: string | null;
}

export interface StoredInvitationDigest extends StoredSecretDigest {
  readonly purpose: "owner" | "client";
  readonly ownerEpoch: number | null;
  readonly cubeId: string | null;
  readonly access: CubeAccess | null;
}

export interface InvitationCubeScope {
  readonly cubeId: string;
  readonly cubeName: string;
  readonly access: CubeAccess;
}

export class InvitationCubeNotFoundError extends Error {}

export class InvitationCubeAmbiguousError extends Error {
  readonly candidateIds: readonly string[];

  constructor(candidateIds: readonly string[]) {
    super("Cube name is ambiguous.");
    this.candidateIds = Object.freeze([...candidateIds]);
  }
}

export interface EnrollmentClaimResult {
  readonly purpose: "owner" | "client";
  readonly clientId: string;
  readonly serverCapabilities: readonly [] | readonly ["create_cube"];
}

export interface StoredDroneSessionDigest extends StoredSecretDigest {
  readonly sessionId: string;
  readonly clientId: string;
  readonly cubeId: string;
  readonly droneId: string;
  readonly expiresAt: string;
}

export interface CredentialStore {
  readonly createRecoveryCredential: (id: string, digest: DigestPair) => void;
  readonly findRecoveryCredential: (lookup: Buffer) => StoredSecretDigest | null;
  readonly createInvitation: (input: {
    readonly id: string;
    readonly digest: DigestPair;
    readonly expiresAt: string;
    readonly purpose: "owner" | "client";
    readonly cubeSelector?: { readonly kind: "id" | "name"; readonly value: string };
    readonly access?: CubeAccess;
  }) => InvitationCubeScope | null;
  readonly findInvitation: (lookup: Buffer) => StoredInvitationDigest | null;
  readonly claimInvitation: (input: {
    readonly invitationId: string;
    readonly clientId: string;
    readonly requestedClientName: string | null;
    readonly retryKey: string;
    readonly credentialId: string;
    readonly credentialDigest: DigestPair;
  }) => EnrollmentClaimResult | null;
  readonly findClientCredential: (lookup: Buffer) => StoredSecretDigest | null;
  readonly clientExists: (clientId: string) => boolean;
  readonly clientIsActive: (clientId: string) => boolean;
  readonly findDroneSessionCredential: (lookup: Buffer) => StoredDroneSessionDigest | null;
  readonly rotateClientCredential: (input: {
    readonly clientId: string;
    readonly credentialId: string;
    readonly credentialDigest: DigestPair;
  }) => boolean;
  readonly revokeClientCredentials: (clientId: string) => void;
}

export interface ScopedStore {
  readonly createCube: (input: CreateCubeInput) => CreateCubeRecord;
  readonly listCubes: () => CubeRecord[];
  readonly getCube: (cubeId: string) => CubeRecord | null;
  readonly updateDirective: (cubeId: string, directive: string) => void;
  readonly appendActivity: (cubeId: string, message: string) => ActivityRecord;
  readonly readActivity: (cubeId: string, limit: number) => ActivityRecord[];
  readonly listRoles: (cubeId: string) => RoleRecord[];
  readonly createRole: (cubeId: string, input: CreateRoleInput) => RoleRecord;
  readonly updateRole: (cubeId: string, roleId: string, input: UpdateRoleInput) => RoleRecord;
  readonly patchRoleSection: (cubeId: string, roleId: string, input: RoleSectionPatchOp) => RoleRecord;
  readonly listDrones: (cubeId: string) => DroneRecord[];
  readonly appendLog: (cubeId: string, input: {
    readonly message: string;
    readonly visibility?: "broadcast" | "direct";
    readonly recipientDroneIds?: readonly string[];
  }) => EnrichedActivityRecord;
  readonly readLog: (cubeId: string, cursor: LogCursor | null, limit: number) => ActivityPage;
  readonly acknowledge: (cubeId: string, entryId: string, kind: "ack" | "claim") => void;
  readonly recordDecision: (cubeId: string, input: {
    readonly topic: string;
    readonly decision: string;
    readonly rationale?: string;
  }) => DecisionRecord;
  readonly listDecisions: (cubeId: string) => DecisionRecord[];
  readonly subscribeActivity: (
    cubeId: string,
    listener: (entry: EnrichedActivityRecord) => void,
  ) => (() => void);
  readonly attachSeat: (input: SeatAttachInput) => SeatAttachRecord;
}

export interface CreateRoleInput {
  readonly name: string;
  readonly shortDescription?: string;
  readonly detailedDescription?: string;
  readonly isDefault?: boolean;
  readonly isMandatory?: boolean;
  readonly isHumanSeat?: boolean;
  readonly canBroadcast?: boolean;
  readonly receivesAllDirect?: boolean;
}

export interface UpdateRoleInput {
  readonly name?: string;
  readonly shortDescription?: string;
  readonly detailedDescription?: string;
  readonly isDefault?: boolean;
  readonly isMandatory?: boolean;
  readonly isHumanSeat?: boolean;
  readonly canBroadcast?: boolean;
  readonly receivesAllDirect?: boolean;
}

export interface CreateCubeInput {
  readonly retryKey: string;
  readonly name: string;
  readonly template: "default";
}

export interface CreateCubeRecord {
  readonly cubeId: string;
  readonly humanSeatRoleId: string;
  readonly defaultWorkerRoleId: string;
  readonly access: "manage";
}

export interface SeatAttachInput {
  readonly cubeId: string;
  readonly roleId: string;
  readonly retryKey: string;
  readonly priorDroneId?: string;
  readonly droneId: string;
  readonly sessionId: string;
  readonly credentialId: string;
  readonly credentialDigest: DigestPair;
  readonly expiresAt: string;
}

export interface SeatAttachRecord {
  readonly cube: {
    readonly id: string;
    readonly name: string;
  };
  readonly role: {
    readonly id: string;
    readonly name: string;
    readonly role_class: "queen" | "worker";
    readonly is_human_seat: boolean;
  };
  readonly drone: {
    readonly id: string;
    readonly label: string;
  };
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly generation: number;
  readonly reattached: boolean;
  readonly revokedSessionIds: readonly string[];
}

export interface MaintenanceStore {
  readonly createClient: (input: { readonly id: string; readonly name: string }) => void;
  readonly createCube: (input: {
    readonly id: string;
    readonly ownerId?: string;
    readonly name: string;
    readonly directive: string;
  }) => void;
  readonly grantClientCube: (input: {
    readonly clientId: string;
    readonly cubeId: string;
    readonly access: CubeAccess;
  }) => void;
  readonly removeClientCubeGrant: (clientId: string, cubeId: string) => boolean;
  readonly grantCreateCubeCapability: (clientId: string) => void;
  readonly resetAuthorityState: () => void;
  readonly observeAuthorityState: () => {
    readonly enrolled_clients: number;
    readonly enrollment_claims: number;
    readonly cubes: number;
    readonly roles: number;
    readonly grants: number;
    readonly server_capabilities: number;
    readonly cube_create_bindings: number;
  };
  readonly inspectCreatedCube: (clientId: string, record: CreateCubeRecord) => {
    readonly cube_exists: boolean;
    readonly creator_has_grant: boolean;
    readonly grant_count: number;
    readonly role_count: number;
    readonly human_seat_role_matches: boolean;
    readonly default_worker_role_matches: boolean;
  };
  readonly inspectEnrollmentPrincipal: (clientId: string) => {
    readonly active_credential_bindings: number;
  };
  readonly createRole: (input: {
    readonly id: string;
    readonly cubeId: string;
    readonly name: string;
    readonly roleClass?: "queen" | "worker";
    readonly isHumanSeat?: boolean;
  }) => void;
  readonly createDrone: (input: {
    readonly id: string;
    readonly cubeId: string;
    readonly roleId: string;
    readonly clientId: string;
    readonly label: string;
  }) => void;
  readonly createDroneSession: (input: {
    readonly id: string;
    readonly clientId: string;
    readonly cubeId: string;
    readonly droneId: string;
    readonly expiresAt: string;
  }) => void;
  readonly revokeClient: (clientId: string) => void;
  readonly revokeDroneSession: (sessionId: string) => void;
  readonly expireActivityCursor: (cubeId: string, cursor: LogCursor) => void;
}

export class ScopedStoreError extends Error {
  readonly code = "NOT_FOUND";

  constructor() {
    super("The requested resource was not found.");
    this.name = "ScopedStoreError";
  }
}

export class RoleConflictError extends Error {
  readonly code = "ROLE_ALREADY_EXISTS";

  constructor() {
    super("A role with that name already exists.");
    this.name = "RoleConflictError";
  }
}

export class DefaultRoleRequiredError extends Error {
  readonly code = "DEFAULT_ROLE_REQUIRED";

  constructor() {
    super("A cube must retain one default role.");
    this.name = "DefaultRoleRequiredError";
  }
}

export class RoleSectionConflictError extends Error {
  readonly code = "ROLE_SECTION_CONFLICT";

  constructor() {
    super("The role section patch conflicts with the current role text.");
    this.name = "RoleSectionConflictError";
  }
}

export class CursorExpiredError extends Error {
  readonly code = "CURSOR_EXPIRED";

  constructor() {
    super("The activity cursor has expired.");
    this.name = "CursorExpiredError";
  }
}

export class AttachConflictError extends Error {
  readonly code = "ATTACH_CONFLICT";

  constructor() {
    super("The attach request conflicts with an existing attachment.");
    this.name = "AttachConflictError";
  }
}

export class StorageCapacityError extends Error {
  readonly code = "CAPACITY_EXCEEDED";

  constructor() {
    super("Storage capacity is unavailable.");
    this.name = "StorageCapacityError";
  }
}

export class AccessDeniedError extends Error {
  readonly code = "ACCESS_DENIED";
  constructor() { super("Access denied."); this.name = "AccessDeniedError"; }
}

export class CreateCubeConflictError extends Error {
  readonly code = "INVALID_INPUT";
  constructor() { super("The cube creation request conflicts with an existing retry."); this.name = "CreateCubeConflictError"; }
}

interface CubeRow {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly directive: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ActivityRow {
  readonly id: string;
  readonly cube_id: string;
  readonly drone_id: string | null;
  readonly actor_kind: Principal["kind"];
  readonly actor_id: string;
  readonly message: string;
  readonly created_at: string;
}

interface ScopePredicate {
  readonly sql: string;
  readonly parameters: readonly (string | number)[];
}

class StorageCapacityGuard {
  readonly #limits: StorageLimits;
  readonly #probe: () => StorageCapacity;
  readonly #pageSize: number;

  constructor(limits: StorageLimits, probe: () => StorageCapacity, pageSize: number) {
    this.#limits = limits;
    this.#probe = probe;
    this.#pageSize = pageSize;
  }

  assertCanGrow(payloadBytes: number): void {
    try {
      if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) throw new StorageCapacityError();
      const capacity = this.#probe();
      if (capacity === null || typeof capacity !== "object" ||
          !Number.isSafeInteger(capacity.databaseBytes) || capacity.databaseBytes < 0 ||
          !Number.isSafeInteger(capacity.freeDiskBytes) || capacity.freeDiskBytes < 0) {
        throw new StorageCapacityError();
      }
      const page = BigInt(this.#pageSize);
      const content = BigInt(payloadBytes) + (page * 64n);
      const contentPages = (content + page - 1n) / page;
      const newContentBytes = contentPages * page;
      // A transaction may dirty every existing page and write each new page to both DB and WAL.
      const worstCaseGrowth = BigInt(capacity.databaseBytes) + (newContentBytes * 2n);
      const projectedFootprint = BigInt(capacity.databaseBytes) + worstCaseGrowth;
      if (projectedFootprint > BigInt(this.#limits.maxDatabaseBytes) ||
          BigInt(capacity.freeDiskBytes) - worstCaseGrowth < BigInt(this.#limits.minFreeDiskBytes)) {
        throw new StorageCapacityError();
      }
    } catch {
      throw new StorageCapacityError();
    }
  }
}

export async function openStore(options: OpenStoreOptions): Promise<StoreRuntime> {
  const databasePath = await prepareDatabasePath(options.path);
  const storageLimits = options.storageLimits ?? DEFAULT_STORAGE_LIMITS;
  const cubeLimits = options.cubeLimits ?? DEFAULT_CUBE_LIMITS;
  validateStorageLimits(storageLimits);
  validateStorageLimits(cubeLimits);
  const capacityProbe = options.capacityProbe ?? (() => storageCapacity(databasePath));
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  const clock = options.clock ?? (() => new Date());
  try {
    if (options.migrationMode === "require-current") {
      configureExistingDatabase(database);
      assertMigrationsCurrent(database);
    } else {
      configureDatabase(database);
      applyMigrations(database);
    }
  } catch (error) {
    database.close();
    throw error;
  }

  const pageRow = database.prepare("PRAGMA page_size").get();
  if (pageRow === undefined) {
    database.close();
    throw new Error("SQLite page size is unavailable.");
  }
  const capacityGuard = new StorageCapacityGuard(
    storageLimits,
    capacityProbe,
    requiredInteger(pageRow, "page_size"),
  );
  const maintenance = new SqliteMaintenanceStore(database, clock);
  const credentials = new SqliteCredentialStore(database, clock, capacityGuard, options.mutationHook);
  const activityHub = new ActivityHub();
  return Object.freeze({
    forPrincipal: (principal: Principal) => {
      assertServerDerivedPrincipal(principal);
      return new SqliteScopedStore(
        database,
        principal,
        clock,
        activityHub,
        storageLimits,
        capacityGuard,
        cubeLimits,
        options.mutationHook,
      );
    },
    maintenance,
    credentials,
    diagnostics: () => diagnostics(database),
    close: () => database.close(),
  });
}

class SqliteScopedStore implements ScopedStore {
  readonly #database: DatabaseSync;
  readonly #principal: Principal;
  readonly #clock: () => Date;
  readonly #activityHub: ActivityHub;
  readonly #storageLimits: StorageLimits;
  readonly #capacityGuard: StorageCapacityGuard;
  readonly #cubeLimits: CubeLimits;
  readonly #mutationHook: ((phase: string) => void) | undefined;

  constructor(
    database: DatabaseSync,
    principal: Principal,
    clock: () => Date,
    activityHub: ActivityHub,
    storageLimits: StorageLimits,
    capacityGuard: StorageCapacityGuard,
    cubeLimits: CubeLimits,
    mutationHook: ((phase: string) => void) | undefined,
  ) {
    this.#database = database;
    this.#principal = principal;
    this.#clock = clock;
    this.#activityHub = activityHub;
    this.#storageLimits = storageLimits;
    this.#capacityGuard = capacityGuard;
    this.#cubeLimits = cubeLimits;
    this.#mutationHook = mutationHook;
  }

  createCube(input: CreateCubeInput): CreateCubeRecord {
    if (this.#principal.kind !== "client") throw new AccessDeniedError();
    assertCanonicalUuid(input.retryKey, "Cube creation retry key");
    validatePresentationName(input.name);
    if (input.template !== "default") throw new Error("Unsupported cube template.");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const authorized = this.#database.prepare(`
        SELECT 1 FROM clients AS client
        JOIN client_server_capabilities AS capability ON capability.client_id = client.id
        WHERE client.id = ? AND client.revoked_at IS NULL AND capability.capability = 'create_cube'
      `).get(this.#principal.id);
      if (authorized === undefined) throw new AccessDeniedError();
      const existing = this.#database.prepare(`
        SELECT name, template, cube_id, human_seat_role_id, default_worker_role_id
        FROM cube_create_bindings WHERE client_id = ? AND retry_key = ?
      `).get(this.#principal.id, input.retryKey);
      if (existing !== undefined) {
        if (requiredText(existing, "name") !== input.name || requiredText(existing, "template") !== input.template) {
          throw new CreateCubeConflictError();
        }
        const result = createCubeRecord(existing);
        this.#database.exec("COMMIT");
        return result;
      }
      const clientCount = requiredInteger(this.#database.prepare(
        "SELECT COUNT(*) AS count FROM cube_create_bindings WHERE client_id = ?",
      ).get(this.#principal.id)!, "count");
      const totalCount = requiredInteger(this.#database.prepare(
        "SELECT COUNT(*) AS count FROM cubes",
      ).get()!, "count");
      if (clientCount >= this.#cubeLimits.maxCubesPerClient || totalCount >= this.#cubeLimits.maxCubesTotal) {
        throw new StorageCapacityError();
      }
      this.#capacityGuard.assertCanGrow(Buffer.byteLength(input.name) + 16_384);
      const now = this.#now();
      const cubeId = randomUUID();
      const humanSeatRoleId = randomUUID();
      const defaultWorkerRoleId = randomUUID();
      this.#database.prepare(`
        INSERT INTO cubes (id, owner_id, name, directive, created_at, updated_at)
        VALUES (?, ?, ?, '', ?, ?)
      `).run(cubeId, this.#principal.id, input.name, now, now);
      this.#mutationHook?.("cube.insert-cube");
      this.#database.prepare(`
        INSERT INTO roles (
          id, cube_id, name, short_description, detailed_description,
          is_default, is_human_seat, role_class, created_at
        ) VALUES (?, ?, 'Coordinator', 'Human coordination seat', '', 0, 1, 'queen', ?)
      `).run(humanSeatRoleId, cubeId, now);
      this.#mutationHook?.("cube.insert-human-role");
      this.#database.prepare(`
        INSERT INTO roles (
          id, cube_id, name, short_description, detailed_description,
          is_default, is_human_seat, role_class, created_at
        ) VALUES (?, ?, 'Builder', 'Default implementation worker', '', 1, 0, 'worker', ?)
      `).run(defaultWorkerRoleId, cubeId, now);
      this.#mutationHook?.("cube.insert-worker-role");
      this.#database.prepare(`
        INSERT INTO client_cube_grants (client_id, cube_id, access, created_at)
        VALUES (?, ?, 'manage', ?)
      `).run(this.#principal.id, cubeId, now);
      this.#mutationHook?.("cube.insert-grant");
      this.#database.prepare(`
        INSERT INTO cube_create_bindings (
          client_id, retry_key, name, template, cube_id,
          human_seat_role_id, default_worker_role_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.#principal.id, input.retryKey, input.name, input.template, cubeId,
        humanSeatRoleId, defaultWorkerRoleId, now,
      );
      this.#mutationHook?.("cube.insert-binding");
      this.#database.exec("COMMIT");
      this.#mutationHook?.("cube.after-commit");
      return { cubeId, humanSeatRoleId, defaultWorkerRoleId, access: "manage" };
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  listCubes(): CubeRecord[] {
    const scope = this.#scope("read");
    const rows = this.#database.prepare(`
      SELECT c.id, c.owner_id, c.name, c.directive, c.created_at, c.updated_at
      FROM cubes AS c
      WHERE ${scope.sql}
      ORDER BY c.id
    `).all(...scope.parameters);
    return rows.map((row) => cubeRecord(cubeRow(row)));
  }

  getCube(cubeId: string): CubeRecord | null {
    assertCanonicalUuid(cubeId, "Cube id");
    const scope = this.#scope("read");
    const row = this.#database.prepare(`
      SELECT c.id, c.owner_id, c.name, c.directive, c.created_at, c.updated_at
      FROM cubes AS c
      WHERE c.id = ? AND ${scope.sql}
    `).get(cubeId, ...scope.parameters);
    return row === undefined ? null : cubeRecord(cubeRow(row));
  }

  updateDirective(cubeId: string, directive: string): void {
    assertCanonicalUuid(cubeId, "Cube id");
    validateDirective(directive);
    const scope = this.#scope("manage");
    this.#requireCube(cubeId, "manage");
    this.#capacityGuard.assertCanGrow(Buffer.byteLength(directive));
    const result = this.#database.prepare(`
      UPDATE cubes AS c
      SET directive = ?, updated_at = ?
      WHERE c.id = ? AND ${scope.sql}
    `).run(directive, this.#now(), cubeId, ...scope.parameters);
    if (result.changes !== 1) throw new ScopedStoreError();
  }

  appendActivity(cubeId: string, message: string): ActivityRecord {
    const entry = this.appendLog(cubeId, { message });
    const droneId = this.#principal.kind === "drone-session" ? this.#principal.droneId : null;
    return {
      id: entry.id,
      cubeId: entry.cube_id,
      droneId,
      actorKind: this.#principal.kind,
      actorId: this.#principal.id,
      message: entry.message,
      createdAt: entry.created_at,
    };
  }

  readActivity(cubeId: string, limit: number): ActivityRecord[] {
    assertCanonicalUuid(cubeId, "Cube id");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Activity read limit must be an integer from 1 to 500.");
    }
    const scope = this.#scope("read");
    const rows = this.#database.prepare(`
      SELECT l.id, l.cube_id, l.drone_id, l.actor_kind, l.actor_id, l.message, l.created_at
      FROM activity_log AS l
      JOIN cubes AS c ON c.id = l.cube_id
      WHERE c.id = ? AND ${scope.sql}
      ORDER BY l.created_at, l.id
      LIMIT ?
    `).all(cubeId, ...scope.parameters, limit);
    return rows.map((row) => activityRecord(activityRow(row)));
  }

  listRoles(cubeId: string): RoleRecord[] {
    this.#requireCube(cubeId, "read");
    const rows = this.#database.prepare(`
      SELECT id, cube_id, name, short_description, detailed_description,
             is_default, is_mandatory, is_human_seat, can_broadcast,
             receives_all_direct, role_class, created_at
      FROM roles WHERE cube_id = ? ORDER BY name, id
    `).all(cubeId);
    return rows.map(roleRecord);
  }

  createRole(cubeId: string, input: CreateRoleInput): RoleRecord {
    assertCanonicalUuid(cubeId, "Cube id");
    validateRoleName(input.name);
    const shortDescription = input.shortDescription ?? "";
    const detailedDescription = input.detailedDescription ?? "";
    validateRoleShortDescription(shortDescription);
    assertRoleTextWriteAllowed(detailedDescription);
    for (const value of [
      input.isDefault,
      input.isMandatory,
      input.isHumanSeat,
      input.canBroadcast,
      input.receivesAllDirect,
    ]) {
      if (value !== undefined && typeof value !== "boolean") throw new TypeError("Role flags must be boolean.");
    }
    const isDefault = input.isDefault ?? false;
    const isMandatory = input.isMandatory ?? false;
    const isHumanSeat = input.isHumanSeat ?? false;
    const canBroadcast = input.canBroadcast ?? false;
    const receivesAllDirect = input.receivesAllDirect ?? false;
    this.#requireCube(cubeId, "manage");
    this.#capacityGuard.assertCanGrow(
      Buffer.byteLength(input.name) + Buffer.byteLength(shortDescription) +
      Buffer.byteLength(detailedDescription) + 8_192,
    );

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireCube(cubeId, "manage");
      const duplicate = this.#database.prepare(
        "SELECT 1 AS present FROM roles WHERE cube_id = ? AND name = ?",
      ).get(cubeId, input.name);
      if (duplicate !== undefined) throw new RoleConflictError();
      if (isDefault) {
        this.#database.prepare("UPDATE roles SET is_default = 0 WHERE cube_id = ? AND is_default = 1")
          .run(cubeId);
        this.#mutationHook?.("role.demote-default");
      }
      const id = randomUUID();
      this.#database.prepare(`
        INSERT INTO roles (
          id, cube_id, name, short_description, detailed_description,
          is_default, is_mandatory, is_human_seat, can_broadcast,
          receives_all_direct, role_class, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'worker', ?)
      `).run(
        id, cubeId, input.name, shortDescription, detailedDescription,
        booleanInteger(isDefault), booleanInteger(isMandatory), booleanInteger(isHumanSeat),
        booleanInteger(canBroadcast), booleanInteger(receivesAllDirect), this.#now(),
      );
      this.#mutationHook?.("role.insert");
      const row = this.#database.prepare(`
        SELECT id, cube_id, name, short_description, detailed_description,
               is_default, is_mandatory, is_human_seat, can_broadcast,
               receives_all_direct, role_class, created_at
        FROM roles WHERE id = ? AND cube_id = ?
      `).get(id, cubeId);
      if (row === undefined) throw new ScopedStoreError();
      this.#database.exec("COMMIT");
      this.#mutationHook?.("role.after-commit");
      return roleRecord(row);
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  updateRole(cubeId: string, roleId: string, input: UpdateRoleInput): RoleRecord {
    assertCanonicalUuid(cubeId, "Cube id");
    assertCanonicalUuid(roleId, "Role id");
    if (Object.values(input).every((value) => value === undefined)) {
      throw new TypeError("At least one role field is required.");
    }
    if (input.name !== undefined) validateRoleName(input.name);
    if (input.shortDescription !== undefined) validateRoleShortDescription(input.shortDescription);
    if (input.detailedDescription !== undefined && typeof input.detailedDescription !== "string") {
      throw new TypeError("Role detailed description must be text.");
    }
    for (const value of [
      input.isDefault,
      input.isMandatory,
      input.isHumanSeat,
      input.canBroadcast,
      input.receivesAllDirect,
    ]) {
      if (value !== undefined && typeof value !== "boolean") throw new TypeError("Role flags must be boolean.");
    }
    this.#requireCube(cubeId, "manage");
    this.#capacityGuard.assertCanGrow(
      Buffer.byteLength(input.name ?? "") + Buffer.byteLength(input.shortDescription ?? "") +
      Buffer.byteLength(input.detailedDescription ?? "") + 8_192,
    );

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireCube(cubeId, "manage");
      const existingRow = this.#database.prepare(`
        SELECT id, cube_id, name, short_description, detailed_description,
               is_default, is_mandatory, is_human_seat, can_broadcast,
               receives_all_direct, role_class, created_at
        FROM roles WHERE id = ? AND cube_id = ?
      `).get(roleId, cubeId);
      if (existingRow === undefined) throw new ScopedStoreError();
      const existing = roleRecord(existingRow);
      if (input.isDefault === false && existing.is_default) {
        throw new DefaultRoleRequiredError();
      }
      if (input.name !== undefined && input.name !== existing.name) {
        const duplicate = this.#database.prepare(
          "SELECT 1 AS present FROM roles WHERE cube_id = ? AND name = ? AND id <> ?",
        ).get(cubeId, input.name, roleId);
        if (duplicate !== undefined) throw new RoleConflictError();
      }
      if (input.isDefault === true && !existing.is_default) {
        this.#database.prepare("UPDATE roles SET is_default = 0 WHERE cube_id = ? AND is_default = 1")
          .run(cubeId);
        this.#mutationHook?.("role.demote-default");
      }
      const nextDetailedDescription = input.detailedDescription ?? existing.detailed_description;
      assertRoleTextWriteAllowed(nextDetailedDescription, existing.detailed_description);
      this.#database.prepare(`
        UPDATE roles SET
          name = ?, short_description = ?, detailed_description = ?, is_default = ?,
          is_mandatory = ?, is_human_seat = ?, can_broadcast = ?, receives_all_direct = ?
        WHERE id = ? AND cube_id = ?
      `).run(
        input.name ?? existing.name,
        input.shortDescription ?? existing.short_description,
        nextDetailedDescription,
        booleanInteger(input.isDefault ?? existing.is_default),
        booleanInteger(input.isMandatory ?? existing.is_mandatory),
        booleanInteger(input.isHumanSeat ?? existing.is_human_seat),
        booleanInteger(input.canBroadcast ?? existing.can_broadcast),
        booleanInteger(input.receivesAllDirect ?? existing.receives_all_direct),
        roleId,
        cubeId,
      );
      const row = this.#database.prepare(`
        SELECT id, cube_id, name, short_description, detailed_description,
               is_default, is_mandatory, is_human_seat, can_broadcast,
               receives_all_direct, role_class, created_at
        FROM roles WHERE id = ? AND cube_id = ?
      `).get(roleId, cubeId);
      if (row === undefined) throw new ScopedStoreError();
      this.#database.exec("COMMIT");
      this.#mutationHook?.("role.after-commit");
      return roleRecord(row);
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  patchRoleSection(cubeId: string, roleId: string, input: RoleSectionPatchOp): RoleRecord {
    assertCanonicalUuid(cubeId, "Cube id");
    assertCanonicalUuid(roleId, "Role id");
    this.#requireCube(cubeId, "manage");
    this.#capacityGuard.assertCanGrow(
      Buffer.byteLength(input.heading) +
      ("body" in input ? Buffer.byteLength(input.body) : 0) + 8_192,
    );

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireCube(cubeId, "manage");
      const existingRow = this.#database.prepare(`
        SELECT id, cube_id, name, short_description, detailed_description,
               is_default, is_mandatory, is_human_seat, can_broadcast,
               receives_all_direct, role_class, created_at
        FROM roles WHERE id = ? AND cube_id = ?
      `).get(roleId, cubeId);
      if (existingRow === undefined) throw new ScopedStoreError();
      const existing = roleRecord(existingRow);
      let detailedDescription: string;
      try {
        detailedDescription = patchRoleSectionText(existing.detailed_description, input);
      } catch (error) {
        if (error instanceof TypeError) throw error;
        throw new RoleSectionConflictError();
      }
      assertRoleTextWriteAllowed(detailedDescription, existing.detailed_description);
      this.#database.prepare(
        "UPDATE roles SET detailed_description = ? WHERE id = ? AND cube_id = ?",
      ).run(detailedDescription, roleId, cubeId);
      const row = this.#database.prepare(`
        SELECT id, cube_id, name, short_description, detailed_description,
               is_default, is_mandatory, is_human_seat, can_broadcast,
               receives_all_direct, role_class, created_at
        FROM roles WHERE id = ? AND cube_id = ?
      `).get(roleId, cubeId);
      if (row === undefined) throw new ScopedStoreError();
      this.#database.exec("COMMIT");
      this.#mutationHook?.("role.after-commit");
      return roleRecord(row);
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  listDrones(cubeId: string): DroneRecord[] {
    this.#requireCube(cubeId, "read");
    const rows = this.#database.prepare(`
      SELECT id, cube_id, role_id, label, COALESCE(last_seen, created_at) AS last_seen,
             hostname, created_at
      FROM drones WHERE cube_id = ? AND evicted_at IS NULL ORDER BY label, id
    `).all(cubeId);
    return rows.map(droneRecord);
  }

  appendLog(cubeId: string, input: {
    readonly message: string;
    readonly visibility?: "broadcast" | "direct";
    readonly recipientDroneIds?: readonly string[];
  }): EnrichedActivityRecord {
    assertCanonicalUuid(cubeId, "Cube id");
    if (input.message.length === 0 || Buffer.byteLength(input.message) > 10_240) {
      throw new Error("Activity message must contain 1 to 10240 bytes.");
    }
    const visibility = input.visibility ?? "broadcast";
    if (visibility !== "broadcast" && visibility !== "direct") {
      throw new Error("Unknown activity visibility.");
    }
    const recipients = [...new Set(input.recipientDroneIds ?? [])];
    if (recipients.length > 100 || recipients.some((id) => {
      try { assertCanonicalUuid(id, "Recipient drone id"); return false; } catch { return true; }
    })) {
      throw new Error("Activity recipients must contain at most 100 valid drone ids.");
    }
    if (visibility === "broadcast" && recipients.length !== 0) {
      throw new Error("Broadcast activity cannot name direct recipients.");
    }
    if (visibility === "direct" && recipients.length === 0) {
      throw new Error("Direct activity requires at least one recipient.");
    }

    const scope = this.#scope("write");
    this.#requireCube(cubeId, "write");
    this.#capacityGuard.assertCanGrow(Buffer.byteLength(input.message) + (recipients.length * 128));
    const id = randomUUID();
    const createdAt = this.#nextActivityTimestamp(cubeId);
    const droneId = this.#principal.kind === "drone-session" ? this.#principal.droneId : null;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.#database.prepare(`
        INSERT INTO activity_log (
          id, cube_id, drone_id, actor_kind, actor_id, message, created_at, visibility
        )
        SELECT ?, c.id, ?, ?, ?, ?, ?, ?
        FROM cubes AS c
        WHERE c.id = ? AND ${scope.sql}
      `).run(
        id, droneId, this.#principal.kind, this.#principal.id, input.message,
        createdAt, visibility, cubeId, ...scope.parameters,
      );
      if (inserted.changes !== 1) throw new ScopedStoreError();
      if (recipients.length > 0) {
        const valid = this.#database.prepare(`
          SELECT COUNT(*) AS count FROM drones
          WHERE cube_id = ? AND evicted_at IS NULL
            AND id IN (${recipients.map(() => "?").join(", ")})
        `).get(cubeId, ...recipients);
        if (valid === undefined) throw new Error("Recipient count query returned no row.");
        if (requiredInteger(valid, "count") !== recipients.length) throw new ScopedStoreError();
        const addRecipient = this.#database.prepare(
          "INSERT INTO activity_log_recipients (entry_id, drone_id) VALUES (?, ?)",
        );
        for (const recipient of recipients) addRecipient.run(id, recipient);
      }
      this.#pruneActivity(cubeId);
      this.#database.exec("COMMIT");
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
    const entry = this.#enrichedEntry(cubeId, id);
    this.#activityHub.publish(cubeId, entry);
    return entry;
  }

  readLog(cubeId: string, cursor: LogCursor | null, limit: number): ActivityPage {
    this.#requireCube(cubeId, "read");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Activity read limit must be an integer from 1 to 500.");
    }
    this.#validateCursor(cubeId, cursor);
    const cursorSql = cursor === null
      ? { sql: "1 = 1", parameters: [] as string[] }
      : {
          sql: "(l.created_at > ? OR (l.created_at = ? AND l.id > ?))",
          parameters: [cursor.created_at, cursor.created_at, cursor.id],
        };
    const rows = this.#database.prepare(`
      SELECT l.id
      FROM activity_log AS l
      WHERE l.cube_id = ? AND ${cursorSql.sql}
      ORDER BY l.created_at, l.id
      LIMIT ?
    `).all(cubeId, ...cursorSql.parameters, limit + 1);
    const selected = rows.slice(0, limit);
    const entries = selected.map((row) => this.#enrichedEntry(cubeId, requiredText(row, "id")));
    const nextCursor = entries.length === 0
      ? cursor
      : { id: entries.at(-1)!.id, created_at: entries.at(-1)!.created_at };
    const behind = nextCursor === null ? this.#countAfter(cubeId, null) : this.#countAfter(cubeId, nextCursor);
    return {
      entries,
      cursor: nextCursor,
      behind_by: behind,
      has_more: behind > 0,
      claims: this.#claims(cubeId),
    };
  }

  acknowledge(cubeId: string, entryId: string, kind: "ack" | "claim"): void {
    this.#requireCube(cubeId, "write");
    assertCanonicalUuid(entryId, "Activity entry id");
    if (kind !== "ack" && kind !== "claim") throw new Error("Unknown acknowledgement kind.");
    const exists = this.#database.prepare(
      "SELECT 1 AS present FROM activity_log WHERE id = ? AND cube_id = ?",
    ).get(entryId, cubeId);
    if (exists === undefined) throw new ScopedStoreError();
    this.#capacityGuard.assertCanGrow(512);
    const claimant = this.#principal.kind === "drone-session"
      ? this.#principal.droneId
      : this.#principal.id;
    this.#database.prepare(`
      INSERT OR IGNORE INTO activity_acks (
        entry_id, principal_kind, principal_id, kind, created_at, claimant_drone_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(entryId, this.#principal.kind, this.#principal.id, kind, this.#now(), claimant);
  }

  recordDecision(cubeId: string, input: {
    readonly topic: string;
    readonly decision: string;
    readonly rationale?: string;
  }): DecisionRecord {
    this.#requireCube(cubeId, "manage");
    validateBoundedText(input.topic, "Decision topic", 120);
    validateBoundedText(input.decision, "Decision", 100_000);
    if (input.rationale !== undefined) validateBoundedText(input.rationale, "Decision rationale", 100_000);
    this.#capacityGuard.assertCanGrow(
      Buffer.byteLength(input.topic) + Buffer.byteLength(input.decision) +
      (input.rationale === undefined ? 0 : Buffer.byteLength(input.rationale)),
    );
    const id = randomUUID();
    const now = this.#now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.#database.prepare(`
        SELECT id FROM decisions WHERE cube_id = ? AND topic = ? AND status = 'active'
      `).get(cubeId, input.topic);
      const supersedes = previous === undefined ? null : requiredText(previous, "id");
      if (supersedes !== null) {
        this.#database.prepare("UPDATE decisions SET status = 'superseded' WHERE id = ?")
          .run(supersedes);
      }
      this.#database.prepare(`
        INSERT INTO decisions (
          id, cube_id, topic, decision, rationale, ratified_by, status, supersedes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        id, cubeId, input.topic, input.decision, input.rationale ?? null,
        this.#principal.kind === "drone-session" ? this.#principal.droneId : null,
        supersedes, now,
      );
      this.#database.exec("COMMIT");
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
    return this.#decision(id);
  }

  listDecisions(cubeId: string): DecisionRecord[] {
    this.#requireCube(cubeId, "read");
    return this.#database.prepare(`
      SELECT id, cube_id, topic, decision, rationale, ratified_by, status, supersedes, created_at
      FROM decisions WHERE cube_id = ? AND status = 'active' ORDER BY topic, created_at, id
    `).all(cubeId).map(decisionRecord);
  }

  attachSeat(input: SeatAttachInput): SeatAttachRecord {
    if (this.#principal.kind !== "client") throw new ScopedStoreError();
    assertCanonicalUuid(input.cubeId, "Cube id");
    assertCanonicalUuid(input.roleId, "Role id");
    assertCanonicalUuid(input.retryKey, "Retry key");
    if (input.priorDroneId !== undefined) assertCanonicalUuid(input.priorDroneId, "Prior drone id");
    assertCanonicalUuid(input.droneId, "Drone id");
    assertCanonicalUuid(input.sessionId, "Drone session id");
    assertCanonicalUuid(input.credentialId, "Drone session credential id");
    validateDigest(input.credentialDigest);
    validateTimestamp(input.expiresAt);
    const scope = this.#scope("read");
    const authorizedRole = this.#database.prepare(`
      SELECT 1 FROM cubes AS c JOIN roles AS role ON role.cube_id = c.id
      WHERE c.id = ? AND role.id = ? AND ${scope.sql}
    `).get(input.cubeId, input.roleId, ...scope.parameters);
    if (authorizedRole === undefined) throw new ScopedStoreError();
    this.#capacityGuard.assertCanGrow(4_096);
    const now = this.#now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const roleRow = this.#database.prepare(`
        SELECT c.id AS cube_id, c.name AS cube_name, role.id AS role_id,
               role.name AS role_name, role.role_class, role.is_human_seat
        FROM cubes AS c
        JOIN roles AS role ON role.cube_id = c.id
        WHERE c.id = ? AND role.id = ? AND ${scope.sql}
      `).get(input.cubeId, input.roleId, ...scope.parameters);
      if (roleRow === undefined) throw new ScopedStoreError();

      const retryBinding = this.#database.prepare(`
        SELECT binding.cube_id AS binding_cube_id,
               binding.requested_role_id AS binding_requested_role_id,
               binding.prior_drone_id, drone.id, drone.label,
               drone.attach_generation, drone.evicted_at
        FROM seat_attach_bindings AS binding
        JOIN drones AS drone ON drone.id = binding.drone_id
        WHERE binding.client_id = ? AND binding.retry_key = ?
      `).get(this.#principal.id, input.retryKey);
      let droneId: string;
      let droneLabel: string;
      let reattached: boolean;
      let generation: number;
      if (retryBinding !== undefined) {
        if (optionalText(retryBinding, "evicted_at") != null) throw new ScopedStoreError();
        if (requiredText(retryBinding, "binding_cube_id") !== input.cubeId ||
            requiredText(retryBinding, "binding_requested_role_id") !== input.roleId ||
            nullableText(retryBinding, "prior_drone_id") !== (input.priorDroneId ?? null)) {
          throw new AttachConflictError();
        }
        droneId = requiredText(retryBinding, "id");
        droneLabel = requiredText(retryBinding, "label");
        generation = requiredInteger(retryBinding, "attach_generation") + 1;
        this.#database.prepare(`
          UPDATE drones SET last_seen = ?, attach_generation = ? WHERE id = ?
        `).run(now, generation, droneId);
        reattached = true;
      } else {
        const priorSeat = input.priorDroneId === undefined ? undefined : this.#database.prepare(`
          SELECT id, label, attach_generation
          FROM drones
          WHERE id = ? AND client_id = ? AND cube_id = ? AND evicted_at IS NULL
        `).get(input.priorDroneId, this.#principal.id, input.cubeId);
        if (priorSeat !== undefined) {
          droneId = requiredText(priorSeat, "id");
          droneLabel = requiredText(priorSeat, "label");
          generation = requiredInteger(priorSeat, "attach_generation") + 1;
          this.#database.prepare(`
            UPDATE drones SET last_seen = ?, attach_generation = ? WHERE id = ?
          `).run(now, generation, droneId);
          reattached = true;
        } else {
          droneId = input.droneId;
          droneLabel = seatLabel(requiredText(roleRow, "role_name"), droneId);
          this.#database.prepare(`
            INSERT INTO drones (
              id, cube_id, role_id, client_id, label, created_at, last_seen, retry_key,
              attach_generation
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
          `).run(
            droneId,
            input.cubeId,
            input.roleId,
            this.#principal.id,
            droneLabel,
            now,
            now,
            input.retryKey,
          );
          reattached = false;
          generation = 1;
        }
        this.#database.prepare(`
          INSERT INTO seat_attach_bindings (
            client_id, retry_key, cube_id, requested_role_id, drone_id, prior_drone_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          this.#principal.id, input.retryKey, input.cubeId, input.roleId,
          droneId, input.priorDroneId ?? null, now,
        );
      }

      const oldSessions = this.#database.prepare(
        "SELECT id FROM drone_sessions WHERE drone_id = ? AND client_id = ? AND cube_id = ?",
      ).all(droneId, this.#principal.id, input.cubeId)
        .map((row) => requiredText(row, "id"));
      if (oldSessions.length > 0) {
        const placeholders = oldSessions.map(() => "?").join(", ");
        this.#database.prepare(`
          UPDATE drone_session_credentials SET revoked_at = ?
          WHERE session_id IN (${placeholders}) AND revoked_at IS NULL
        `).run(now, ...oldSessions);
        this.#database.prepare(`
          UPDATE drone_sessions SET revoked_at = ?
          WHERE id IN (${placeholders}) AND revoked_at IS NULL
        `).run(now, ...oldSessions);
      }
      this.#database.prepare(`
        INSERT INTO drone_sessions (
          id, client_id, cube_id, drone_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId,
        this.#principal.id,
        input.cubeId,
        droneId,
        now,
        input.expiresAt,
      );
      this.#database.prepare(`
        INSERT INTO drone_session_credentials (
          id, session_id, lookup_digest, verifier_digest, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.credentialId,
        input.sessionId,
        input.credentialDigest.lookup,
        input.credentialDigest.verifier,
        now,
      );
      const attachedRoleRow = this.#database.prepare(`
        SELECT role.id AS role_id, role.name AS role_name, role.role_class, role.is_human_seat
        FROM roles AS role WHERE role.id = (SELECT role_id FROM drones WHERE id = ?)
      `).get(droneId);
      if (attachedRoleRow === undefined) throw new Error("Attached drone role is unavailable.");
      const roleClass = requiredText(attachedRoleRow, "role_class");
      if (roleClass !== "queen" && roleClass !== "worker") {
        throw new Error("Database contains invalid role class.");
      }
      this.#database.exec("COMMIT");
      return {
        cube: {
          id: requiredText(roleRow, "cube_id"),
          name: requiredText(roleRow, "cube_name"),
        },
        role: {
          id: requiredText(attachedRoleRow, "role_id"),
          name: requiredText(attachedRoleRow, "role_name"),
          role_class: roleClass,
          is_human_seat: requiredInteger(attachedRoleRow, "is_human_seat") === 1,
        },
        drone: { id: droneId, label: droneLabel },
        sessionId: input.sessionId,
        expiresAt: input.expiresAt,
        generation,
        reattached,
        revokedSessionIds: oldSessions,
      };
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  subscribeActivity(cubeId: string, listener: (entry: EnrichedActivityRecord) => void): () => void {
    this.#requireCube(cubeId, "read");
    return this.#activityHub.subscribe(cubeId, listener);
  }

  #requireCube(cubeId: string, access: CubeAccess): void {
    assertCanonicalUuid(cubeId, "Cube id");
    const scope = this.#scope(access);
    const row = this.#database.prepare(`
      SELECT 1 AS present FROM cubes AS c WHERE c.id = ? AND ${scope.sql}
    `).get(cubeId, ...scope.parameters);
    if (row === undefined) throw new ScopedStoreError();
  }

  #nextActivityTimestamp(cubeId: string): string {
    const now = this.#clock().getTime();
    const latest = this.#database.prepare(`
      SELECT created_at FROM activity_log WHERE cube_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(cubeId);
    if (latest === undefined) return new Date(now).toISOString();
    return new Date(Math.max(now, Date.parse(requiredText(latest, "created_at")) + 1)).toISOString();
  }

  #pruneActivity(cubeId: string): void {
    const excess = this.#database.prepare(`
      SELECT id, created_at FROM activity_log WHERE cube_id = ?
      ORDER BY created_at, id
      LIMIT MAX(0, (SELECT COUNT(*) FROM activity_log WHERE cube_id = ?) - ?)
    `).all(cubeId, cubeId, this.#storageLimits.maxActivityEntriesPerCube);
    const expire = this.#database.prepare(`
      INSERT OR IGNORE INTO expired_activity_cursors (cube_id, entry_id, created_at)
      VALUES (?, ?, ?)
    `);
    const remove = this.#database.prepare("DELETE FROM activity_log WHERE cube_id = ? AND id = ?");
    for (const row of excess) {
      const entryId = requiredText(row, "id");
      expire.run(cubeId, entryId, requiredText(row, "created_at"));
      remove.run(cubeId, entryId);
    }
    const staleCursors = this.#database.prepare(`
      SELECT entry_id, created_at FROM expired_activity_cursors WHERE cube_id = ?
      ORDER BY created_at DESC, entry_id DESC LIMIT -1 OFFSET ?
    `).all(cubeId, this.#storageLimits.maxActivityEntriesPerCube);
    const removeCursor = this.#database.prepare(`
      DELETE FROM expired_activity_cursors WHERE cube_id = ? AND entry_id = ? AND created_at = ?
    `);
    for (const row of staleCursors) {
      removeCursor.run(cubeId, requiredText(row, "entry_id"), requiredText(row, "created_at"));
    }
  }

  #validateCursor(cubeId: string, cursor: LogCursor | null): void {
    if (cursor === null) return;
    assertCanonicalUuid(cursor.id, "Activity cursor id");
    validateTimestamp(cursor.created_at);
    const expired = this.#database.prepare(`
      SELECT 1 AS present FROM expired_activity_cursors
      WHERE cube_id = ? AND entry_id = ? AND created_at = ?
    `).get(cubeId, cursor.id, cursor.created_at);
    if (expired !== undefined) throw new CursorExpiredError();
    const valid = this.#database.prepare(`
      SELECT 1 AS present FROM activity_log WHERE cube_id = ? AND id = ? AND created_at = ?
    `).get(cubeId, cursor.id, cursor.created_at);
    if (valid === undefined) throw new ScopedStoreError();
  }

  #countAfter(cubeId: string, cursor: LogCursor | null): number {
    const row = cursor === null
      ? this.#database.prepare(
          "SELECT COUNT(*) AS count FROM activity_log WHERE cube_id = ?",
        ).get(cubeId)
      : this.#database.prepare(`
          SELECT COUNT(*) AS count FROM activity_log
          WHERE cube_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))
        `).get(cubeId, cursor.created_at, cursor.created_at, cursor.id);
    if (row === undefined) throw new Error("Activity count query returned no row.");
    return requiredInteger(row, "count");
  }

  #enrichedEntry(cubeId: string, entryId: string): EnrichedActivityRecord {
    const row = this.#database.prepare(`
      SELECT l.id, l.cube_id, l.drone_id, l.message, l.visibility, l.created_at,
             d.label AS drone_label, r.name AS role_name
      FROM activity_log AS l
      LEFT JOIN drones AS d ON d.id = l.drone_id AND d.cube_id = l.cube_id
      LEFT JOIN roles AS r ON r.id = d.role_id AND r.cube_id = d.cube_id
      WHERE l.cube_id = ? AND l.id = ?
    `).get(cubeId, entryId);
    if (row === undefined) throw new ScopedStoreError();
    const recipientRows = this.#database.prepare(`
      SELECT drone_id FROM activity_log_recipients WHERE entry_id = ? ORDER BY drone_id
    `).all(entryId);
    return enrichedActivityRecord(row, recipientRows.map((recipient) => requiredText(recipient, "drone_id")));
  }

  #claims(cubeId: string): ClaimRecord[] {
    return this.#database.prepare(`
      SELECT acknowledgement.entry_id AS log_entry_id,
             acknowledgement.claimant_drone_id,
             drone.label AS claimant_label,
             role.name AS claimant_role,
             acknowledgement.created_at AS claimed_at
      FROM activity_acks AS acknowledgement
      JOIN activity_log AS entry ON entry.id = acknowledgement.entry_id
      LEFT JOIN drones AS drone ON drone.id = acknowledgement.claimant_drone_id
        AND drone.cube_id = entry.cube_id
      LEFT JOIN roles AS role ON role.id = drone.role_id AND role.cube_id = drone.cube_id
      WHERE entry.cube_id = ? AND acknowledgement.kind = 'claim'
        AND acknowledgement.claimant_drone_id IS NOT NULL
      ORDER BY acknowledgement.created_at, acknowledgement.entry_id,
               acknowledgement.claimant_drone_id
    `).all(cubeId).map(claimRecord);
  }

  #decision(id: string): DecisionRecord {
    const row = this.#database.prepare(`
      SELECT id, cube_id, topic, decision, rationale, ratified_by, status, supersedes, created_at
      FROM decisions WHERE id = ?
    `).get(id);
    if (row === undefined) throw new ScopedStoreError();
    return decisionRecord(row);
  }

  #scope(access: CubeAccess): ScopePredicate {
    if (this.#principal.kind === "operator") return { sql: "1 = 1", parameters: [] };
    if (this.#principal.kind === "client") {
      const allowed = allowedGrantAccess(access);
      const placeholders = allowed.map(() => "?").join(", ");
      return {
        sql: `EXISTS (
          SELECT 1
          FROM clients AS authorized_client
          JOIN client_cube_grants AS grant_row
            ON grant_row.client_id = authorized_client.id
          WHERE authorized_client.id = ?
            AND authorized_client.revoked_at IS NULL
            AND grant_row.cube_id = c.id
            AND grant_row.access IN (${placeholders})
        )`,
        parameters: [this.#principal.id, ...allowed],
      };
    }
    if (access === "manage") return { sql: "0 = 1", parameters: [] };
    const allowed = allowedGrantAccess(access);
    const placeholders = allowed.map(() => "?").join(", ");
    return {
      sql: `EXISTS (
        SELECT 1
        FROM drone_sessions AS authorized_session
        JOIN clients AS authorized_client
          ON authorized_client.id = authorized_session.client_id
        JOIN client_cube_grants AS parent_grant
          ON parent_grant.client_id = authorized_session.client_id
          AND parent_grant.cube_id = authorized_session.cube_id
        JOIN drones AS authorized_drone
          ON authorized_drone.id = authorized_session.drone_id
          AND authorized_drone.client_id = authorized_session.client_id
          AND authorized_drone.cube_id = authorized_session.cube_id
        WHERE authorized_session.id = ?
          AND authorized_session.client_id = ?
          AND authorized_session.cube_id = ?
          AND authorized_session.drone_id = ?
          AND authorized_session.cube_id = c.id
          AND authorized_session.revoked_at IS NULL
          AND authorized_session.expires_at > ?
          AND authorized_client.revoked_at IS NULL
          AND authorized_drone.evicted_at IS NULL
          AND parent_grant.access IN (${placeholders})
      )`,
      parameters: [
        this.#principal.id,
        this.#principal.clientId,
        this.#principal.cubeId,
        this.#principal.droneId,
        this.#now(),
        ...allowed,
      ],
    };
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

class SqliteMaintenanceStore implements MaintenanceStore {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;

  constructor(database: DatabaseSync, clock: () => Date) {
    this.#database = database;
    this.#clock = clock;
  }

  createClient(input: { readonly id: string; readonly name: string }): void {
    assertCanonicalUuid(input.id, "Client id");
    validateName(input.name);
    this.#database.prepare(
      "INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)",
    ).run(input.id, input.name, this.#now());
  }

  createCube(input: {
    readonly id: string;
    readonly ownerId?: string;
    readonly name: string;
    readonly directive: string;
  }): void {
    assertCanonicalUuid(input.id, "Cube id");
    if (input.ownerId !== undefined) assertCanonicalUuid(input.ownerId, "Cube owner id");
    validateName(input.name);
    validateDirective(input.directive);
    const now = this.#now();
    this.#database.prepare(`
      INSERT INTO cubes (id, owner_id, name, directive, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.ownerId ?? "00000000-0000-4000-8000-000000000000",
      input.name,
      input.directive,
      now,
      now,
    );
  }

  grantClientCube(input: {
    readonly clientId: string;
    readonly cubeId: string;
    readonly access: CubeAccess;
  }): void {
    assertCanonicalUuid(input.clientId, "Client id");
    assertCanonicalUuid(input.cubeId, "Cube id");
    if (!(["read", "write", "manage"] as const).includes(input.access)) {
      throw new Error("Unknown cube access grant.");
    }
    this.#database.prepare(`
      INSERT INTO client_cube_grants (client_id, cube_id, access, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (client_id, cube_id) DO UPDATE SET access = excluded.access
    `).run(input.clientId, input.cubeId, input.access, this.#now());
  }

  removeClientCubeGrant(clientId: string, cubeId: string): boolean {
    assertCanonicalUuid(clientId, "Client id");
    assertCanonicalUuid(cubeId, "Cube id");
    const result = this.#database.prepare(
      "DELETE FROM client_cube_grants WHERE client_id = ? AND cube_id = ?",
    ).run(clientId, cubeId);
    return result.changes === 1;
  }

  grantCreateCubeCapability(clientId: string): void {
    assertCanonicalUuid(clientId, "Client id");
    this.#database.prepare(`
      INSERT OR IGNORE INTO client_server_capabilities (client_id, capability, created_at)
      VALUES (?, 'create_cube', ?)
    `).run(clientId, this.#now());
  }

  resetAuthorityState(): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const table of [
        "cube_create_bindings", "activity_acks", "activity_log_recipients", "activity_log",
        "decisions", "expired_activity_cursors", "drone_session_credentials", "drone_sessions",
        "seat_attach_bindings", "drones", "roles", "client_cube_grants", "cubes", "client_server_capabilities",
        "enrollment_claims", "client_credentials", "owner_enrollment_state", "clients",
        "enrollment_invitations",
      ]) this.#database.exec(`DELETE FROM ${table}`);
      this.#database.exec("COMMIT");
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  observeAuthorityState() {
    const count = (table: string): number => requiredInteger(
      this.#database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!,
      "count",
    );
    return {
      enrolled_clients: count("clients"),
      enrollment_claims: count("enrollment_claims"),
      cubes: count("cubes"),
      roles: count("roles"),
      grants: count("client_cube_grants"),
      server_capabilities: count("client_server_capabilities"),
      cube_create_bindings: count("cube_create_bindings"),
    };
  }

  inspectCreatedCube(clientId: string, record: CreateCubeRecord) {
    assertCanonicalUuid(clientId, "Client id");
    const cube = this.#database.prepare("SELECT 1 FROM cubes WHERE id = ?").get(record.cubeId);
    const grant = this.#database.prepare(`
      SELECT access FROM client_cube_grants WHERE client_id = ? AND cube_id = ?
    `).get(clientId, record.cubeId);
    const roles = requiredInteger(this.#database.prepare(
      "SELECT COUNT(*) AS count FROM roles WHERE cube_id = ?",
    ).get(record.cubeId)!, "count");
    const human = this.#database.prepare(`
      SELECT 1 FROM roles WHERE id = ? AND cube_id = ? AND is_human_seat = 1 AND role_class = 'queen'
    `).get(record.humanSeatRoleId, record.cubeId);
    const worker = this.#database.prepare(`
      SELECT 1 FROM roles WHERE id = ? AND cube_id = ? AND is_default = 1 AND role_class = 'worker'
    `).get(record.defaultWorkerRoleId, record.cubeId);
    const grants = requiredInteger(this.#database.prepare(
      "SELECT COUNT(*) AS count FROM client_cube_grants WHERE cube_id = ?",
    ).get(record.cubeId)!, "count");
    return {
      cube_exists: cube !== undefined,
      creator_has_grant: grant !== undefined && requiredText(grant, "access") === "manage",
      grant_count: grants,
      role_count: roles,
      human_seat_role_matches: human !== undefined,
      default_worker_role_matches: worker !== undefined,
    };
  }

  inspectEnrollmentPrincipal(clientId: string) {
    assertCanonicalUuid(clientId, "Client id");
    const count = requiredInteger(this.#database.prepare(`
      SELECT COUNT(*) AS count FROM client_credentials
      WHERE client_id = ? AND revoked_at IS NULL
    `).get(clientId)!, "count");
    return { active_credential_bindings: count };
  }

  createRole(input: {
    readonly id: string;
    readonly cubeId: string;
    readonly name: string;
    readonly roleClass?: "queen" | "worker";
    readonly isHumanSeat?: boolean;
  }): void {
    assertCanonicalUuid(input.id, "Role id");
    assertCanonicalUuid(input.cubeId, "Cube id");
    validateName(input.name);
    const roleClass = input.roleClass ?? "worker";
    if (roleClass !== "queen" && roleClass !== "worker") throw new Error("Unknown role class.");
    this.#database.prepare(`
      INSERT INTO roles (
        id, cube_id, name, is_human_seat, role_class, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.cubeId,
      input.name,
      input.isHumanSeat === true ? 1 : 0,
      roleClass,
      this.#now(),
    );
  }

  createDrone(input: {
    readonly id: string;
    readonly cubeId: string;
    readonly roleId: string;
    readonly clientId: string;
    readonly label: string;
  }): void {
    assertCanonicalUuid(input.id, "Drone id");
    assertCanonicalUuid(input.cubeId, "Cube id");
    assertCanonicalUuid(input.roleId, "Role id");
    assertCanonicalUuid(input.clientId, "Client id");
    validateName(input.label);
    this.#database.prepare(`
      INSERT INTO drones (id, cube_id, role_id, client_id, label, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.id, input.cubeId, input.roleId, input.clientId, input.label, this.#now());
  }

  createDroneSession(input: {
    readonly id: string;
    readonly clientId: string;
    readonly cubeId: string;
    readonly droneId: string;
    readonly expiresAt: string;
  }): void {
    assertCanonicalUuid(input.id, "Drone session id");
    assertCanonicalUuid(input.clientId, "Client id");
    assertCanonicalUuid(input.cubeId, "Cube id");
    assertCanonicalUuid(input.droneId, "Drone id");
    validateTimestamp(input.expiresAt);
    this.#database.prepare(`
      INSERT INTO drone_sessions (
        id, client_id, cube_id, drone_id, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.clientId,
      input.cubeId,
      input.droneId,
      this.#now(),
      input.expiresAt,
    );
  }

  revokeClient(clientId: string): void {
    assertCanonicalUuid(clientId, "Client id");
    this.#database.prepare(
      "UPDATE clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).run(this.#now(), clientId);
  }

  revokeDroneSession(sessionId: string): void {
    assertCanonicalUuid(sessionId, "Drone session id");
    this.#database.prepare(
      "UPDATE drone_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).run(this.#now(), sessionId);
  }

  expireActivityCursor(cubeId: string, cursor: LogCursor): void {
    assertCanonicalUuid(cubeId, "Cube id");
    assertCanonicalUuid(cursor.id, "Activity cursor id");
    validateTimestamp(cursor.created_at);
    const entry = this.#database.prepare(`
      SELECT 1 AS present FROM activity_log WHERE cube_id = ? AND id = ? AND created_at = ?
    `).get(cubeId, cursor.id, cursor.created_at);
    if (entry === undefined) throw new ScopedStoreError();
    this.#database.prepare(`
      INSERT OR IGNORE INTO expired_activity_cursors (cube_id, entry_id, created_at)
      VALUES (?, ?, ?)
    `).run(cubeId, cursor.id, cursor.created_at);
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

class ActivityHub {
  readonly #listeners = new Map<string, Set<(entry: EnrichedActivityRecord) => void>>();

  subscribe(cubeId: string, listener: (entry: EnrichedActivityRecord) => void): () => void {
    const listeners = this.#listeners.get(cubeId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(cubeId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(cubeId);
    };
  }

  publish(cubeId: string, entry: EnrichedActivityRecord): void {
    for (const listener of this.#listeners.get(cubeId) ?? []) {
      try {
        listener(entry);
      } catch {
        // A live subscriber cannot roll back or alter a committed append.
      }
    }
  }
}

class SqliteCredentialStore implements CredentialStore {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;
  readonly #capacityGuard: StorageCapacityGuard;
  readonly #mutationHook: ((phase: string) => void) | undefined;

  constructor(
    database: DatabaseSync,
    clock: () => Date,
    capacityGuard: StorageCapacityGuard,
    mutationHook?: (phase: string) => void,
  ) {
    this.#database = database;
    this.#clock = clock;
    this.#capacityGuard = capacityGuard;
    this.#mutationHook = mutationHook;
  }

  createRecoveryCredential(id: string, digest: DigestPair): void {
    assertCanonicalUuid(id, "Recovery credential id");
    validateDigest(digest);
    this.#database.prepare(`
      INSERT INTO recovery_credentials (
        id, lookup_digest, verifier_digest, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(id, digest.lookup, digest.verifier, this.#now());
  }

  findRecoveryCredential(lookup: Buffer): StoredSecretDigest | null {
    validateLookup(lookup);
    const row = this.#database.prepare(`
      SELECT id, lookup_digest, verifier_digest, revoked_at
      FROM recovery_credentials
      WHERE lookup_digest = ? AND revoked_at IS NULL
    `).get(lookup);
    return row === undefined ? null : storedDigest(row);
  }

  createInvitation(input: {
    readonly id: string;
    readonly digest: DigestPair;
    readonly expiresAt: string;
    readonly purpose: "owner" | "client";
    readonly cubeSelector?: { readonly kind: "id" | "name"; readonly value: string };
    readonly access?: CubeAccess;
  }): InvitationCubeScope | null {
    assertCanonicalUuid(input.id, "Invitation id");
    validateDigest(input.digest);
    validateTimestamp(input.expiresAt);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      let scope: InvitationCubeScope | null = null;
      if (input.cubeSelector !== undefined) {
        if (input.purpose !== "client" || input.access === undefined) {
          throw new Error("Only client invitations may carry a complete cube scope.");
        }
        if (input.access !== "read" && input.access !== "write" && input.access !== "manage") {
          throw new Error("Unknown cube access grant.");
        }
        const rows = input.cubeSelector.kind === "id"
          ? this.#database.prepare("SELECT id, name FROM cubes WHERE id = ?").all(input.cubeSelector.value)
          : this.#database.prepare("SELECT id, name FROM cubes WHERE name = ? ORDER BY id").all(input.cubeSelector.value);
        if (rows.length === 0) throw new InvitationCubeNotFoundError();
        if (rows.length > 1) {
          throw new InvitationCubeAmbiguousError(rows.map((row) => requiredText(row, "id")));
        }
        const cubeId = requiredText(rows[0]!, "id");
        assertCanonicalUuid(cubeId, "Resolved cube id");
        scope = {
          cubeId,
          cubeName: requiredText(rows[0]!, "name"),
          access: input.access,
        };
      } else if (input.access !== undefined) {
        throw new Error("Invitation access requires a cube selector.");
      }
      let ownerEpoch: number | null = null;
      if (input.purpose === "owner") {
        const state = this.#database.prepare(
          "SELECT epoch, claimed_client_id FROM owner_enrollment_state WHERE singleton = 1",
        ).get();
        if (state === undefined) {
          ownerEpoch = 1;
          this.#database.prepare(`
            INSERT INTO owner_enrollment_state (singleton, epoch) VALUES (1, 1)
          `).run();
        } else {
          if (nullableText(state, "claimed_client_id") !== null) throw new AccessDeniedError();
          ownerEpoch = requiredInteger(state, "epoch") + 1;
          this.#database.prepare(`
            UPDATE enrollment_invitations SET revoked_at = ?
            WHERE purpose = 'owner' AND consumed_at IS NULL AND revoked_at IS NULL
          `).run(this.#now());
          this.#database.prepare(`
            UPDATE owner_enrollment_state SET epoch = ? WHERE singleton = 1
          `).run(ownerEpoch);
        }
      }
      this.#database.prepare(`
        INSERT INTO enrollment_invitations (
          id, lookup_digest, verifier_digest, expires_at, created_at, purpose, owner_epoch,
          cube_id, access
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id, input.digest.lookup, input.digest.verifier, input.expiresAt,
        this.#now(), input.purpose, ownerEpoch, scope?.cubeId ?? null, scope?.access ?? null,
      );
      this.#database.exec("COMMIT");
      return scope;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  findInvitation(lookup: Buffer): StoredInvitationDigest | null {
    validateLookup(lookup);
    const row = this.#database.prepare(`
      SELECT invitation.id IS NOT NULL AS found,
             COALESCE(invitation.id, '00000000-0000-4000-8000-000000000000') AS id,
             COALESCE(invitation.lookup_digest, zeroblob(32)) AS lookup_digest,
             COALESCE(invitation.verifier_digest, zeroblob(32)) AS verifier_digest,
             COALESCE(invitation.expires_at, '') AS expires_at,
             invitation.consumed_at, invitation.revoked_at,
             COALESCE(invitation.purpose, 'client') AS purpose,
             invitation.owner_epoch, invitation.cube_id, invitation.access
      FROM (SELECT 1) AS seed
      LEFT JOIN enrollment_invitations AS invitation ON invitation.lookup_digest = ?
    `).get(lookup);
    if (row === undefined) throw new Error("Invitation lookup did not return a sentinel row.");
    const stored = storedInvitationDigest(row);
    return requiredInteger(row, "found") === 1 ? stored : null;
  }

  claimInvitation(input: {
    readonly invitationId: string;
    readonly clientId: string;
    readonly requestedClientName: string | null;
    readonly retryKey: string;
    readonly credentialId: string;
    readonly credentialDigest: DigestPair;
  }): EnrollmentClaimResult | null {
    assertCanonicalUuid(input.invitationId, "Invitation id");
    assertCanonicalUuid(input.clientId, "Client id");
    assertCanonicalUuid(input.credentialId, "Credential id");
    assertCanonicalUuid(input.retryKey, "Enrollment retry key");
    if (input.requestedClientName !== null) validatePresentationName(input.requestedClientName);
    validateDigest(input.credentialDigest);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const now = this.#now();
      const invitation = this.#database.prepare(`
        SELECT invitation.id IS NOT NULL AS found,
               COALESCE(invitation.purpose, 'client') AS purpose,
               invitation.owner_epoch,
               COALESCE(invitation.expires_at, '') AS expires_at,
               invitation.consumed_at, invitation.revoked_at,
               invitation.cube_id, invitation.access
        FROM (SELECT 1) AS seed
        LEFT JOIN enrollment_invitations AS invitation ON invitation.id = ?
      `).get(input.invitationId);
      const existing = this.#database.prepare(`
        SELECT claim.invitation_id IS NOT NULL AS found,
               COALESCE(claim.retry_key, '') AS retry_key,
               COALESCE(claim.client_id, '') AS client_id,
               claim.requested_client_name,
               COALESCE(claim.credential_lookup_digest, zeroblob(32)) AS credential_lookup_digest,
               COALESCE(claim.credential_verifier_digest, zeroblob(32)) AS credential_verifier_digest,
               COALESCE(claim.purpose, 'client') AS purpose,
               claim.owner_epoch
        FROM (SELECT 1) AS seed
        LEFT JOIN enrollment_claims AS claim ON claim.invitation_id = ?
      `).get(input.invitationId);
      if (invitation === undefined || existing === undefined) {
        throw new Error("Enrollment lookup did not return a sentinel row.");
      }
      const invitationFound = requiredInteger(invitation, "found") === 1;
      const existingFound = requiredInteger(existing, "found") === 1;
      const purposeValue = requiredText(invitation, "purpose");
      if (purposeValue !== "owner" && purposeValue !== "client") {
        throw new Error("Invalid invitation purpose.");
      }
      const purpose = purposeValue;
      const claimMatch = matchEnrollmentClaim(existing, input, purpose);
      if (!invitationFound) {
        this.#database.exec("ROLLBACK");
        return null;
      }
      if (existingFound) {
        if (!claimMatch.exact) {
          this.#database.exec("ROLLBACK");
          return null;
        }
        const result = enrollmentClaimResult(purpose, claimMatch.clientId);
        this.#database.exec("COMMIT");
        return result;
      }
      if (nullableText(invitation, "consumed_at") !== null || nullableText(invitation, "revoked_at") !== null ||
          requiredText(invitation, "expires_at") <= now) {
        this.#database.exec("ROLLBACK");
        return null;
      }
      const ownerEpoch = invitation["owner_epoch"] === null
        ? null
        : requiredInteger(invitation, "owner_epoch");
      const cubeId = nullableText(invitation, "cube_id");
      const accessValue = nullableText(invitation, "access");
      const access = accessValue === null ? null : cubeAccess(accessValue);
      if ((cubeId === null) !== (access === null) || (cubeId !== null && purpose !== "client")) {
        throw new Error("Invalid invitation cube scope.");
      }
      if (purpose === "owner") {
        const state = this.#database.prepare(`
          SELECT epoch, claimed_client_id FROM owner_enrollment_state WHERE singleton = 1
        `).get();
        if (state === undefined || requiredInteger(state, "epoch") !== ownerEpoch ||
            nullableText(state, "claimed_client_id") !== null) {
          this.#database.exec("ROLLBACK");
          return null;
        }
      }
      if (cubeId !== null && this.#database.prepare("SELECT 1 FROM cubes WHERE id = ?").get(cubeId) === undefined) {
        this.#database.exec("ROLLBACK");
        return null;
      }
      this.#capacityGuard.assertCanGrow(Buffer.byteLength(input.requestedClientName ?? "") + 8_192);
      this.#database.prepare(
        "INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)",
      ).run(input.clientId, input.requestedClientName ?? "Local client", now);
      this.#mutationHook?.("enrollment.insert-client");
      this.#database.prepare(`
        INSERT INTO client_credentials (
          id, client_id, lookup_digest, verifier_digest, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.credentialId,
        input.clientId,
        input.credentialDigest.lookup,
        input.credentialDigest.verifier,
        now,
      );
      this.#mutationHook?.("enrollment.insert-credential");
      if (purpose === "owner") {
        this.#database.prepare(`
          INSERT INTO client_server_capabilities (client_id, capability, created_at)
          VALUES (?, 'create_cube', ?)
        `).run(input.clientId, now);
        this.#mutationHook?.("enrollment.insert-capability");
      }
      if (cubeId !== null && access !== null) {
        this.#database.prepare(`
          INSERT INTO client_cube_grants (client_id, cube_id, access, created_at)
          VALUES (?, ?, ?, ?)
        `).run(input.clientId, cubeId, access, now);
        this.#mutationHook?.("enrollment.insert-grant");
      }
      this.#database.prepare(`
        INSERT INTO enrollment_claims (
          invitation_id, retry_key, client_id, requested_client_name,
          credential_lookup_digest, credential_verifier_digest, purpose, owner_epoch, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.invitationId, input.retryKey, input.clientId, input.requestedClientName,
        input.credentialDigest.lookup, input.credentialDigest.verifier, purpose, ownerEpoch, now,
      );
      this.#mutationHook?.("enrollment.insert-claim");
      const consumed = this.#database.prepare(`
        UPDATE enrollment_invitations SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      `).run(now, input.invitationId, now);
      if (consumed.changes !== 1) throw new Error("Invitation claim raced.");
      this.#mutationHook?.("enrollment.consume-invitation");
      if (purpose === "owner") {
        const claimed = this.#database.prepare(`
          UPDATE owner_enrollment_state SET claimed_client_id = ?, claimed_at = ?
          WHERE singleton = 1 AND epoch = ? AND claimed_client_id IS NULL
        `).run(input.clientId, now, ownerEpoch);
        if (claimed.changes !== 1) throw new Error("Owner claim raced.");
        this.#mutationHook?.("enrollment.claim-owner");
      }
      this.#database.exec("COMMIT");
      this.#mutationHook?.("enrollment.after-commit");
      return enrollmentClaimResult(purpose, input.clientId);
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the originating storage failure.
      }
      throw error;
    }
  }

  findClientCredential(lookup: Buffer): StoredSecretDigest | null {
    validateLookup(lookup);
    const row = this.#database.prepare(`
      SELECT credential.id, credential.client_id, credential.lookup_digest,
             credential.verifier_digest,
             COALESCE(credential.revoked_at, client.revoked_at) AS revoked_at
      FROM client_credentials AS credential
      JOIN clients AS client ON client.id = credential.client_id
      WHERE credential.lookup_digest = ?
    `).get(lookup);
    return row === undefined ? null : storedDigest(row);
  }

  clientExists(clientId: string): boolean {
    assertCanonicalUuid(clientId, "Client id");
    return this.#database.prepare("SELECT 1 FROM clients WHERE id = ?").get(clientId) !== undefined;
  }

  clientIsActive(clientId: string): boolean {
    assertCanonicalUuid(clientId, "Client id");
    return this.#database.prepare(
      "SELECT 1 FROM clients WHERE id = ? AND revoked_at IS NULL",
    ).get(clientId) !== undefined;
  }

  findDroneSessionCredential(lookup: Buffer): StoredDroneSessionDigest | null {
    validateLookup(lookup);
    const row = this.#database.prepare(`
      SELECT credential.id, credential.lookup_digest, credential.verifier_digest,
             credential.session_id, session.client_id, session.cube_id, session.drone_id,
             session.expires_at,
             COALESCE(
               credential.revoked_at, session.revoked_at, client.revoked_at, drone.evicted_at
             ) AS revoked_at
      FROM drone_session_credentials AS credential
      JOIN drone_sessions AS session ON session.id = credential.session_id
      JOIN clients AS client ON client.id = session.client_id
      JOIN drones AS drone ON drone.id = session.drone_id
        AND drone.client_id = session.client_id
        AND drone.cube_id = session.cube_id
      WHERE credential.lookup_digest = ?
    `).get(lookup);
    return row === undefined ? null : storedDroneSessionDigest(row);
  }

  rotateClientCredential(input: {
    readonly clientId: string;
    readonly credentialId: string;
    readonly credentialDigest: DigestPair;
  }): boolean {
    assertCanonicalUuid(input.clientId, "Client id");
    assertCanonicalUuid(input.credentialId, "Credential id");
    validateDigest(input.credentialDigest);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const active = this.#database.prepare(
        "SELECT 1 FROM clients WHERE id = ? AND revoked_at IS NULL",
      ).get(input.clientId);
      if (active === undefined) {
        this.#database.exec("ROLLBACK");
        return false;
      }
      const now = this.#now();
      this.#database.prepare(`
        UPDATE client_credentials SET revoked_at = ?
        WHERE client_id = ? AND revoked_at IS NULL
      `).run(now, input.clientId);
      this.#database.prepare(`
        INSERT INTO client_credentials (
          id, client_id, lookup_digest, verifier_digest, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.credentialId,
        input.clientId,
        input.credentialDigest.lookup,
        input.credentialDigest.verifier,
        now,
      );
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the originating storage failure.
      }
      throw error;
    }
  }

  revokeClientCredentials(clientId: string): void {
    assertCanonicalUuid(clientId, "Client id");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const now = this.#now();
      this.#database.prepare(
        "UPDATE clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      ).run(now, clientId);
      this.#database.prepare(`
        UPDATE client_credentials SET revoked_at = ?
        WHERE client_id = ? AND revoked_at IS NULL
      `).run(now, clientId);
      this.#database.exec("COMMIT");
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the originating storage failure.
      }
      throw error;
    }
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

async function prepareDatabasePath(path: string): Promise<string> {
  if (path === ":memory:") throw new Error("The server store requires a file-backed database.");
  const databasePath = resolve(path);
  const directory = await preparePrivateDataDirectory(dirname(databasePath));
  try {
    const handle = await open(databasePath, "ax", 0o600);
    await handle.close();
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const metadata = await lstat(databasePath);
    if (metadata.isSymbolicLink()) throw operatorErrors.DATA_PATH_SYMLINK;
    if (!metadata.isFile()) throw new Error("Database path must be a regular file.");
  }
  await assertDirectoryTreeHasNoSymlinks(directory);
  await chmod(databasePath, 0o600);
  return databasePath;
}

export async function preparePrivateDataDirectory(path: string): Promise<string> {
  const directory = resolve(path);
  await ensureDirectoryTree(directory);
  await chmod(directory, 0o700);
  return directory;
}

async function ensureDirectoryTree(directory: string): Promise<void> {
  const { root } = parse(directory);
  let current = root;
  for (const component of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      await assertDirectoryComponent(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      await assertDirectoryComponent(current);
    }
  }
  await assertDirectoryTreeHasNoSymlinks(directory);
}

async function assertDirectoryTreeHasNoSymlinks(directory: string): Promise<void> {
  const { root } = parse(directory);
  let current = root;
  for (const component of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, component);
    await assertDirectoryComponent(current);
  }
}

async function assertDirectoryComponent(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw operatorErrors.DATA_PATH_SYMLINK;
  }
  if (!metadata.isDirectory()) {
    throw new Error("Database parent path must contain only directories.");
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA trusted_schema = OFF;
    PRAGMA secure_delete = ON;
    PRAGMA busy_timeout = 5000;
  `);
  if (readPragma(database, "journal_mode") !== "wal") {
    throw new Error("SQLite WAL mode is required.");
  }
}

function configureExistingDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = FULL;
    PRAGMA trusted_schema = OFF;
    PRAGMA secure_delete = ON;
    PRAGMA busy_timeout = 5000;
  `);
  if (readPragma(database, "journal_mode") !== "wal") {
    throw new Error("SQLite WAL mode is required.");
  }
}

function diagnostics(database: DatabaseSync): StoreDiagnostics {
  const journalMode = readPragma(database, "journal_mode");
  const foreignKeys = readPragma(database, "foreign_keys");
  const rows = database.prepare(
    "SELECT version FROM schema_migrations ORDER BY version",
  ).all();
  return {
    journalMode: String(journalMode).toLowerCase(),
    foreignKeys: foreignKeys === 1,
    schemaVersions: rows.map((row) => requiredInteger(row, "version")),
  };
}

function readPragma(database: DatabaseSync, name: "journal_mode" | "foreign_keys"): unknown {
  const row = database.prepare(`PRAGMA ${name}`).get();
  return row?.[name];
}

function cubeRecord(row: CubeRow): CubeRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    directive: row.directive,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function activityRecord(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    cubeId: row.cube_id,
    droneId: row.drone_id,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    message: row.message,
    createdAt: row.created_at,
  };
}

function cubeRow(row: Record<string, unknown>): CubeRow {
  return {
    id: requiredText(row, "id"),
    owner_id: requiredText(row, "owner_id"),
    name: requiredText(row, "name"),
    directive: requiredText(row, "directive"),
    created_at: requiredText(row, "created_at"),
    updated_at: requiredText(row, "updated_at"),
  };
}

function activityRow(row: Record<string, unknown>): ActivityRow {
  const actorKind = requiredText(row, "actor_kind");
  if (actorKind !== "operator" && actorKind !== "client" && actorKind !== "drone-session") {
    throw new Error("Database contains an invalid activity actor kind.");
  }
  const droneId = row["drone_id"];
  if (droneId !== null && typeof droneId !== "string") {
    throw new Error("Database contains an invalid activity drone id.");
  }
  return {
    id: requiredText(row, "id"),
    cube_id: requiredText(row, "cube_id"),
    drone_id: droneId,
    actor_kind: actorKind,
    actor_id: requiredText(row, "actor_id"),
    message: requiredText(row, "message"),
    created_at: requiredText(row, "created_at"),
  };
}

function enrichedActivityRecord(
  row: Record<string, unknown>,
  recipientDroneIds: string[],
): EnrichedActivityRecord {
  const visibility = requiredText(row, "visibility");
  if (visibility !== "broadcast" && visibility !== "direct") {
    throw new Error("Database contains invalid activity visibility.");
  }
  return {
    id: requiredText(row, "id"),
    cube_id: requiredText(row, "cube_id"),
    drone_id: nullableText(row, "drone_id"),
    message: requiredText(row, "message"),
    visibility,
    created_at: requiredText(row, "created_at"),
    drone_label: nullableText(row, "drone_label"),
    role_name: nullableText(row, "role_name"),
    recipient_drone_ids: recipientDroneIds,
  };
}

function claimRecord(row: Record<string, unknown>): ClaimRecord {
  return {
    log_entry_id: requiredText(row, "log_entry_id"),
    claimant_drone_id: requiredText(row, "claimant_drone_id"),
    claimant_label: nullableText(row, "claimant_label"),
    claimant_role: nullableText(row, "claimant_role"),
    claimed_at: requiredText(row, "claimed_at"),
    stale: false,
  };
}

function decisionRecord(row: Record<string, unknown>): DecisionRecord {
  const status = requiredText(row, "status");
  if (status !== "active" && status !== "superseded" && status !== "removed") {
    throw new Error("Database contains invalid decision status.");
  }
  return {
    id: requiredText(row, "id"),
    cube_id: requiredText(row, "cube_id"),
    topic: requiredText(row, "topic"),
    decision: requiredText(row, "decision"),
    rationale: nullableText(row, "rationale"),
    ratified_by: nullableText(row, "ratified_by"),
    status,
    supersedes: nullableText(row, "supersedes"),
    created_at: requiredText(row, "created_at"),
  };
}

function roleRecord(row: Record<string, unknown>): RoleRecord {
  const roleClass = requiredText(row, "role_class");
  if (roleClass !== "queen" && roleClass !== "worker") {
    throw new Error("Database contains invalid role class.");
  }
  return {
    id: requiredText(row, "id"),
    cube_id: requiredText(row, "cube_id"),
    name: requiredText(row, "name"),
    short_description: requiredText(row, "short_description"),
    detailed_description: requiredText(row, "detailed_description"),
    is_default: requiredInteger(row, "is_default") === 1,
    is_mandatory: requiredInteger(row, "is_mandatory") === 1,
    is_human_seat: requiredInteger(row, "is_human_seat") === 1,
    can_broadcast: requiredInteger(row, "can_broadcast") === 1,
    receives_all_direct: requiredInteger(row, "receives_all_direct") === 1,
    role_class: roleClass,
    created_at: requiredText(row, "created_at"),
  };
}

function createCubeRecord(row: Record<string, unknown>): CreateCubeRecord {
  return {
    cubeId: requiredText(row, "cube_id"),
    humanSeatRoleId: requiredText(row, "human_seat_role_id"),
    defaultWorkerRoleId: requiredText(row, "default_worker_role_id"),
    access: "manage",
  };
}

function droneRecord(row: Record<string, unknown>): DroneRecord {
  return {
    id: requiredText(row, "id"),
    cube_id: requiredText(row, "cube_id"),
    role_id: requiredText(row, "role_id"),
    label: requiredText(row, "label"),
    last_seen: requiredText(row, "last_seen"),
    hostname: nullableText(row, "hostname"),
    created_at: requiredText(row, "created_at"),
  };
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || typeof value === "string") return value;
  throw new Error(`Database contains invalid ${key}.`);
}

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Database contains invalid ${key}.`);
  return value;
}

function requiredInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) throw new Error(`Database contains invalid ${key}.`);
  return value as number;
}

function storedDigest(row: Record<string, unknown>): StoredSecretDigest {
  const lookup = requiredBuffer(row, "lookup_digest");
  const verifier = requiredBuffer(row, "verifier_digest");
  const expiresAt = optionalNonNullText(row, "expires_at");
  const consumedAt = optionalText(row, "consumed_at");
  const clientId = optionalNonNullText(row, "client_id");
  const revokedAt = optionalText(row, "revoked_at");
  return {
    id: requiredText(row, "id"),
    lookup,
    verifier,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(consumedAt === undefined ? {} : { consumedAt }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

function storedInvitationDigest(row: Record<string, unknown>): StoredInvitationDigest {
  const digest = storedDigest(row);
  const purpose = requiredText(row, "purpose");
  if (purpose !== "owner" && purpose !== "client") {
    throw new Error("Database contains invalid invitation purpose.");
  }
  const epochValue = row["owner_epoch"];
  const ownerEpoch = epochValue === null ? null : requiredInteger(row, "owner_epoch");
  const cubeId = nullableText(row, "cube_id");
  const accessValue = nullableText(row, "access");
  const access = accessValue === null ? null : cubeAccess(accessValue);
  if ((cubeId === null) !== (access === null) || (cubeId !== null && purpose !== "client")) {
    throw new Error("Database contains invalid invitation cube scope.");
  }
  return { ...digest, purpose, ownerEpoch, cubeId, access };
}

function cubeAccess(value: string): CubeAccess {
  if (value !== "read" && value !== "write" && value !== "manage") {
    throw new Error("Database contains invalid cube access.");
  }
  return value;
}

function enrollmentClaimResult(
  purpose: "owner" | "client",
  clientId: string,
): EnrollmentClaimResult {
  return purpose === "owner"
    ? { purpose, clientId, serverCapabilities: ["create_cube"] }
    : { purpose, clientId, serverCapabilities: [] };
}

function matchEnrollmentClaim(
  row: Record<string, unknown>,
  input: {
    readonly retryKey: string;
    readonly requestedClientName: string | null;
    readonly credentialDigest: DigestPair;
  },
  purpose: "owner" | "client",
): { exact: boolean; clientId: string } {
  const retryKey = requiredText(row, "retry_key");
  const clientId = requiredText(row, "client_id");
  const requestedClientName = nullableText(row, "requested_client_name");
  const storedPurpose = requiredText(row, "purpose");
  const lookup = requiredBuffer(row, "credential_lookup_digest");
  const verifier = requiredBuffer(row, "credential_verifier_digest");

  const retryMatches = retryKey === input.retryKey;
  const nameMatches = requestedClientName === input.requestedClientName;
  const purposeMatches = storedPurpose === purpose;
  const lookupMatches = lookup.equals(input.credentialDigest.lookup);
  const verifierMatches = verifier.equals(input.credentialDigest.verifier);
  return {
    exact: retryMatches && nameMatches && purposeMatches && lookupMatches && verifierMatches,
    clientId,
  };
}

function storedDroneSessionDigest(row: Record<string, unknown>): StoredDroneSessionDigest {
  const digest = storedDigest(row);
  return {
    ...digest,
    sessionId: requiredText(row, "session_id"),
    clientId: requiredText(row, "client_id"),
    cubeId: requiredText(row, "cube_id"),
    droneId: requiredText(row, "drone_id"),
    expiresAt: requiredText(row, "expires_at"),
  };
}

function requiredBuffer(row: Record<string, unknown>, key: string): Buffer {
  const value = row[key];
  if (!(value instanceof Uint8Array)) throw new Error(`Database contains invalid ${key}.`);
  return Buffer.from(value);
}

function optionalText(row: Record<string, unknown>, key: string): string | null | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  throw new Error(`Database contains invalid ${key}.`);
}

function optionalNonNullText(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new Error(`Database contains invalid ${key}.`);
}

function validateName(value: string): void {
  if (value.length < 1 || value.length > 120) {
    throw new Error("Name must contain 1 to 120 characters.");
  }
}

function validatePresentationName(value: string): void {
  if (Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > 120 ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/u.test(value)) {
    throw new Error("Presentation name is invalid.");
  }
}

function validateRoleName(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new Error("Role name must contain 1 to 64 characters.");
  }
}

function validateRoleShortDescription(value: string): void {
  if (typeof value !== "string" || value.length > 1_024) {
    throw new Error("Role short description must contain at most 1024 characters.");
  }
}

export const MAX_ROLE_DETAILED_DESCRIPTION_CHARS = 51_200;

export function assertRoleTextWriteAllowed(value: string, previous?: string): void {
  if (typeof value !== "string") throw new TypeError("Role detailed description must be text.");
  if (value.length <= MAX_ROLE_DETAILED_DESCRIPTION_CHARS) return;
  if (previous !== undefined && previous.length > MAX_ROLE_DETAILED_DESCRIPTION_CHARS &&
      value.length < previous.length) return;
  throw new RangeError("Role detailed description is too large.");
}

function booleanInteger(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function validateBoundedText(value: string, name: string, maxBytes: number): void {
  if (value.length === 0 || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`${name} must contain 1 to ${maxBytes} bytes.`);
  }
}

function seatLabel(roleName: string, droneId: string): string {
  const role = roleName.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "seat";
  return `${role.slice(0, 80)}-${droneId.slice(0, 8)}`;
}

function allowedGrantAccess(access: CubeAccess): readonly CubeAccess[] {
  return access === "read"
    ? ["read", "write", "manage"]
    : access === "write" ? ["write", "manage"] : ["manage"];
}

function validateDirective(value: string): void {
  if (Buffer.byteLength(value) > 100_000) {
    throw new Error("Cube directive exceeds 100000 bytes.");
  }
}

function validateDigest(digest: DigestPair): void {
  validateLookup(digest.lookup);
  if (digest.verifier.length !== 32) throw new Error("Verifier digest must contain 32 bytes.");
}

function validateLookup(lookup: Buffer): void {
  if (lookup.length !== 16) throw new Error("Lookup digest must contain 16 bytes.");
}

function validateTimestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
      new Date(value).toISOString() !== value) {
    throw new Error("Timestamp must be canonical UTC with millisecond precision.");
  }
}

function validateStorageLimits(limits: StorageLimits | CubeLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer.`);
    }
  }
}

function storageCapacity(databasePath: string): StorageCapacity {
  const databaseBytes = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .reduce((total, path) => total + fileSize(path), 0);
  const filesystem = statfsSync(dirname(databasePath), { bigint: true });
  const freeDiskBytes = toSafeInteger(filesystem.bavail * filesystem.bsize);
  return { databaseBytes, freeDiskBytes };
}

function fileSize(path: string): number {
  try {
    return toSafeInteger(statSync(path, { bigint: true }).size);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

function toSafeInteger(value: bigint): number {
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
