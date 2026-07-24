import type { Principal } from "./principal.js";

export type DebugRoute =
  | "health"
  | "protocol"
  | "runtime"
  | "enrollment_exchange"
  | "client_attach"
  | "cubes"
  | "cube"
  | "cube_roles"
  | "cube_role"
  | "cube_role_section_patch"
  | "cube_taxonomy_patch"
  | "cube_drones"
  | "cube_drone_self_metadata"
  | "cube_logs"
  | "cube_acks"
  | "cube_decisions"
  | "cube_stream"
  | "unknown";

export type DebugEvent =
  | { readonly event: "startup"; readonly bindMode: "loopback" | "lan"; readonly port: number; readonly dataDirectory: "configured" | "tls_only" }
  | { readonly event: "lifecycle"; readonly action: "listening" | "stopped" }
  | { readonly event: "request"; readonly route: DebugRoute; readonly method: string; readonly authentication: "not_required" | "missing" | "invalid" | "revoked" | "evicted" | "rejected" | "accepted"; readonly authorization: "not_checked" | "accepted" | "denied_or_not_found"; readonly principal?: Principal; readonly status: number; readonly durationMs: number }
  | { readonly event: "activity_append"; readonly cubeId: string; readonly entryId: string; readonly principal: Principal; readonly droneId: string | null; readonly visibility: "broadcast" | "direct"; readonly recipientDroneIds: readonly string[] }
  | { readonly event: "cursor_replay"; readonly mode: "page" | "sse"; readonly cubeId: string; readonly cursorId: string | null; readonly returnedCount: number; readonly behindBy: number; readonly truncated: boolean }
  | { readonly event: "ack_write"; readonly cubeId: string; readonly entryId: string; readonly kind: "ack" | "claim"; readonly principal: Principal }
  | { readonly event: "decision_write"; readonly cubeId: string; readonly decisionId: string; readonly principal: Principal }
  | { readonly event: "sse_subscribe"; readonly connectionId: string; readonly cubeId: string; readonly principal: Principal; readonly replayCount: number; readonly truncated: boolean }
  | { readonly event: "sse_unsubscribe"; readonly connectionId: string; readonly cubeId: string; readonly principal: Principal; readonly deliveryCount: number }
  | { readonly event: "credential"; readonly action: "invitation_created" | "enrollment_accepted" | "enrollment_rejected" | "session_created" | "session_revoked" | "client_rotated" | "client_revoked"; readonly purpose?: "owner" | "client"; readonly clientId?: string; readonly cubeId?: string; readonly droneId?: string; readonly sessionId?: string }
  | { readonly event: "transport_rejection"; readonly reason: "tls_client_error" | "http_parser_error" };

export interface DebugLogger {
  readonly emit: (event: DebugEvent) => void;
}

export const disabledDebugLogger: DebugLogger = Object.freeze({ emit: () => undefined });

export function createDebugLogger(write: ((line: string) => void) | undefined): DebugLogger {
  if (write === undefined) return disabledDebugLogger;
  return Object.freeze({
    emit(event: DebugEvent): void {
      try {
        const projected = projectEvent(event);
        if (projected !== null) write(JSON.stringify({ level: "debug", ...projected }));
      } catch {
        // Operator diagnostics cannot alter request or server behavior.
      }
    },
  });
}

