import type { Principal } from "./principal.js";
import { assertServerDerivedPrincipal } from "./principal.js";
import type { CredentialAuthority } from "./credentials.js";
import {
  CursorExpiredError,
  AttachConflictError,
  AccessDeniedError,
  CreateCubeConflictError,
  DefaultRoleRequiredError,
  RoleConflictError,
  RoleSectionConflictError,
  ScopedStoreError,
  StorageCapacityError,
  type EnrichedActivityRecord,
  type LogCursor,
  type StoreRuntime,
} from "./store.js";

export interface CoordinationRequest {
  readonly method: string;
  readonly path: string;
  readonly principal: Principal;
  readonly body?: unknown;
  readonly cursor?: string;
  readonly signal: AbortSignal;
}

export interface CoordinationResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly stream?: AsyncIterable<string>;
}

interface RequestEnvelope {
  readonly requestId: string;
  readonly payload: Record<string, unknown>;
}

interface ReplayBarrier {
  readonly reached: Promise<void>;
  readonly release: Promise<void>;
  readonly markReached: () => void;
}

export class CoordinationApi {
  readonly #runtime: StoreRuntime;
  readonly #authority: CredentialAuthority;
  #replayBarrier: ReplayBarrier | undefined;

  constructor(runtime: StoreRuntime, authority: CredentialAuthority) {
    this.#runtime = runtime;
    this.#authority = authority;
  }

