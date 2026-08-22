export const SLOW_RUNTIME_OPERATION_MS = 1_000;

export type RuntimeRequestPath =
  | "/healthz"
  | "/api/protocol"
  | "/api/runtime"
  | "/api/enrollment/exchange"
  | "/api/client/attach"
  | "/api/repository-cubes/resolve"
  | "/api/repository-cubes/association"
  | "/api/cubes"
  | "/api/cubes/:cube_id"
  | "/api/cubes/:cube_id/roles"
  | "/api/cubes/:cube_id/roles/:role_id"
  | "/api/cubes/:cube_id/roles/:role_id/section-patch"
  | "/api/cubes/:cube_id/taxonomy-patch"
  | "/api/cubes/:cube_id/drones"
  | "/api/cubes/:cube_id/drones/self/metadata"
  | "/api/cubes/:cube_id/logs"
  | "/api/cubes/:cube_id/logs/:entry_id"
  | "/api/cubes/:cube_id/logs/:entry_id/ack-status"
  | "/api/cubes/:cube_id/acks"
  | "/api/cubes/:cube_id/decisions"
  | "/api/cubes/:cube_id/documents"
  | "/api/cubes/:cube_id/stream"
  | "unknown";

export type RuntimeLogEvent =
  | {
      readonly event: "request" | "slow_request";
      readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OTHER";
      readonly path: RuntimeRequestPath;
      readonly status: number;
      readonly elapsedMs: number;
    }
  | { readonly event: "liveness_scan_start" }
  | {
      readonly event: "liveness_scan_end" | "slow_liveness_scan";
      readonly elapsedMs: number;
      readonly candidateCount: number;
      readonly outcome: "success" | "failure";
    }
  | {
      readonly event: "activity_append";
      readonly transactionElapsedMs: number;
      readonly pruneElapsedMs: number;
    }
  | {
      readonly event: "activity_read";
      readonly elapsedMs: number;
      readonly pageSize: number;
      readonly enrichedEntryCount: number;
    };

export interface RuntimeLogger {
  readonly emit: (event: RuntimeLogEvent) => void;
}

export const disabledRuntimeLogger: RuntimeLogger = Object.freeze({ emit: () => undefined });

export function createRuntimeLogger(write: ((line: string) => void) | undefined): RuntimeLogger {
  if (write === undefined) return disabledRuntimeLogger;
  return Object.freeze({
    emit(event: RuntimeLogEvent): void {
      try {
        write(JSON.stringify(projectRuntimeEvent(event)));
      } catch {
        // Runtime diagnostics cannot alter request or server behavior.
      }
    },
  });
}

export function elapsedMilliseconds(startedAt: number, clock: () => number): number {
  return Math.max(0, Math.round(clock() - startedAt));
}

function projectRuntimeEvent(event: RuntimeLogEvent): Record<string, unknown> {
  const level = event.event.startsWith("slow_") ? "warn" : "info";
  switch (event.event) {
    case "request":
    case "slow_request":
      return {
        level,
        event: event.event,
        method: event.method,
        path: event.path,
        status: event.status,
        elapsed_ms: event.elapsedMs,
      };
    case "liveness_scan_start":
      return { level, event: event.event };
    case "liveness_scan_end":
    case "slow_liveness_scan":
      return {
        level,
        event: event.event,
        elapsed_ms: event.elapsedMs,
        candidate_count: event.candidateCount,
        outcome: event.outcome,
      };
    case "activity_append":
      return {
        level,
        event: event.event,
        transaction_elapsed_ms: event.transactionElapsedMs,
        prune_elapsed_ms: event.pruneElapsedMs,
      };
    case "activity_read":
      return {
        level,
        event: event.event,
        elapsed_ms: event.elapsedMs,
        page_size: event.pageSize,
        enriched_entry_count: event.enrichedEntryCount,
      };
  }
}
