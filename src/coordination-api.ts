import { randomUUID } from "node:crypto";
import {
  ATTACH_PATH,
  ErrorCode,
  PROTOCOL_VERSION,
  ProtocolContractError,
  createProtocolEnvelope,
  decodeAttachRequestEnvelope,
  decodeCreateCubeRequestEnvelope,
  decodeDroneRuntimeMetadataPatch,
  decodeEvictDroneRequestEnvelope,
  decodeProtocolEnvelope,
  decodeReassignDroneRequestEnvelope,
} from "borgmcp-shared/protocol";
import type { Principal } from "./principal.js";
import { assertServerDerivedPrincipal } from "./principal.js";
import { disabledDebugLogger, type DebugLogger } from "./debug-log.js";
import {
  patchMessageTaxonomy,
  resolveMessageRouting,
  validateMessageTaxonomy,
} from "./message-taxonomy.js";
import type { CredentialAuthority } from "./credentials.js";
import {
  CursorExpiredError,
  AttachDroneEvictedError,
  AttachSessionRejectedError,
  AttachSessionRevokedError,
  AccessDeniedError,
  CreateCubeConflictError,
  DefaultRoleRequiredError,
  RoleConflictError,
  RoleInUseError,
  RoleSectionConflictError,
  ScopedStoreError,
  StorageCapacityError,
  type DroneRecord,
  type ActivityPage,
  type ActivityStreamRecord,
  type CubeRecord,
  type LogCursor,
  type StoreRuntime,
} from "./store.js";

export interface CoordinationRequest {
  readonly method: string;
  readonly path: string;
  readonly principal: Principal;
  readonly body?: unknown;
  readonly cursor?: string;
  readonly since?: string;
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
  readonly #debugLogger: DebugLogger;
  readonly #streamHeartbeatMs: number;
  #replayBarrier: ReplayBarrier | undefined;