  armReplayTransition(): { readonly reached: Promise<void>; readonly release: () => void } {
    let markReached!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { markReached = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.#replayBarrier = { reached, release: released, markReached };
    return {
      reached,
      release: () => {
        release();
      },
    };
  }

  async handle(request: CoordinationRequest): Promise<CoordinationResponse> {
    assertServerDerivedPrincipal(request.principal);
    const authentication = request.principal;

    if (request.path === "/api/client/attach" && request.method === "POST") {
      const requestId = safeRequestId(request.body);
      try {
        const envelope = decodeEnvelope(request.body);
        exactKeys(envelope.payload, ["cube_id", "role_id", "retry_key"], ["prior_drone_id"]);
        const priorDroneId = envelope.payload["prior_drone_id"] === undefined
          ? undefined
          : requiredUuid(envelope.payload, "prior_drone_id");
        const attachment = this.#authority.attachSeat(
          this.#runtime.forPrincipal(authentication),
          {
            cubeId: requiredUuid(envelope.payload, "cube_id"),
            roleId: requiredUuid(envelope.payload, "role_id"),
            retryKey: requiredUuid(envelope.payload, "retry_key"),
            ...(priorDroneId === undefined ? {} : { priorDroneId }),
          },
        );
        return success(201, envelope.requestId, {
          cube: attachment.cube,
          role: attachment.role,
          drone: attachment.drone,
          session: {
            token: attachment.credential,
            expires_at: attachment.expiresAt,
            generation: attachment.generation,
          },
          reattached: attachment.reattached,
        });
      } catch (error) {
        if (error instanceof AttachConflictError) {
          return failure(409, "INVALID_INPUT", "The attach request conflicts.", requestId);
        }
        if (error instanceof ScopedStoreError) {
          return failure(404, "NOT_FOUND", error.message, requestId);
        }
        if (error instanceof StorageCapacityError) {
          return failure(507, "CAPACITY_EXCEEDED", error.message, requestId);
        }
        if (error instanceof InputError || error instanceof TypeError || error instanceof RangeError) {
          return failure(400, "INVALID_INPUT", "Invalid protocol request.", requestId);
        }
        throw error;
      }
    }

    if (request.path === "/api/cubes" && request.method === "GET") {
      const cubes = this.#runtime.forPrincipal(authentication).listCubes().map((cube) => ({
        id: cube.id,
        owner_id: cube.ownerId,
        name: cube.name,
        cube_directive: cube.directive,
        created_at: cube.createdAt,
        updated_at: cube.updatedAt,
      }));
      return success(200, "cubes-read", { cubes });
    }

    if (request.path === "/api/cubes" && request.method === "POST") {
      const requestId = safeRequestId(request.body);
      try {
        const envelope = decodeEnvelope(request.body);
        exactKeys(envelope.payload, ["retry_key", "name", "template"]);
        const template = envelope.payload["template"];
        if (template !== "default") throw new InputError();
        const created = this.#runtime.forPrincipal(authentication).createCube({
          retryKey: requiredUuid(envelope.payload, "retry_key"),
          name: requiredPresentationName(envelope.payload, "name"),
          template,
        });
        return success(201, envelope.requestId, {
          cube_id: created.cubeId,
          human_seat_role_id: created.humanSeatRoleId,
          default_worker_role_id: created.defaultWorkerRoleId,
          access: created.access,
        });
      } catch (error) {
        if (error instanceof AccessDeniedError) {
          return failure(403, "ACCESS_DENIED", error.message, requestId);
        }
        if (error instanceof CreateCubeConflictError) {
          return failure(409, "INVALID_INPUT", "The cube creation request conflicts.", requestId);
        }
        if (error instanceof StorageCapacityError) {
          return failure(507, "CAPACITY_EXCEEDED", error.message, requestId);
        }
        if (error instanceof InputError || error instanceof TypeError || error instanceof RangeError) {
          return failure(400, "INVALID_INPUT", "Invalid protocol request.", requestId);
        }
        throw error;
      }
    }

    const roleMatch = /^\/api\/cubes\/([0-9a-f-]{36})\/roles\/([0-9a-f-]{36})(\/section-patch)?$/u
      .exec(request.path);
    const match = /^\/api\/cubes\/([0-9a-f-]{36})(?:\/(roles|drones|logs|acks|decisions|stream))?$/u
      .exec(request.path);
    if (match === null && roleMatch === null) {
      return failure(404, "NOT_FOUND", "The requested resource was not found.");
    }
    const cubeId = (roleMatch?.[1] ?? match?.[1])!;
    const roleId = roleMatch?.[2];
    if (!uuidPattern.test(cubeId) || (roleId !== undefined && !uuidPattern.test(roleId))) {
      return failure(404, "NOT_FOUND", "The requested resource was not found.");
    }
    const resource = roleMatch === null ? match?.[2] : "role";
    const sectionPatch = roleMatch?.[3] !== undefined;
    const store = this.#runtime.forPrincipal(authentication);

    try {
      if (resource === undefined && request.method === "GET") {
        const cube = store.getCube(cubeId);
        if (cube === null) throw new ScopedStoreError();
        return success(200, "cube-read", {
          cube: {
            id: cube.id,
            owner_id: cube.ownerId,
            name: cube.name,
            cube_directive: cube.directive,
            created_at: cube.createdAt,
            updated_at: cube.updatedAt,
          },
        });
      }
      if (resource === "roles" && request.method === "GET") {
        return success(200, "roles-read", { roles: store.listRoles(cubeId) });
      }
      if (resource === "roles" && request.method === "POST") {
        const envelope = decodeEnvelope(request.body);
        exactKeys(envelope.payload, ["name"], [
          "short_description",
          "detailed_description",
          "is_default",
          "is_mandatory",
          "is_human_seat",
          "can_broadcast",
          "receives_all_direct",
        ]);
        const role = store.createRole(cubeId, {
          name: requiredRoleName(envelope.payload, "name"),
          shortDescription: optionalText(envelope.payload, "short_description", 1_024) ?? "",
          detailedDescription: optionalText(envelope.payload, "detailed_description", 51_200) ?? "",
          isDefault: optionalBoolean(envelope.payload["is_default"]),
          isMandatory: optionalBoolean(envelope.payload["is_mandatory"]),
          isHumanSeat: optionalBoolean(envelope.payload["is_human_seat"]),
          canBroadcast: optionalBoolean(envelope.payload["can_broadcast"]),
          receivesAllDirect: optionalBoolean(envelope.payload["receives_all_direct"]),
        });
        return success(201, envelope.requestId, { role });
      }
      if (resource === "role" && !sectionPatch && request.method === "PATCH") {
        const envelope = decodeEnvelope(request.body);
        exactKeys(envelope.payload, [], [
          "name",
          "short_description",
          "detailed_description",
          "is_default",
          "is_mandatory",
          "is_human_seat",
          "can_broadcast",
          "receives_all_direct",
        ]);
        if (Object.keys(envelope.payload).length === 0) throw new InputError();
        const name = envelope.payload["name"] === undefined
          ? undefined
          : requiredRoleName(envelope.payload, "name");
        const shortDescription = optionalText(envelope.payload, "short_description", 1_024);
        const detailedDescription = optionalText(envelope.payload, "detailed_description", 51_200);
        const isDefault = optionalBooleanValue(envelope.payload["is_default"]);
        const isMandatory = optionalBooleanValue(envelope.payload["is_mandatory"]);
        const isHumanSeat = optionalBooleanValue(envelope.payload["is_human_seat"]);
        const canBroadcast = optionalBooleanValue(envelope.payload["can_broadcast"]);
        const receivesAllDirect = optionalBooleanValue(envelope.payload["receives_all_direct"]);
        const role = store.updateRole(cubeId, roleId!, {
          ...(name === undefined ? {} : { name }),
          ...(shortDescription === undefined ? {} : { shortDescription }),
          ...(detailedDescription === undefined ? {} : { detailedDescription }),
          ...(isDefault === undefined ? {} : { isDefault }),
          ...(isMandatory === undefined ? {} : { isMandatory }),
          ...(isHumanSeat === undefined ? {} : { isHumanSeat }),
          ...(canBroadcast === undefined ? {} : { canBroadcast }),
          ...(receivesAllDirect === undefined ? {} : { receivesAllDirect }),
        });
        return success(200, envelope.requestId, { role });
      }
      if (resource === "role" && sectionPatch && request.method === "POST") {
        const envelope = decodeEnvelope(request.body);
        const action = envelope.payload["action"];
        if (action === "delete") {
          exactKeys(envelope.payload, ["action", "heading"]);
          const role = store.patchRoleSection(cubeId, roleId!, {
            action,
            heading: requiredSectionHeading(envelope.payload, "heading"),
          });
          return success(200, envelope.requestId, { role });
        }
        if (action !== "replace" && action !== "insert") throw new InputError();
        exactKeys(envelope.payload, ["action", "heading", "body"], action === "insert" ? ["after"] : []);
        const body = optionalText(envelope.payload, "body", 51_200);
        if (body === undefined) throw new InputError();
        const heading = requiredSectionHeading(envelope.payload, "heading");
        if (action === "replace") {
          return success(200, envelope.requestId, {
            role: store.patchRoleSection(cubeId, roleId!, { action, heading, body }),
          });
        }
        const after = optionalNullableSectionHeading(envelope.payload["after"]);
        return success(200, envelope.requestId, {
          role: store.patchRoleSection(cubeId, roleId!, {
            action,
            heading,
            body,
            ...(after === undefined ? {} : { after }),
          }),
        });
      }
      if (resource === "drones" && request.method === "GET") {
        return success(200, "drones-read", { drones: store.listDrones(cubeId) });
      }
      if (resource === "logs" && request.method === "POST") {
        const envelope = decodeEnvelope(request.body);
        exactKeys(envelope.payload, ["message"], ["visibility", "recipientDroneIds"]);
        const message = requiredString(envelope.payload, "message", 10_240);
        const visibility = optionalVisibility(envelope.payload["visibility"]);
        const recipientDroneIds = optionalUuidArray(envelope.payload["recipientDroneIds"]);
        if (((visibility ?? "broadcast") === "broadcast" && recipientDroneIds !== undefined) ||
            (visibility === "direct" && (recipientDroneIds?.length ?? 0) === 0)) {
          throw new InputError();
        }
        const entry = store.appendLog(cubeId, {
          message,
          ...(visibility === undefined ? {} : { visibility }),
          ...(recipientDroneIds === undefined ? {} : { recipientDroneIds }),
        });
        return success(201, envelope.requestId, { entry });
      }
      if (resource === "logs" && request.method === "PUT") {
        const envelope = decodeEnvelope(request.body);
        exactKeys(envelope.payload, ["cursor"], ["limit"]);
        const cursor = decodeCursor(envelope.payload["cursor"]);
        const limit = optionalLimit(envelope.payload["limit"]);
        return success(200, envelope.requestId, store.readLog(cubeId, cursor, limit));
      }
      if (resource === "acks" && request.method === "POST") {
        const envelope = decodeEnvelope(request.body);
        const entryId = requiredUuid(envelope.payload, "entry_id");
        const kind = envelope.payload["kind"];
        if (kind !== "ack" && kind !== "claim") throw new InputError();
        exactKeys(envelope.payload, ["entry_id", "kind"]);
        store.acknowledge(cubeId, entryId, kind);
        return { status: 204 };
      }
      if (resource === "decisions" && request.method === "POST") {
        const envelope = decodeEnvelope(request.body);
        exactKeys(envelope.payload, ["topic", "decision"], ["rationale"]);
        const topic = requiredString(envelope.payload, "topic", 120);
        const decision = requiredString(envelope.payload, "decision", 100_000);
        const rationale = optionalString(envelope.payload, "rationale", 100_000);
        return success(201, envelope.requestId, {
          decision: store.recordDecision(cubeId, {
            topic,
            decision,
            ...(rationale === undefined ? {} : { rationale }),
          }),
        });
      }
      if (resource === "decisions" && request.method === "PUT") {
        const envelope = decodeEnvelope(request.body);
        exactKeys(envelope.payload, []);
        return success(200, envelope.requestId, { decisions: store.listDecisions(cubeId) });
      }
      if (resource === "stream" && request.method === "GET") {
        return await this.#openStream(authentication, cubeId, decodeOpaqueCursor(request.cursor), request.signal);
      }
      return failure(405, "INVALID_INPUT", "Method not allowed.");
    } catch (error) {
      if (error instanceof CursorExpiredError) {
        return failure(410, "CURSOR_EXPIRED", error.message);
      }
      if (error instanceof ScopedStoreError) {
        return failure(404, "NOT_FOUND", error.message);
      }
      if (error instanceof RoleConflictError) {
        return failure(409, error.code, error.message, safeRequestId(request.body));
      }
      if (error instanceof DefaultRoleRequiredError) {
        return failure(409, error.code, error.message, safeRequestId(request.body));
      }
      if (error instanceof RoleSectionConflictError) {
        return failure(409, error.code, error.message, safeRequestId(request.body));
      }
      if (error instanceof StorageCapacityError) {
        return failure(507, "CAPACITY_EXCEEDED", error.message, safeRequestId(request.body));
      }
      if (error instanceof InputError || error instanceof TypeError || error instanceof RangeError) {
        return failure(400, "INVALID_INPUT", "Invalid protocol request.", safeRequestId(request.body));
      }
      throw error;
    }
  }

  async #openStream(
    principal: Principal,
    cubeId: string,
    cursor: LogCursor | null,
    requestSignal: AbortSignal,
  ): Promise<CoordinationResponse> {
    const store = this.#runtime.forPrincipal(principal);
    const session = this.#authority.registerLiveSession(principal);
    const signal = AbortSignal.any([requestSignal, session.signal]);
    let unsubscribe = (): void => undefined;
    const queue = new AsyncStringQueue(() => {
      unsubscribe();
      session.release();
    });
    const pending: EnrichedActivityRecord[] = [];
    let live = false;
    try {
      unsubscribe = store.subscribeActivity(cubeId, (entry) => {
        if (store.getCube(cubeId) === null) {
          queue.close();
          return;
        }
        if (live) queue.push(encodeLogEvent(entry));
        else if (pending.length >= 200) queue.close();
        else pending.push(entry);
      });
      signal.addEventListener("abort", () => queue.close(), { once: true });
      const replay = store.readLog(cubeId, cursor, 200).entries;
      const barrier = this.#replayBarrier;
      this.#replayBarrier = undefined;
      if (barrier !== undefined) {
        // Signal only after replay is captured and the live listener is installed.
        barrier.markReached();
        await barrier.release;
      }
      const seen = new Set(replay.map(cursorKey));
      for (const entry of replay) queue.push(encodeLogEvent(entry));
      for (const entry of pending) {
        if (!seen.has(cursorKey(entry)) && afterCursor(entry, cursor)) {
          seen.add(cursorKey(entry));
          queue.push(encodeLogEvent(entry));
        }
      }
      queue.push(`event: bookmark\ndata: ${JSON.stringify({
        as_of: new Date().toISOString(),
        replay_complete: true,
      })}\n\n`);
      live = true;
      return { status: 200, stream: queue };
    } catch (error) {
      queue.close();
      if (error instanceof CursorExpiredError) return failure(410, "CURSOR_EXPIRED", error.message);
      if (error instanceof ScopedStoreError) return failure(404, "NOT_FOUND", error.message);
      throw error;
    }
  }
}