function projectEvent(event: DebugEvent): Record<string, unknown> | null {
  const value = event as unknown as Record<string, unknown>;
  switch (value["event"]) {
    case "startup":
      return {
        event: "startup",
        bind_mode: enumValue(value["bindMode"], ["loopback", "lan"], "loopback"),
        port: boundedInteger(value["port"], 0, 65_535),
        data_directory: enumValue(value["dataDirectory"], ["configured", "tls_only"], "tls_only"),
      };
    case "request": {
      const principal = principalFields(value["principal"]);
      return {
        event: "request",
        route: enumValue(value["route"], DEBUG_ROUTES, "unknown"),
        method: enumValue(value["method"], HTTP_METHODS, "OTHER"),
        authentication: enumValue(value["authentication"], AUTH_RESULTS, "invalid"),
        authorization: enumValue(value["authorization"], AUTHZ_RESULTS, "not_checked"),
        ...principal,
        status: boundedInteger(value["status"], 0, 599),
        duration_ms: boundedInteger(value["durationMs"], 0, Number.MAX_SAFE_INTEGER),
      };
    }
    case "lifecycle":
      return { event: "lifecycle", action: enumValue(value["action"], ["listening", "stopped"], "stopped") };
    case "activity_append":
      return {
        event: "activity_append",
        cube_id: uuid(value["cubeId"]),
        entry_id: uuid(value["entryId"]),
        ...principalFields(value["principal"]),
        drone_id: nullableUuid(value["droneId"]),
        visibility: enumValue(value["visibility"], ["broadcast", "direct"], "broadcast"),
        recipient_count: uuidArray(value["recipientDroneIds"]).length,
        recipient_drone_ids: uuidArray(value["recipientDroneIds"]),
      };
    case "cursor_replay":
      return {
        event: "cursor_replay",
        mode: enumValue(value["mode"], ["page", "sse"], "page"),
        cube_id: uuid(value["cubeId"]),
        cursor_id: nullableUuid(value["cursorId"]),
        returned_count: boundedInteger(value["returnedCount"], 0, 500),
        behind_by: boundedInteger(value["behindBy"], 0, Number.MAX_SAFE_INTEGER),
        truncated: value["truncated"] === true,
      };
    case "ack_write":
      return { event: "ack_write", cube_id: uuid(value["cubeId"]), entry_id: uuid(value["entryId"]), kind: enumValue(value["kind"], ["ack", "claim"], "ack"), ...principalFields(value["principal"]) };
    case "decision_write":
      return { event: "decision_write", cube_id: uuid(value["cubeId"]), decision_id: uuid(value["decisionId"]), ...principalFields(value["principal"]) };
    case "sse_subscribe":
      return { event: "sse_subscribe", connection_id: uuid(value["connectionId"]), cube_id: uuid(value["cubeId"]), ...principalFields(value["principal"]), replay_count: boundedInteger(value["replayCount"], 0, 200), truncated: value["truncated"] === true };
    case "sse_unsubscribe":
      return { event: "sse_unsubscribe", connection_id: uuid(value["connectionId"]), cube_id: uuid(value["cubeId"]), ...principalFields(value["principal"]), delivery_count: boundedInteger(value["deliveryCount"], 0, Number.MAX_SAFE_INTEGER) };
    case "credential":
      return {
        event: "credential",
        action: enumValue(value["action"], CREDENTIAL_ACTIONS, "enrollment_rejected"),
        ...(value["purpose"] === "owner" || value["purpose"] === "client" ? { purpose: value["purpose"] } : {}),
        ...optionalUuid("client_id", value["clientId"]),
        ...optionalUuid("cube_id", value["cubeId"]),
        ...optionalUuid("drone_id", value["droneId"]),
        ...optionalUuid("session_id", value["sessionId"]),
      };
    case "transport_rejection":
      return { event: "transport_rejection", reason: enumValue(value["reason"], ["tls_client_error", "http_parser_error"], "tls_client_error") };
    default:
      return null;
  }
}

function principalFields(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  const principal = value as Record<string, unknown>;
  const kind = enumValue(principal["kind"], ["operator", "client", "drone-session"], "client");
  return { principal_kind: kind, ...optionalUuid("principal_id", principal["id"]) };
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}

function optionalUuid(key: string, value: unknown): Record<string, string> {
  const safe = uuid(value);
  return safe === null ? {} : { [key]: safe };
}

function uuidArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map(uuid).filter((item): item is string => item !== null);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? value as number
    : minimum;
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEBUG_ROUTES: readonly DebugRoute[] = ["health", "protocol", "runtime", "enrollment_exchange", "client_attach", "cubes", "cube", "cube_roles", "cube_role", "cube_role_section_patch", "cube_taxonomy_patch", "cube_drones", "cube_drone_self_metadata", "cube_logs", "cube_acks", "cube_decisions", "cube_stream", "unknown"];
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OTHER"] as const;
const AUTH_RESULTS = ["not_required", "missing", "invalid", "revoked", "evicted", "rejected", "accepted"] as const;
const AUTHZ_RESULTS = ["not_checked", "accepted", "denied_or_not_found"] as const;
const CREDENTIAL_ACTIONS = ["invitation_created", "enrollment_accepted", "enrollment_rejected", "session_created", "session_revoked", "client_rotated", "client_revoked"] as const;
