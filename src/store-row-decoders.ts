import type { MessageTaxonomy } from "borgmcp-shared/domain";
import type {
  CubeDocument,
  CubeDocumentMetadata,
  DocumentCitation,
  DocumentContentType,
  DroneRuntimeMetadata,
} from "borgmcp-shared/protocol";

import { validateMessageTaxonomy } from "./message-taxonomy.js";
import type { Principal } from "./principal.js";
import type {
  ActivityRecord,
  AppendLogRecord,
  CubeRecord,
  DecisionRecord,
  DroneRecord,
  EnrichedActivityRecord,
  RoleRecord,
  RuntimeMetadataState,
  StoredDroneSessionDigest,
  StoredInvitationDigest,
  StoredSecretDigest,
} from "./store.js";

interface CubeRow {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly directive: string;
  readonly message_taxonomy: string | null;
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

export function cubeRecord(row: CubeRow): CubeRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    directive: row.directive,
    messageTaxonomy: parseTaxonomy(row.message_taxonomy),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function activityRecord(row: ActivityRow): ActivityRecord {
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

export function cubeRow(row: Record<string, unknown>): CubeRow {
  return {
    id: requiredText(row, "id"),
    owner_id: requiredText(row, "owner_id"),
    name: requiredText(row, "name"),
    directive: requiredText(row, "directive"),
    message_taxonomy: nullableText(row, "message_taxonomy"),
    created_at: requiredText(row, "created_at"),
    updated_at: requiredText(row, "updated_at"),
  };
}

export function activityRow(row: Record<string, unknown>): ActivityRow {
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

export function enrichedActivityRecord(
  row: Record<string, unknown>,
  recipientDroneIds: string[],
  wakeNonce?: string,
  documents: DocumentCitation[] = [],
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
    ...(documents.length === 0 ? {} : { documents }),
    ...(wakeNonce === undefined ? {} : { wake_nonce: wakeNonce }),
  };
}

export function appendLogRecord(
  entry: EnrichedActivityRecord,
  deduplicated: boolean,
): AppendLogRecord {
  const result = { ...entry } as EnrichedActivityRecord & { deduplicated?: boolean };
  Object.defineProperty(result, "deduplicated", { value: deduplicated, enumerable: false });
  return result as AppendLogRecord;
}

export function documentCitationRecord(row: Record<string, unknown>): DocumentCitation {
  return {
    id: requiredText(row, "id"),
    title: requiredText(row, "title"),
    size_bytes: requiredInteger(row, "size_bytes"),
    state: documentState(row),
  };
}

export function documentMetadataRecord(row: Record<string, unknown>): CubeDocumentMetadata {
  const removedAt = nullableText(row, "removed_at");
  return {
    ...documentCitationRecord(row),
    content_type: documentContentType(row),
    supersedes: nullableText(row, "supersedes"),
    superseded_by: nullableText(row, "superseded_by"),
    author: {
      drone_id: nullableText(row, "author_drone_id"),
      label: nullableText(row, "author_label"),
      role: nullableText(row, "author_role"),
    },
    created_at: requiredText(row, "created_at"),
    removed_by: removedAt === null
      ? null
      : {
          drone_id: nullableText(row, "removed_by_drone_id"),
          label: nullableText(row, "removed_by_label"),
          role: nullableText(row, "removed_by_role"),
        },
    removed_at: removedAt,
  };
}

export function documentRecord(row: Record<string, unknown>): CubeDocument {
  return { ...documentMetadataRecord(row), content: requiredText(row, "content") };
}

function documentState(row: Record<string, unknown>): CubeDocumentMetadata["state"] {
  const state = requiredText(row, "state");
  if (state !== "active" && state !== "superseded" && state !== "removed") {
    throw new Error("Database contains invalid document state.");
  }
  return state;
}

function documentContentType(row: Record<string, unknown>): DocumentContentType {
  const contentType = requiredText(row, "content_type");
  if (contentType !== "text/markdown" && contentType !== "text/plain") {
    throw new Error("Database contains invalid document content type.");
  }
  return contentType;
}

export function decisionRecord(row: Record<string, unknown>): DecisionRecord {
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

export function roleRecord(row: Record<string, unknown>): RoleRecord {
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

export function droneRecord(row: Record<string, unknown>): DroneRecord {
  const posture = requiredText(row, "posture");
  if (posture !== "observer" && posture !== "participant") {
    throw new Error("Database contains invalid drone posture.");
  }
  return {
    id: requiredText(row, "id"),
    cube_id: requiredText(row, "cube_id"),
    role_id: requiredText(row, "role_id"),
    label: requiredText(row, "label"),
    last_seen: requiredText(row, "last_seen"),
    hostname: nullableText(row, "hostname"),
    posture,
    ...runtimeMetadataFlat(row),
    created_at: requiredText(row, "created_at"),
    wake_state: "idle",
  };
}

export function requiredDroneWakeState(row: Record<string, unknown>): DroneRecord["wake_state"] {
  const wakeState = requiredText(row, "wake_state");
  if (wakeState !== "idle" && wakeState !== "pending" && wakeState !== "awake" && wakeState !== "stale") {
    throw new Error("Database produced an invalid drone wake state.");
  }
  return wakeState;
}

export const EMPTY_RUNTIME_METADATA: DroneRuntimeMetadata = Object.freeze({
  agent_kind: null,
  reported_model: null,
  working_repo_name: null,
  working_repo_origin: null,
});

function runtimeMetadataFlat(row: Record<string, unknown>): DroneRuntimeMetadata & {
  readonly runtime_metadata_reported: boolean;
} {
  const agentKind = nullableText(row, "agent_kind");
  if (agentKind !== null && agentKind !== "claude" &&
      agentKind !== "codex" && agentKind !== "opencode") {
    throw new Error("Database contains invalid agent_kind.");
  }
  return {
    agent_kind: agentKind as DroneRuntimeMetadata["agent_kind"],
    reported_model: nullableText(row, "reported_model"),
    working_repo_name: nullableText(row, "working_repo_name"),
    working_repo_origin: nullableText(row, "working_repo_origin"),
    runtime_metadata_reported: requiredInteger(row, "runtime_metadata_reported") === 1,
  };
}

export function runtimeMetadataState(row: Record<string, unknown>): RuntimeMetadataState {
  const flat = runtimeMetadataFlat(row);
  return {
    runtime_metadata: {
      agent_kind: flat.agent_kind,
      reported_model: flat.reported_model,
      working_repo_name: flat.working_repo_name,
      working_repo_origin: flat.working_repo_origin,
    },
    runtime_metadata_reported: flat.runtime_metadata_reported,
  };
}

export function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || typeof value === "string") return value;
  throw new Error(`Database contains invalid ${key}.`);
}

export function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Database contains invalid ${key}.`);
  return value;
}

export function requiredInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) throw new Error(`Database contains invalid ${key}.`);
  return value as number;
}

export function storedInvitationDigest(row: Record<string, unknown>): StoredInvitationDigest {
  const digest = storedDigest(row);
  const purpose = requiredText(row, "purpose");
  if (purpose !== "owner" && purpose !== "client") {
    throw new Error("Database contains invalid invitation purpose.");
  }
  const epochValue = row["owner_epoch"];
  const ownerEpoch = epochValue === null ? null : requiredInteger(row, "owner_epoch");
  return { ...digest, purpose, ownerEpoch, clientName: nullableText(row, "client_name") };
}

export function storedDroneSessionDigest(row: Record<string, unknown>): StoredDroneSessionDigest {
  const digest = storedDigest(row);
  return {
    ...digest,
    sessionId: requiredText(row, "session_id"),
    clientId: requiredText(row, "client_id"),
    cubeId: requiredText(row, "cube_id"),
    droneId: requiredText(row, "drone_id"),
    evictedAt: nullableText(row, "evicted_at"),
    takenOver: nullableText(row, "superseded_at") !== null,
    cubeDeleted: false,
  };
}

export function storedDeletedCubeSessionDigest(
  row: Record<string, unknown>,
): Extract<StoredDroneSessionDigest, { readonly cubeDeleted: true }> {
  const terminalCause = requiredText(row, "terminal_cause");
  if (terminalCause !== "cube_deleted" && terminalCause !== "drone_evicted") {
    throw new Error("Database contains invalid deleted credential terminal cause.");
  }
  return {
    lookup: requiredBuffer(row, "lookup_digest"),
    verifier: requiredBuffer(row, "verifier_digest"),
    evicted: terminalCause === "drone_evicted",
    cubeDeleted: true,
  };
}

export function storedDigest(row: Record<string, unknown>): StoredSecretDigest {
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

export function requiredBuffer(row: Record<string, unknown>, key: string): Buffer {
  const value = row[key];
  if (!(value instanceof Uint8Array)) throw new Error(`Database contains invalid ${key}.`);
  return Buffer.from(value);
}

export function optionalText(
  row: Record<string, unknown>,
  key: string,
): string | null | undefined {
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

function parseTaxonomy(value: string | null): MessageTaxonomy | null {
  if (value === null) return null;
  try {
    return validateMessageTaxonomy(JSON.parse(value));
  } catch {
    throw new Error("Database contains invalid message taxonomy.");
  }
}