class InputError extends Error {}

class AsyncStringQueue implements AsyncIterable<string> {
  readonly #values: string[] = [];
  readonly #waiters: Array<(result: IteratorResult<string>) => void> = [];
  readonly #cleanup: () => void;
  #closed = false;

  constructor(cleanup: () => void) {
    this.#cleanup = cleanup;
  }

  push(value: string): void {
    if (this.#closed) return;
    if (this.#values.length >= 200) {
      this.close();
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ value, done: false });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cleanup();
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise<IteratorResult<string>>((resolve) => this.#waiters.push(resolve));
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

function decodeEnvelope(value: unknown): RequestEnvelope {
  const record = object(value);
  exactKeys(record, ["protocol_version", "request_id", "payload"]);
  if (record["protocol_version"] !== "1") throw new InputError();
  const requestId = record["request_id"];
  if (typeof requestId !== "string" || !/^[A-Za-z0-9._-]{8,128}$/u.test(requestId)) {
    throw new InputError();
  }
  return { requestId, payload: object(record["payload"]) };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InputError();
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key)) ||
      Object.keys(record).some((key) => !allowed.has(key))) throw new InputError();
}

function requiredString(record: Record<string, unknown>, key: string, maxBytes: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maxBytes) {
    throw new InputError();
  }
  return value;
}