  constructor(
    runtime: StoreRuntime,
    authority: CredentialAuthority,
    debugLogger: DebugLogger = disabledDebugLogger,
    streamHeartbeatMs = 5_000,
  ) {
    this.#runtime = runtime;
    this.#authority = authority;
    this.#debugLogger = debugLogger;
    this.#streamHeartbeatMs = streamHeartbeatMs;
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

    if (request.path === ATTACH_PATH && request.method === "POST") {
      const requestId = safeRequestId(request.body);
      try {
        const envelope = decodeAttachRequestEnvelope(request.body);
        const priorDroneId = envelope.payload.prior_drone_id;
        const attachment = this.#authority.attachSeat(
          this.#runtime.forPrincipal(authentication),
          {
            cubeId: envelope.payload.cube_id,
            roleId: envelope.payload.role_id,
            sessionCredential: envelope.payload.session_credential,
            ...(priorDroneId === undefined ? {} : { priorDroneId }),
            ...(envelope.payload.runtime_metadata === undefined
              ? {}
              : { runtimeMetadata: envelope.payload.runtime_metadata }),
          },
        );
        return success(200, envelope.request_id, {
          result: attachment.result,
          cube: attachment.cube,
          role: attachment.role,
          drone: attachment.drone,
          session: {
            id: attachment.sessionId,
          },
        });
      } catch (error) {
        if (error instanceof ProtocolContractError) {
          return error.code === ErrorCode.UNSUPPORTED_PROTOCOL_VERSION
            ? failure(426, error.code, "Unsupported protocol version.", requestId)
            : failure(400, "INVALID_INPUT", "Invalid protocol request.", requestId);
        }
        if (error instanceof AttachDroneEvictedError) {
          return failure(410, ErrorCode.DRONE_EVICTED, error.message, requestId);
        }
        if (error instanceof AttachSessionRevokedError) {
          return failure(401, ErrorCode.SESSION_REVOKED, error.message, requestId);
        }
        if (error instanceof AttachSessionRejectedError) {
          return failure(401, ErrorCode.SESSION_REJECTED, error.message, requestId);
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
        message_taxonomy: cube.messageTaxonomy,
        created_at: cube.createdAt,
        updated_at: cube.updatedAt,
      }));
      return success(200, "cubes-read", { cubes });
    }

    if (request.path === "/api/cubes" && request.method === "POST") {
      const requestId = safeRequestId(request.body);
      try {
        const envelope = decodeCreateCubeRequestEnvelope(request.body);
        const created = this.#runtime.forPrincipal(authentication).createCube({
          retryKey: envelope.payload.retry_key,
          name: envelope.payload.name,
          workingRepoName: envelope.payload.working_repo_name,
          repository: envelope.payload.repository,
          template: envelope.payload.template,
        });
        return success(201, envelope.request_id, {
          result: created.result,
          cube_id: created.cubeId,
          name: created.name,
          working_repo_name: created.workingRepoName,
          repository: created.repository,
          template: created.template,
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
        if (error instanceof ProtocolContractError) {
          return error.code === ErrorCode.UNSUPPORTED_PROTOCOL_VERSION
            ? failure(426, error.code, "Unsupported protocol version.", requestId)
            : failure(400, "INVALID_INPUT", "Invalid protocol request.", requestId);
        }
        if (error instanceof InputError || error instanceof TypeError || error instanceof RangeError) {
          return failure(400, "INVALID_INPUT", "Invalid protocol request.", requestId);
        }
        throw error;
      }
    }

    const roleMatch = /^\/api\/cubes\/([0-9a-f-]{36})\/roles\/([0-9a-f-]{36})(\/section-patch)?$/u
      .exec(request.path);
    const droneMatch = /^\/api\/cubes\/([0-9a-f-]{36})\/drones\/([0-9a-f-]{36})$/u
      .exec(request.path);
    const selfMetadataMatch =
      /^\/api\/cubes\/([0-9a-f-]{36})\/drones\/self\/metadata$/u.exec(request.path);
    const match = /^\/api\/cubes\/([0-9a-f-]{36})(?:\/(roles|drones|logs|acks|decisions|stream|taxonomy-patch))?$/u
      .exec(request.path);
    if (match === null && roleMatch === null && droneMatch === null && selfMetadataMatch === null) {
      return failure(404, "NOT_FOUND", "The requested resource was not found.");
    }
    const cubeId = (roleMatch?.[1] ?? droneMatch?.[1] ?? selfMetadataMatch?.[1] ?? match?.[1])!;
    const roleId = roleMatch?.[2];
    const droneId = droneMatch?.[2];
    if (!uuidPattern.test(cubeId) || (roleId !== undefined && !uuidPattern.test(roleId)) ||
        (droneId !== undefined && !uuidPattern.test(droneId))) {
      return failure(404, "NOT_FOUND", "The requested resource was not found.");
    }
    const resource = roleMatch !== null
      ? "role"
      : droneMatch !== null
        ? "drone"
        : selfMetadataMatch !== null
          ? "self-metadata"
          : match?.[2];
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
            message_taxonomy: cube.messageTaxonomy,
            created_at: cube.createdAt,
            updated_at: cube.updatedAt,
          },
        });
      }
      if (resource === undefined && request.method === "PATCH") {
        const envelope = decodeEnvelope(request.body);
        exactKeys(envelope.payload, [], ["cube_directive", "message_taxonomy"]);
        if (Object.keys(envelope.payload).length === 0) throw new InputError();
        const directive = optionalText(envelope.payload, "cube_directive", 100_000);
        const messageTaxonomy = optionalMessageTaxonomy(envelope.payload["message_taxonomy"]);
        const cube = store.updateCube(cubeId, {
          ...(directive === undefined ? {} : { directive }),
          ...(messageTaxonomy === undefined ? {} : { messageTaxonomy }),
        });
        return success(200, envelope.requestId, { cube: cubePayload(cube) });
      }
      if (resource === "taxonomy-patch" && request.method === "POST") {
        const envelope = decodeEnvelope(request.body);
        const action = envelope.payload["action"];
        const cube = store.getCube(cubeId);
        if (cube === null) throw new ScopedStoreError();
        if (action === "remove") {
          exactKeys(envelope.payload, ["action", "class"]);
          const messageTaxonomy = patchMessageTaxonomy(cube.messageTaxonomy, {
            action,
            className: requiredString(envelope.payload, "class", 64),
          });
          return success(200, envelope.requestId, {
            cube: cubePayload(store.updateCube(cubeId, { messageTaxonomy })),
          });
        }
        if (action !== "add" && action !== "replace") throw new InputError();
        exactKeys(envelope.payload, ["action", "class_def"]);
        const classDef = validateMessageTaxonomy([envelope.payload["class_def"]])![0]!;
        const messageTaxonomy = patchMessageTaxonomy(cube.messageTaxonomy, { action, classDef });
        return success(200, envelope.requestId, {
          cube: cubePayload(store.updateCube(cubeId, { messageTaxonomy })),
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
          "role_class",
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
          ...(envelope.payload["role_class"] === undefined
            ? {}
            : { roleClass: optionalRoleClass(envelope.payload["role_class"])! }),
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
          "role_class",
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
        const roleClass = optionalRoleClass(envelope.payload["role_class"]);
        const role = store.updateRole(cubeId, roleId!, {
          ...(name === undefined ? {} : { name }),
          ...(shortDescription === undefined ? {} : { shortDescription }),
          ...(detailedDescription === undefined ? {} : { detailedDescription }),
          ...(isDefault === undefined ? {} : { isDefault }),
          ...(isMandatory === undefined ? {} : { isMandatory }),
          ...(isHumanSeat === undefined ? {} : { isHumanSeat }),
          ...(canBroadcast === undefined ? {} : { canBroadcast }),
          ...(receivesAllDirect === undefined ? {} : { receivesAllDirect }),
          ...(roleClass === undefined ? {} : { roleClass }),
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
        if (request.since === undefined) {
          return success(200, "drones-read", { drones: store.listDrones(cubeId) });
        }
        const since = decodeSince(request.since);
        return success(200, "drones-read", store.listDronesSince(cubeId, since));
      }
      if (resource === "self-metadata" && request.method === "PATCH") {
        const envelope = decodeProtocolEnvelope(request.body, decodeDroneRuntimeMetadataPatch);
        const state = store.updateOwnRuntimeMetadata(cubeId, envelope.payload);
        return success(200, envelope.request_id, state);
      }
      if (resource === "drone" && request.method === "PATCH") {
        const envelope = decodeReassignDroneRequestEnvelope(request.body);
        const drone = store.reassignDrone(cubeId, droneId!, envelope.payload.role_id);
        return success(200, envelope.request_id, { drone: managedDronePayload(drone) });
      }
      if (resource === "drone" && request.method === "DELETE") {
        const envelope = decodeEvictDroneRequestEnvelope(request.body);
        store.evictDrone(cubeId, droneId!);
        return success(200, envelope.request_id, { drone_id: droneId!, evicted: true });
      }
      if (resource === "logs" && request.method === "POST") {
        const envelope = decodeEnvelope(request.body);
        exactKeys(envelope.payload, ["message"], [
          "visibility", "recipientDroneIds", "class", "to",
        ]);
        const message = requiredString(envelope.payload, "message", 10_240);
        const visibility = optionalVisibility(envelope.payload["visibility"]);
        const recipientDroneIds = optionalUuidArray(envelope.payload["recipientDroneIds"]);
        const className = optionalString(envelope.payload, "class", 64);
        const to = optionalStringArray(envelope.payload["to"]);
        const cube = store.getCube(cubeId);
        if (cube === null) throw new ScopedStoreError();
        const resolved = resolveMessageRouting({
          message,
          ...(visibility === undefined ? {} : { visibility }),
          ...(recipientDroneIds === undefined ? {} : { recipientDroneIds }),
          ...(className === undefined ? {} : { className }),
          ...(to === undefined ? {} : { to }),
        }, cube.messageTaxonomy, store.listRoles(cubeId), store.listDrones(cubeId));
        const entry = store.appendLog(cubeId, {
          message,
          visibility: resolved.visibility,
          ...(resolved.visibility === "direct"
            ? { recipientDroneIds: resolved.recipientDroneIds }
            : {}),
        });
        this.#debugLogger.emit({
          event: "activity_append",
          cubeId,
          entryId: entry.id,
          principal: authentication,
          droneId: entry.drone_id,
          visibility: entry.visibility,
          recipientDroneIds: entry.recipient_drone_ids,
        });
        return success(201, envelope.requestId, { entry });
      }
      if (resource === "logs" && request.method === "PUT") {
        const envelope = decodeEnvelope(request.body);
        exactKeys(envelope.payload, ["cursor"], ["limit"]);
        const cursor = decodeCursor(envelope.payload["cursor"]);
        const limit = optionalLimit(envelope.payload["limit"]);
        const page = store.readLog(cubeId, cursor, limit);
        this.#debugLogger.emit({
          event: "cursor_replay",
          mode: "page",
          cubeId,
          cursorId: cursor?.id ?? null,
          returnedCount: page.entries.length,
          behindBy: page.behind_by,
          truncated: page.has_more,
        });
        return success(200, envelope.requestId, page);
      }
      if (resource === "acks" && request.method === "POST") {
        const envelope = decodeEnvelope(request.body);
        const entryId = requiredUuid(envelope.payload, "entry_id");
        const kind = envelope.payload["kind"];
        if (kind !== "ack" && kind !== "claim") throw new InputError();
        exactKeys(envelope.payload, ["entry_id", "kind"]);
        store.acknowledge(cubeId, entryId, kind);
        this.#debugLogger.emit({ event: "ack_write", cubeId, entryId, kind, principal: authentication });
        return { status: 204 };
      }
      if (resource === "decisions" && request.method === "POST") {
        const envelope = decodeEnvelope(request.body);
        exactKeys(envelope.payload, ["topic", "decision"], ["rationale"]);
        const topic = requiredString(envelope.payload, "topic", 120);
        const decision = requiredString(envelope.payload, "decision", 100_000);
        const rationale = optionalString(envelope.payload, "rationale", 100_000);
        const decisionRecord = store.recordDecision(cubeId, {
            topic,
            decision,
            ...(rationale === undefined ? {} : { rationale }),
          });
        this.#debugLogger.emit({
          event: "decision_write",
          cubeId,
          decisionId: decisionRecord.id,
          principal: authentication,
        });
        return success(201, envelope.requestId, { decision: decisionRecord });
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
      if (error instanceof AccessDeniedError) {
        return failure(403, ErrorCode.ACCESS_DENIED, error.message);
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
      if (error instanceof RoleInUseError) {
        return failure(409, error.code, error.message, safeRequestId(request.body));
      }
      if (error instanceof StorageCapacityError) {
        return failure(507, "CAPACITY_EXCEEDED", error.message, safeRequestId(request.body));
      }
      if (error instanceof ProtocolContractError) {
        return error.code === ErrorCode.UNSUPPORTED_PROTOCOL_VERSION
          ? failure(426, error.code, "Unsupported protocol version.", safeRequestId(request.body))
          : failure(400, "INVALID_INPUT", "Invalid protocol request.", safeRequestId(request.body));
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
    const connectionId = randomUUID();
    const session = this.#authority.registerLiveSession(principal);
    const signal = AbortSignal.any([requestSignal, session.signal]);
    let unsubscribe = (): void => undefined;
    let subscribed = false;
    let deliveryCount = 0;
    let heartbeat: NodeJS.Timeout | undefined;
    const queue = new AsyncStringQueue(() => {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      unsubscribe();
      session.release();
      if (subscribed) {
        this.#debugLogger.emit({
          event: "sse_unsubscribe",
          connectionId,
          cubeId,
          principal,
          deliveryCount,
        });
      }
    }, () => { deliveryCount += 1; });
    let replayDirty = false;
    const pendingNotifications: ActivityStreamRecord[] = [];
    let notificationIndex = 0;
    let live = false;
    try {
      unsubscribe = store.subscribeActivity(cubeId, (entry) => {
        if (store.getCube(cubeId) === null) {
          queue.close();
          return;
        }
        if (live) queue.push(encodeLogEvent(entry));
        else if ("kind" in entry) pendingNotifications.push(entry);
        else replayDirty = true;
      });
      subscribed = true;
      signal.addEventListener("abort", () => queue.close(), { once: true });
      const firstPage = store.readLog(cubeId, cursor, 200);
      this.#logReplayPage(cubeId, cursor, firstPage);
      const barrier = this.#replayBarrier;
      this.#replayBarrier = undefined;
      if (barrier !== undefined) {
        // Signal only after replay is captured and the live listener is installed.
        barrier.markReached();
        await barrier.release;
      }
      void (async () => {
        let page = firstPage;
        let replayCursor = cursor;
        let replayCount = 0;
        try {
          for (;;) {
            for (const entry of page.entries) {
              if (!await queue.write(encodeLogEvent(entry))) return;
              replayCursor = { id: entry.id, created_at: entry.created_at };
              replayCount += 1;
            }
            if (page.has_more || replayDirty) {
              replayDirty = false;
              page = store.readLog(cubeId, replayCursor, 200);
              this.#logReplayPage(cubeId, replayCursor, page);
              continue;
            }

            while (notificationIndex < pendingNotifications.length) {
              if (!await queue.write(encodeLogEvent(pendingNotifications[notificationIndex]!))) return;
              notificationIndex += 1;
            }

            // Reserve room for the bookmark before making live callbacks visible.
            // Any append while waiting marks replay dirty and is fetched first.
            if (!await queue.waitForSpace()) return;
            if (replayDirty || notificationIndex < pendingNotifications.length) {
              replayDirty = false;
              page = store.readLog(cubeId, replayCursor, 200);
              this.#logReplayPage(cubeId, replayCursor, page);
              continue;
            }
            queue.push(`event: bookmark\ndata: ${JSON.stringify({
              as_of: new Date().toISOString(),
              replay_complete: true,
            })}\n\n`);
            live = true;
            heartbeat = setInterval(() => {
              queue.tryPush(encodeHeartbeat());
            }, this.#streamHeartbeatMs);
            heartbeat.unref();
            this.#debugLogger.emit({
              event: "sse_subscribe",
              connectionId,
              cubeId,
              principal,
              replayCount,
              truncated: false,
            });
            return;
          }
        } catch {
          queue.close();
        }
      })();
      return { status: 200, stream: queue };
    } catch (error) {
      queue.close();
      if (error instanceof CursorExpiredError) return failure(410, "CURSOR_EXPIRED", error.message);
      if (error instanceof ScopedStoreError) return failure(404, "NOT_FOUND", error.message);
      throw error;
    }
  }

  #logReplayPage(
    cubeId: string,
    cursor: LogCursor | null,
    page: ActivityPage,
  ): void {
    this.#debugLogger.emit({
      event: "cursor_replay",
      mode: "sse",
      cubeId,
      cursorId: cursor?.id ?? null,
      returnedCount: page.entries.length,
      behindBy: page.behind_by,
      truncated: page.has_more,
    });
  }
}