function requiredPresentationName(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/u.test(value)) throw new InputError();
  return value;
}

function requiredRoleName(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length < 1 || value.length > 64) throw new InputError();
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return requiredString(record, key, maxBytes);
}

function optionalText(
  record: Record<string, unknown>,
  key: string,
  maxCharacters: number,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxCharacters) throw new InputError();
  return value;
}

function optionalBoolean(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new InputError();
  return value;
}

function optionalBooleanValue(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new InputError();
  return value;
}

function requiredSectionHeading(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key, 60);
  const heading = value.trim();
  if (heading.length === 0 || /^\s/u.test(value) || /[:\n\r]/u.test(heading) ||
      /^[*\-#>`]/u.test(heading)) throw new InputError();
  return heading;
}

function optionalNullableSectionHeading(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requiredSectionHeading({ value }, "value");
}

function requiredUuid(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new InputError();
  return value.toLowerCase();
}

function optionalVisibility(value: unknown): "broadcast" | "direct" | undefined {
  if (value === undefined) return undefined;
  if (value !== "broadcast" && value !== "direct") throw new InputError();
  return value;
}

function optionalUuidArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100 ||
      value.some((item) => typeof item !== "string" || !uuidPattern.test(item))) throw new InputError();
  return value as string[];
}

function optionalLimit(value: unknown): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 500) {
    throw new InputError();
  }
  return value as number;
}

function decodeCursor(value: unknown): LogCursor | null {
  if (value === null) return null;
  const record = object(value);
  exactKeys(record, ["id", "created_at"]);
  const id = requiredUuid(record, "id");
  const createdAt = record["created_at"];
  if (typeof createdAt !== "string" || !timestampPattern.test(createdAt) ||
      new Date(createdAt).toISOString() !== createdAt) throw new InputError();
  return { id, created_at: createdAt };
}

function decodeOpaqueCursor(value: string | undefined): LogCursor | null {
  if (value === undefined) return null;
  try {
    return decodeCursor(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new InputError();
  }
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const requestId = (value as Record<string, unknown>)["request_id"];
  return typeof requestId === "string" && /^[A-Za-z0-9._-]{8,128}$/u.test(requestId)
    ? requestId
    : undefined;
}

function success(status: number, requestId: string, payload: unknown): CoordinationResponse {
  return { status, body: { protocol_version: "1", request_id: requestId, payload } };
}

function failure(
  status: number,
  code: string,
  message: string,
  requestId?: string,
): CoordinationResponse {
  return {
    status,
    body: {
      protocol_version: "1",
      ...(requestId === undefined ? {} : { request_id: requestId }),
      error: { code, message },
    },
  };
}

function encodeLogEvent(entry: EnrichedActivityRecord): string {
  return `event: log\nid: ${entry.id}\ndata: ${JSON.stringify({
    cursor: { id: entry.id, created_at: entry.created_at },
    entry,
  })}\n\n`;
}

function cursorKey(entry: EnrichedActivityRecord): string {
  return `${entry.created_at}\0${entry.id}`;
}

function afterCursor(entry: EnrichedActivityRecord, cursor: LogCursor | null): boolean {
  return cursor === null || entry.created_at > cursor.created_at ||
    (entry.created_at === cursor.created_at && entry.id > cursor.id);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