class InputError extends Error {}

class AsyncStringQueue implements AsyncIterable<string> {
  readonly #values: string[] = [];
  readonly #waiters: Array<(result: IteratorResult<string>) => void> = [];
  readonly #spaceWaiters: Array<(available: boolean) => void> = [];
  readonly #cleanup: () => void;
  readonly #onDelivered: () => void;
  #closed = false;

  constructor(cleanup: () => void, onDelivered: () => void = () => undefined) {
    this.#cleanup = cleanup;
    this.#onDelivered = onDelivered;
  }

  push(value: string): void {
    if (this.#closed) return;
    if (this.#values.length >= 200) {
      this.close();
      return;
    }
    this.#enqueue(value);
  }

  tryPush(value: string): boolean {
    if (this.#closed || this.#values.length >= 200) return false;
    this.#enqueue(value);
    return true;
  }

  async write(value: string): Promise<boolean> {
    while (!this.#closed && this.#values.length >= 200) {
      if (!await this.waitForSpace()) return false;
    }
    if (this.#closed) return false;
    this.#enqueue(value);
    return true;
  }

  waitForSpace(): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    if (this.#values.length < 200) return Promise.resolve(true);
    return new Promise((resolve) => this.#spaceWaiters.push(resolve));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cleanup();
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
    for (const waiter of this.#spaceWaiters.splice(0)) waiter(false);
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) {
          this.#spaceWaiters.shift()?.(true);
          this.#onDelivered();
          return { value, done: false };
        }
        if (this.#closed) return { value: undefined, done: true };
        return new Promise<IteratorResult<string>>((resolve) => this.#waiters.push(resolve));
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }

  #enqueue(value: string): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else {
      this.#onDelivered();
      waiter({ value, done: false });
    }
  }
}

function decodeEnvelope(value: unknown): RequestEnvelope {
  const envelope = decodeProtocolEnvelope(value, object);
  return { requestId: envelope.request_id, payload: envelope.payload };
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

function optionalRoleClass(value: unknown): "queen" | "worker" | undefined {
  if (value === undefined) return undefined;
  if (value !== "queen" && value !== "worker") throw new InputError();
  return value;
}

function optionalMessageTaxonomy(value: unknown) {
  return value === undefined ? undefined : validateMessageTaxonomy(value);
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 ||
      value.some((entry) => typeof entry !== "string" || entry.length < 1 || entry.length > 120)) {
    throw new InputError();
  }
  const entries = value as string[];
  if (new Set(entries).size !== entries.length) throw new InputError();
  return entries;
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

function decodeSince(value: string): string {
  if (uuidPattern.test(value)) return value.toLowerCase();
  if (timestampPattern.test(value) && new Date(value).toISOString() === value) return value;
  throw new InputError();
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const requestId = (value as Record<string, unknown>)["request_id"];
  return typeof requestId === "string" && /^[A-Za-z0-9._-]{8,128}$/u.test(requestId)
    ? requestId
    : undefined;
}

function success(status: number, requestId: string, payload: unknown): CoordinationResponse {
  return { status, body: createProtocolEnvelope(requestId, payload) };
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
      protocol_version: PROTOCOL_VERSION,
      ...(requestId === undefined ? {} : { request_id: requestId }),
      error: { code, message },
    },
  };
}

function encodeLogEvent(entry: ActivityStreamRecord): string {
  if ("kind" in entry) {
    return `event: log\nid: ${entry.id}\ndata: ${JSON.stringify({ entry })}\n\n`;
  }
  return `event: log\nid: ${entry.id}\ndata: ${JSON.stringify({
    cursor: { id: entry.id, created_at: entry.created_at },
    entry,
  })}\n\n`;
}

function encodeHeartbeat(): string {
  return `event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`;
}

function cubePayload(cube: CubeRecord) {
  return {
    id: cube.id,
    owner_id: cube.ownerId,
    name: cube.name,
    cube_directive: cube.directive,
    message_taxonomy: cube.messageTaxonomy,
    created_at: cube.createdAt,
    updated_at: cube.updatedAt,
  };
}

function managedDronePayload(drone: DroneRecord) {
  return {
    id: drone.id,
    cube_id: drone.cube_id,
    role_id: drone.role_id,
    label: drone.label,
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
