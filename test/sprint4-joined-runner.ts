/**
 * Persistent, test-only orchestration for the final Sprint 4 joined proof.
 *
 * The companion Vitest file is skipped unless BORG_RUN_S4_JOINED_E2E is exactly
 * "1". This module deliberately owns no production surface.
 */
import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { provisionSprint4E2e, type Sprint4ProvisionedRun } from "./sprint4-e2e-provisioning.js";

export const SPRINT4_CLIENT_SHA = "f7ed0bdb8db983f80ddddec91d6bad7bcf1ee177";
export const SPRINT4_CLIENT_FIXTURE_SHA256 = "838b66f11c869c50d29ffa3a144f1e8143ce8d3eee45ae2421a6d8e0bfeb760a";
export const SPRINT4_EXPECTED_CLIENT_MAIN_SHA = "710e9a90446de07a819291307f6d75f9a21784aa";
export const SPRINT4_JOINED_GATE = "BORG_RUN_S4_JOINED_E2E";
export const SPRINT4_CLIENT_DIRECTORY = "BORG_RQ_CLIENT_DIRECTORY";
export const SPRINT4_RUNNER_TIMEOUT_MS = 20_000;
export const SPRINT4_RUNNER_OUTPUT_LIMIT = 16_384;
export const SPRINT4_CLEANUP_TIMEOUT_MS = 5_000;

export interface JoinedRunnerEnvironment {
  readonly clientDirectory: string;
}

export interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutOverflow: boolean;
  readonly stderrOverflow: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export interface JoinedRunnerDependencies {
  readonly provision?: typeof provisionSprint4E2e;
  readonly verifyClientPins?: typeof verifyClientPins;
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  ) => Promise<SpawnResult>;
}

export function isJoinedRunEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SPRINT4_JOINED_GATE] === "1";
}

export function validateJoinedRunnerEnvironment(env: NodeJS.ProcessEnv = process.env): JoinedRunnerEnvironment {
  if (!isJoinedRunEnabled(env)) throw new Error("Sprint 4 joined runner requires explicit opt-in.");
  if (hasCloudConfiguration(env)) throw new Error("Sprint 4 joined runner refuses Cloud configuration.");
  const clientDirectory = env[SPRINT4_CLIENT_DIRECTORY];
  if (clientDirectory === undefined || !isAbsolute(clientDirectory)) {
    throw new Error("Sprint 4 joined runner requires an absolute disposable client directory.");
  }
  return { clientDirectory: resolve(clientDirectory) };
}

export async function verifyClientPins(clientDirectory: string): Promise<void> {
  const directory = await realpath(clientDirectory);
  if (directory !== clientDirectory) throw new Error("Sprint 4 client directory must be a canonical disposable path.");
  const status = await runBounded("git", ["-C", directory, "status", "--porcelain"], { cwd: directory, env: {} });
  if (status.code !== 0 || status.stdout !== "") {
    throw new Error("Sprint 4 client directory must be a clean disposable worktree.");
  }
  const git = await runBounded("git", ["-C", directory, "rev-parse", "HEAD"], { cwd: directory, env: {} });
  if (git.code !== 0) throw new Error("Sprint 4 client SHA does not match the approved fixture.");
  const fixture = join(directory, "__tests__", "s4-coupled-e2e.test.ts");
  await access(fixture);
  const actualHash = createHash("sha256").update(await readFile(fixture)).digest("hex");
  assertClientPinValues(git.stdout.trim(), actualHash);
}

export function assertClientPinValues(revision: string, fixtureHash: string): void {
  if (revision !== SPRINT4_CLIENT_SHA) throw new Error("Sprint 4 client SHA does not match the approved fixture.");
  if (fixtureHash !== SPRINT4_CLIENT_FIXTURE_SHA256) {
    throw new Error("Sprint 4 client fixture hash does not match the approved fixture.");
  }
}

/** Runs the reviewed client fixture with provisioner-emitted values unchanged. */
export async function executeJoinedRunner(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: JoinedRunnerDependencies = {},
): Promise<Record<string, unknown>> {
  const configuration = validateJoinedRunnerEnvironment(env);
  const verifyPins = dependencies.verifyClientPins ?? verifyClientPins;
  await verifyPins(configuration.clientDirectory);
  const root = await realpath(await mkdtemp(join(tmpdir(), "borg-s4-joined-")));
  let run: Sprint4ProvisionedRun | undefined;
  try {
    run = await (dependencies.provision ?? provisionSprint4E2e)({
      testMode: true,
      dataDirectory: join(root, "server"),
      host: "127.0.0.1",
      port: 0,
    });
    assertProvisionedRun(run);
    const initialFiles = await snapshotOwnedProvisionedFiles(run, root);
    const finalFiles = await snapshotOwnedProvisionedFiles(run, root);
    assertSameProvisionedFiles(initialFiles, finalFiles);
    const caHandoff = await materializeClientCaHandoff(root, finalFiles.trust);
    await verifyPins(configuration.clientDirectory);
    const spawnFiles = await snapshotOwnedProvisionedFiles(run, root);
    assertSameProvisionedFiles(finalFiles, spawnFiles);
    const spawnCaHandoff = await snapshotClientCaHandoff(root, caHandoff.canonicalPath);
    assertSameProvisionedFile(caHandoff, spawnCaHandoff);
    assertSameTrustMaterial(spawnFiles.trust, spawnCaHandoff);
    const clientEnvironment = buildClientFixtureEnvironmentFromSnapshots(
      env,
      configuration.clientDirectory,
      run,
      spawnFiles,
      spawnCaHandoff.canonicalPath,
    );
    const proofBinding = buildProofBinding(run, spawnFiles);
    const result = await (dependencies.spawn ?? runBounded)(
      "npx",
      ["vitest", "run", "__tests__/s4-coupled-e2e.test.ts"],
      {
        cwd: configuration.clientDirectory,
        env: clientEnvironment,
      },
    );
    assertSuccessfulSpawnResult(result);
    const structured = parseStructuredResult(result.stdout);
    assertStructuredResultContract(structured, proofBinding);
    return structured;
  } finally {
    await cleanupJoinedRun(run, root);
  }
}

export function assertSuccessfulSpawnResult(result: SpawnResult): void {
  if (result.stdoutOverflow || result.stderrOverflow) {
    throw new Error("Sprint 4 client fixture output exceeded its bound.");
  }
  if (result.code !== 0) throw new Error("Sprint 4 client fixture failed.");
  if (result.stderr.trim() !== "") throw new Error("Sprint 4 client fixture wrote to stderr.");
}

interface CredentialReference {
  readonly endpoint: string;
  readonly trust_material_reference: string;
  readonly trust_identity: string;
  readonly cube_id: string;
  readonly client_id: string;
  readonly client_credential: string;
  readonly role_id: string;
  readonly drone_id: string;
  readonly session_id: string;
  readonly session_credential: string;
}

interface ClientWriterReference {
  readonly endpoint: string;
  readonly trust_identity: string;
  readonly cube_id: string;
  readonly role_id: string;
  readonly drone_id: string;
  readonly session_id: string;
  readonly session_credential: string;
}

export interface JoinedProofBinding {
  readonly endpoint: string;
  readonly cubeId: string;
  readonly writers: readonly [{ readonly droneId: string; readonly roleId: string; readonly sessionId: string }, { readonly droneId: string; readonly roleId: string; readonly sessionId: string }];
}

/** Maps the reviewed client fixture contract from existing provisioner refs. */
export async function buildClientFixtureEnvironment(
  env: NodeJS.ProcessEnv,
  clientDirectory: string,
  run: Sprint4ProvisionedRun,
): Promise<NodeJS.ProcessEnv> {
  assertProvisionedRun(run);
  const reader = readCredentialReference(await readFile(run.credentialReferences.reader));
  const writers = [
    readCredentialReference(await readFile(run.credentialReferences.writerA)),
    readCredentialReference(await readFile(run.credentialReferences.writerB)),
  ];
  return buildClientFixtureEnvironmentFromReferences(env, clientDirectory, run, reader, writers);
}

function buildClientFixtureEnvironmentFromSnapshots(
  env: NodeJS.ProcessEnv,
  clientDirectory: string,
  run: Sprint4ProvisionedRun,
  files: ProvisionedFileSnapshots,
  caPath: string,
): NodeJS.ProcessEnv {
  return buildClientFixtureEnvironmentFromReferences(
    env,
    clientDirectory,
    run,
    readCredentialReference(files.reader.bytes),
    [readCredentialReference(files.writerA.bytes), readCredentialReference(files.writerB.bytes)],
    caPath,
  );
}

function buildClientFixtureEnvironmentFromReferences(
  env: NodeJS.ProcessEnv,
  clientDirectory: string,
  run: Sprint4ProvisionedRun,
  reader: CredentialReference,
  writers: readonly [CredentialReference, CredentialReference] | CredentialReference[],
  caPath = run.trustMaterialReference,
): NodeJS.ProcessEnv {
  const writerA = writers[0];
  const writerB = writers[1];
  if (writerA === undefined || writerB === undefined) throw new Error("Sprint 4 provisioner returned missing writer references.");
  assertReferenceContract(run, reader, run.clientIds.reader, run.seats.reader);
  assertReferenceContract(run, writerA, run.clientIds.writerA, run.seats.writerA);
  assertReferenceContract(run, writerB, run.clientIds.writerB, run.seats.writerB);
  if (writerA.session_credential === reader.session_credential ||
      writerB.session_credential === reader.session_credential ||
      writerA.session_credential === writerB.session_credential ||
      writerA.drone_id === reader.drone_id ||
      writerB.drone_id === reader.drone_id ||
      writerA.drone_id === writerB.drone_id) {
    throw new Error("Sprint 4 provisioner returned cross-wired session credentials.");
  }
  const clientWriters: readonly [ClientWriterReference, ClientWriterReference] = [
    selectClientWriterReference(writerA),
    selectClientWriterReference(writerB),
  ];
  return {
    ...minimalEnvironment(env),
    [SPRINT4_JOINED_GATE]: "1",
    [SPRINT4_CLIENT_DIRECTORY]: clientDirectory,
    BORG_S4_COUPLED_E2E: "1",
    BORG_E2E_CLIENT_SHA: SPRINT4_EXPECTED_CLIENT_MAIN_SHA,
    BORG_API_URL: run.endpoint,
    BORG_E2E_CA_PATH: caPath,
    BORG_E2E_TRUST_IDENTITY: run.trustIdentity,
    BORG_E2E_CUBE_ID: run.cubeId,
    BORG_E2E_READER_DRONE_ID: reader.drone_id,
    BORG_E2E_READER_TOKEN: reader.session_credential,
    BORG_E2E_WRITER_REFS: JSON.stringify(clientWriters),
  };
}

function selectClientWriterReference(reference: CredentialReference): ClientWriterReference {
  return {
    endpoint: reference.endpoint,
    trust_identity: reference.trust_identity,
    cube_id: reference.cube_id,
    role_id: reference.role_id,
    drone_id: reference.drone_id,
    session_id: reference.session_id,
    session_credential: reference.session_credential,
  };
}

function buildProofBinding(run: Sprint4ProvisionedRun, files: ProvisionedFileSnapshots): JoinedProofBinding {
  const writerA = readCredentialReference(files.writerA.bytes);
  const writerB = readCredentialReference(files.writerB.bytes);
  assertReferenceContract(run, writerA, run.clientIds.writerA, run.seats.writerA);
  assertReferenceContract(run, writerB, run.clientIds.writerB, run.seats.writerB);
  return {
    endpoint: run.endpoint,
    cubeId: run.cubeId,
    writers: [
      { droneId: writerA.drone_id, roleId: writerA.role_id, sessionId: writerA.session_id },
      { droneId: writerB.drone_id, roleId: writerB.role_id, sessionId: writerB.session_id },
    ],
  };
}

function readCredentialReference(bytes: Buffer): CredentialReference {
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Sprint 4 credential reference is unreadable.");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Sprint 4 credential reference is invalid.");
  }
  const value = decoded as Record<string, unknown>;
  const names = [
    "endpoint", "trust_material_reference", "trust_identity", "cube_id", "client_id",
    "client_credential", "role_id", "drone_id", "session_id", "session_credential",
  ] as const;
  if (names.some((name) => typeof value[name] !== "string" || value[name].length === 0)) {
    throw new Error("Sprint 4 credential reference is incomplete.");
  }
  return value as unknown as CredentialReference;
}

function assertReferenceContract(
  run: Sprint4ProvisionedRun,
  reference: CredentialReference,
  clientId: string,
  seat: Sprint4ProvisionedRun["seats"]["reader"],
): void {
  if (reference.endpoint !== run.endpoint ||
      reference.trust_material_reference !== run.trustMaterialReference ||
      reference.trust_identity !== run.trustIdentity ||
      reference.cube_id !== run.cubeId ||
      reference.client_id !== clientId ||
      reference.role_id !== seat.roleId ||
      reference.drone_id !== seat.droneId ||
      reference.session_id !== seat.sessionId ||
      reference.session_credential.length < 43 ||
      !isUuid(reference.cube_id) ||
      !isUuid(reference.role_id) ||
      !isUuid(reference.drone_id) ||
      !isUuid(reference.session_id)) {
    throw new Error("Sprint 4 credential reference does not match the provisioned seat.");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function parseStructuredResult(output: string): Record<string, unknown> {
  if (Buffer.byteLength(output, "utf8") > SPRINT4_RUNNER_OUTPUT_LIMIT) {
    throw new Error("Sprint 4 client fixture structured output exceeded its bound.");
  }
  const lines = output.split("\n").filter((value) => value.startsWith("S4_COUPLED_E2E "));
  if (lines.length !== 1) throw new Error("Sprint 4 client fixture must emit exactly one structured result.");
  try {
    const value: unknown = JSON.parse(lines[0]!.slice("S4_COUPLED_E2E ".length));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const result = value as Record<string, unknown>;
    if (result["pass"] !== true || result["cleanup_verified"] !== true) {
      throw new Error("Sprint 4 client fixture did not verify a successful cleanup.");
    }
    return result;
  } catch {
    throw new Error("Sprint 4 client fixture emitted an invalid structured result.");
  }
}

export function assertStructuredResultContract(result: Record<string, unknown>, binding: JoinedProofBinding): void {
  const topKeys = [
    "schema_version", "pass", "client_sha", "origin", "simulated_idle_ms", "idle_accepted_model_turns",
    "idle_log_before_count", "idle_log_after_count", "idle_log_before", "idle_log_after", "idle_log_stable",
    "idle_cursor_before", "idle_cursor_after", "idle_cursor_stable", "directed_items", "directed_accepted_model_turns",
    "directed_unread_occurrences", "authenticated_writer_ids", "validated_writer_refs", "authenticated_writer_count",
    "writer_ids_match_configured", "burst_expected", "burst_drained", "burst_unique", "order_expected_count",
    "order_mismatch_count", "burst_order_exact", "drain_pages", "missing_ids", "duplicate_count", "unexpected_ids",
    "status_counts", "http_429_count", "econnreset_count", "transport_errors", "forbidden_fetch_attempts",
    "all_requests_same_origin", "phase_complete", "turn_validation_errors", "app_server_methods", "phase",
    "cleanup_verified",
  ] as const;
  assertExactKeys(result, topKeys, "result");
  if (result["schema_version"] !== "s4-coupled-e2e/v1" || result["pass"] !== true ||
      result["client_sha"] !== SPRINT4_EXPECTED_CLIENT_MAIN_SHA || result["origin"] !== binding.endpoint ||
      !isCanonicalLoopbackOrigin(result["origin"]) || result["cleanup_verified"] !== true) {
    throw new Error("Sprint 4 client fixture result does not match the pinned joined contract.");
  }

  const before = assertIdleSnapshot(result["idle_log_before"]);
  const after = assertIdleSnapshot(result["idle_log_after"]);
  if (result["simulated_idle_ms"] !== 2_400_000 || result["idle_accepted_model_turns"] !== 0 ||
      result["idle_log_before_count"] !== before.length || result["idle_log_after_count"] !== after.length ||
      JSON.stringify(before) !== JSON.stringify(after) || result["idle_log_stable"] !== true) {
    throw new Error("Sprint 4 client fixture result has invalid idle-log evidence.");
  }
  const cursorBefore = assertCursor(result["idle_cursor_before"]);
  const cursorAfter = assertCursor(result["idle_cursor_after"]);
  if (JSON.stringify(cursorBefore) !== JSON.stringify(cursorAfter) || result["idle_cursor_stable"] !== true) {
    throw new Error("Sprint 4 client fixture result has invalid idle-cursor evidence.");
  }

  if (result["directed_items"] !== 1 || result["directed_accepted_model_turns"] !== 1 ||
      result["directed_unread_occurrences"] !== 1) {
    throw new Error("Sprint 4 client fixture result has invalid directed evidence.");
  }
  const writers = assertUuidArray(result["authenticated_writer_ids"], 2, 16, "authenticated writers");
  const writerRefs = assertWriterReferences(result["validated_writer_refs"]);
  const expectedWriters = binding.writers.map((writer) => writer.droneId);
  if (writerRefs.length !== writers.length || result["authenticated_writer_count"] !== writers.length ||
      result["writer_ids_match_configured"] !== true ||
      !sameStringSet(writers, writerRefs.map((reference) => reference.drone_id)) ||
      !sameStringSet(writers, expectedWriters) ||
      writerRefs.some((reference) => {
        const expected = binding.writers.find((writer) => writer.droneId === reference.drone_id);
        return expected === undefined || reference.cube_id !== binding.cubeId ||
          (reference.role_id !== undefined && reference.role_id !== expected.roleId) ||
          (reference.session_id !== undefined && reference.session_id !== expected.sessionId);
      })) {
    throw new Error("Sprint 4 client fixture result has invalid writer evidence.");
  }

  if (result["burst_expected"] !== 150 || result["burst_drained"] !== 150 || result["burst_unique"] !== 150 ||
      result["order_expected_count"] !== 150 || result["order_mismatch_count"] !== 0 ||
      result["burst_order_exact"] !== true || !isBoundedInteger(result["drain_pages"], 1, 1_000) ||
      !isEmptyArray(result["missing_ids"]) || result["duplicate_count"] !== 0 || !isEmptyArray(result["unexpected_ids"])) {
    throw new Error("Sprint 4 client fixture result has invalid burst evidence.");
  }

  const statuses = assertStatusCounts(result["status_counts"]);
  if (result["http_429_count"] !== 0 || (statuses["429"] ?? 0) !== 0 || result["econnreset_count"] !== 0 ||
      !isEmptyArray(result["transport_errors"]) || result["forbidden_fetch_attempts"] !== 0 ||
      result["all_requests_same_origin"] !== true || result["phase_complete"] !== true ||
      !isEmptyArray(result["turn_validation_errors"]) || result["cleanup_verified"] !== true) {
    throw new Error("Sprint 4 client fixture result has invalid transport or egress evidence.");
  }
  assertMethods(result["app_server_methods"]);
  assertPhase(result["phase"]);
}

interface WriterReferenceEvidence { readonly cube_id: string; readonly drone_id: string; readonly role_id?: string; readonly session_id?: string }

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`Sprint 4 ${label} has unexpected or missing keys.`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`Sprint 4 ${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function isBoundedInteger(value: unknown, minimum = 0, maximum = 10_000): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isCanonicalIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isCanonicalLoopbackOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    const ipv4 = parsed.hostname.split(".").map(Number);
    const loopback = parsed.hostname === "[::1]" ||
      (ipv4.length === 4 && ipv4[0] === 127 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255));
    return parsed.protocol === "https:" && parsed.origin === value && parsed.port !== "" && parsed.pathname === "/" &&
      parsed.search === "" && parsed.hash === "" && parsed.username === "" && parsed.password === "" && loopback;
  } catch { return false; }
}

function assertIdleEntry(value: unknown): { readonly id: string; readonly created_at: string } {
  const entry = asRecord(value, "idle entry");
  assertExactKeys(entry, ["id", "created_at"], "idle entry");
  if (!isUuid(entry["id"] as string) || !isCanonicalIso(entry["created_at"])) throw new Error("Sprint 4 idle entry is invalid.");
  return entry as unknown as { readonly id: string; readonly created_at: string };
}

function assertIdleSnapshot(value: unknown): Array<{ readonly id: string; readonly created_at: string }> {
  if (!Array.isArray(value) || value.length > 500) throw new Error("Sprint 4 idle snapshot is invalid.");
  return value.map(assertIdleEntry);
}

function assertCursor(value: unknown): { readonly id: string; readonly created_at: string } | null {
  return value === null ? null : assertIdleEntry(value);
}

function assertUuidArray(value: unknown, minimum: number, maximum: number, label: string): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum ||
      value.some((item) => typeof item !== "string" || !isUuid(item)) || new Set(value).size !== value.length) {
    throw new Error(`Sprint 4 ${label} are invalid.`);
  }
  return value as string[];
}

function assertWriterReferences(value: unknown): WriterReferenceEvidence[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 16) throw new Error("Sprint 4 writer refs are invalid.");
  return value.map((item) => {
    const reference = asRecord(item, "writer ref");
    const keys = Object.keys(reference);
    if (!keys.includes("cube_id") || !keys.includes("drone_id") ||
        keys.some((key) => !["cube_id", "drone_id", "role_id", "session_id"].includes(key)) ||
        !isUuid(reference["cube_id"] as string) || !isUuid(reference["drone_id"] as string) ||
        (reference["role_id"] !== undefined && !isUuid(reference["role_id"] as string)) ||
        (reference["session_id"] !== undefined && !isUuid(reference["session_id"] as string))) {
      throw new Error("Sprint 4 writer ref is invalid.");
    }
    return reference as unknown as WriterReferenceEvidence;
  });
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value)) && new Set(right).size === right.length;
}

function isEmptyArray(value: unknown): boolean { return Array.isArray(value) && value.length === 0; }

function assertStatusCounts(value: unknown): Record<string, number> {
  const statuses = asRecord(value, "status counts");
  const entries = Object.entries(statuses);
  if (entries.length > 16 || entries.some(([key, count]) => !/^[1-5][0-9]{2}$/u.test(key) || !isBoundedInteger(count))) {
    throw new Error("Sprint 4 status counts are invalid.");
  }
  return statuses as Record<string, number>;
}

function assertMethods(value: unknown): void {
  if (!Array.isArray(value) || value.length > 32 ||
      value.some((method) => typeof method !== "string" || Buffer.byteLength(method, "utf8") > 64)) {
    throw new Error("Sprint 4 app-server methods are invalid.");
  }
}

function assertPhase(value: unknown): void {
  const phase = asRecord(value, "phase");
  const keys = [
    "stream_headers_ready_at", "deadline_fired", "directed_append_succeeded", "directed_turn_count",
    "quiescence_started_at", "quiescence_ended_at", "quiescence_elapsed_ms", "wall_quiescence_elapsed_ms",
    "abort_issued_at", "abort_reason", "stream_error", "stream_shutdown_clean", "directed_drain",
    "request_error_count", "socket_event_count", "requests", "sockets",
  ] as const;
  assertExactKeys(phase, keys, "phase");
  const started = phase["quiescence_started_at"];
  const ended = phase["quiescence_ended_at"];
  if (!isCanonicalIso(phase["stream_headers_ready_at"]) || !isCanonicalIso(started) || !isCanonicalIso(ended) ||
      !isCanonicalIso(phase["abort_issued_at"]) || phase["deadline_fired"] !== false ||
      phase["directed_append_succeeded"] !== true || phase["directed_turn_count"] !== 1 ||
      phase["abort_reason"] !== "directed observation complete" || phase["stream_shutdown_clean"] !== true ||
      phase["directed_drain"] !== "succeeded") {
    throw new Error("Sprint 4 phase markers are invalid.");
  }
  const wall = Date.parse(ended) - Date.parse(started);
  if (!isBoundedInteger(phase["wall_quiescence_elapsed_ms"], 6_000, Number.MAX_SAFE_INTEGER) ||
      phase["wall_quiescence_elapsed_ms"] !== wall || !isBoundedInteger(phase["quiescence_elapsed_ms"], 6_000, Number.MAX_SAFE_INTEGER) ||
      Math.abs(wall - phase["quiescence_elapsed_ms"]) > 1_000) {
    throw new Error("Sprint 4 quiescence evidence is invalid.");
  }
  const streamError = asRecord(phase["stream_error"], "stream error");
  assertExactKeys(streamError, ["origin", "code", "message"], "stream error");
  if (streamError["origin"] !== "iterator" || streamError["code"] !== "ABORT_ERR" ||
      streamError["message"] !== "directed observation complete") {
    throw new Error("Sprint 4 stream shutdown evidence is invalid.");
  }
  if (!Array.isArray(phase["requests"]) || phase["requests"].length !== 0 ||
      !isBoundedInteger(phase["request_error_count"]) || phase["request_error_count"] < phase["requests"].length) {
    throw new Error("Sprint 4 request evidence is invalid.");
  }
  const sockets = phase["sockets"];
  if (!Array.isArray(sockets) || sockets.length > 512 || sockets.some((socket) => !isSocketEvidence(socket)) ||
      !isBoundedInteger(phase["socket_event_count"]) || phase["socket_event_count"] < sockets.length) {
    throw new Error("Sprint 4 socket evidence is invalid.");
  }
}

function isShortString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum;
}

function isSocketEvidence(value: unknown): boolean {
  try {
    const socket = asRecord(value, "socket evidence");
    if (!isShortString(socket["event"], 32) || !isShortString(socket["socket_id"], 64)) return false;
    if (socket["event"] === "request_socket") {
      assertExactKeys(socket, ["event", "method", "pathname", "socket_id", "reused", "destroyed"], "request socket");
      return isShortString(socket["method"], 16) && isShortString(socket["pathname"], 256) &&
        socket["pathname"].startsWith("/") && typeof socket["reused"] === "boolean" && typeof socket["destroyed"] === "boolean";
    }
    if (socket["event"] === "socket_close") {
      assertExactKeys(socket, ["event", "socket_id", "destroyed"], "socket close");
      return typeof socket["destroyed"] === "boolean";
    }
    if (socket["event"] === "socket_error") {
      assertExactKeys(socket, ["event", "socket_id", "code"], "socket error");
      return socket["code"] === null || ["ECONNRESET", "ETIMEDOUT", "ABORT_ERR", "OTHER"].includes(socket["code"] as string);
    }
    if (socket["event"] === "socket_free") {
      assertExactKeys(socket, ["event", "socket_id"], "socket free");
      return true;
    }
    return false;
  } catch { return false; }
}

export async function cleanupJoinedRun(
  run: Pick<Sprint4ProvisionedRun, "cleanup"> | undefined,
  root: string,
  remove: (path: string, options: { readonly recursive: true; readonly force: true }) => Promise<void> = rm,
  timeoutMs = SPRINT4_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  let failure: unknown;
  try {
    if (run !== undefined) await withDeadline(run.cleanup(), timeoutMs, "Sprint 4 provisioner cleanup timed out.");
  } catch (error) {
    failure = error instanceof Error && error.message === "Sprint 4 provisioner cleanup timed out."
      ? error
      : new Error("Sprint 4 provisioner cleanup failed.");
  }
  try {
    await withDeadline(
      remove(root, { recursive: true, force: true }),
      Math.max(timeoutMs, 1_000),
      "Sprint 4 runner root cleanup timed out.",
    );
  } catch (error) {
    failure ??= error instanceof Error && error.message === "Sprint 4 runner root cleanup timed out."
      ? error
      : new Error("Sprint 4 runner root cleanup failed.");
  }
  if (failure !== undefined) throw failure;
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface ProvisionedFileSnapshot {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly size: number;
  readonly digest: string;
  readonly bytes: Buffer;
}

export interface ProvisionedFileSnapshots {
  readonly trust: ProvisionedFileSnapshot;
  readonly reader: ProvisionedFileSnapshot;
  readonly writerA: ProvisionedFileSnapshot;
  readonly writerB: ProvisionedFileSnapshot;
}

export async function snapshotOwnedProvisionedFiles(
  run: Sprint4ProvisionedRun,
  root: string,
): Promise<ProvisionedFileSnapshots> {
  const canonicalRoot = await realpath(root);
  const serverDirectory = join(canonicalRoot, "server");
  const credentialDirectory = join(serverDirectory, "s4-e2e-credentials");
  await assertOwnedPath(canonicalRoot, serverDirectory, 0o700, true);
  await assertOwnedPath(canonicalRoot, credentialDirectory, 0o700, true);
  const trust = await snapshotOwnedFile(canonicalRoot, run.trustMaterialReference, join(serverDirectory, "ca.crt"));
  const expected = {
    reader: join(credentialDirectory, "reader.json"),
    writerA: join(credentialDirectory, "writer-a.json"),
    writerB: join(credentialDirectory, "writer-b.json"),
  } as const;
  const snapshots = await Promise.all((Object.keys(expected) as Array<keyof typeof expected>).map(async (name) => {
    if (run.credentialReferences[name] !== expected[name]) {
      throw new Error("Sprint 4 credential references must not be shared or cross-wired.");
    }
    return snapshotOwnedFile(canonicalRoot, run.credentialReferences[name], expected[name]);
  }));
  return { trust, reader: snapshots[0]!, writerA: snapshots[1]!, writerB: snapshots[2]! };
}

export function assertSameProvisionedFiles(initial: ProvisionedFileSnapshots, final: ProvisionedFileSnapshots): void {
  for (const name of ["trust", "reader", "writerA", "writerB"] as const) {
    const before = initial[name];
    const after = final[name];
    if (before.canonicalPath !== after.canonicalPath || before.device !== after.device || before.inode !== after.inode ||
        before.mode !== after.mode || before.size !== after.size || before.digest !== after.digest) {
      throw new Error("Sprint 4 provisioner handoff files changed before spawn.");
    }
  }
}

export function assertSameProvisionedFile(initial: ProvisionedFileSnapshot, final: ProvisionedFileSnapshot): void {
  if (initial.canonicalPath !== final.canonicalPath || initial.device !== final.device || initial.inode !== final.inode ||
      initial.mode !== final.mode || initial.size !== final.size || initial.digest !== final.digest) {
    throw new Error("Sprint 4 runner CA handoff changed before spawn.");
  }
}

function assertSameTrustMaterial(source: ProvisionedFileSnapshot, handoff: ProvisionedFileSnapshot): void {
  if (source.size !== handoff.size || source.digest !== handoff.digest || !source.bytes.equals(handoff.bytes)) {
    throw new Error("Sprint 4 runner CA handoff does not match the final provisioner trust material.");
  }
}

export async function materializeClientCaHandoff(
  root: string,
  trust: ProvisionedFileSnapshot,
): Promise<ProvisionedFileSnapshot> {
  const canonicalRoot = await realpath(root);
  const path = join(canonicalRoot, "s4-client-ca.crt");
  await writeFile(path, trust.bytes, { flag: "wx", mode: 0o600 });
  const handoff = await snapshotOwnedFile(canonicalRoot, path, path);
  assertSameTrustMaterial(trust, handoff);
  return handoff;
}

export async function snapshotClientCaHandoff(root: string, path: string): Promise<ProvisionedFileSnapshot> {
  const canonicalRoot = await realpath(root);
  const expected = join(canonicalRoot, "s4-client-ca.crt");
  if (path !== expected) throw new Error("Sprint 4 runner CA handoff path changed before spawn.");
  return snapshotOwnedFile(canonicalRoot, path, expected);
}

async function snapshotOwnedFile(root: string, path: string, expected: string): Promise<ProvisionedFileSnapshot> {
  await assertOwnedPath(root, path, 0o600, false, expected);
  const before = await stat(path);
  const bytes = await readFile(path);
  if (bytes.length > SPRINT4_RUNNER_OUTPUT_LIMIT) throw new Error("Sprint 4 provisioner handoff file exceeded its bound.");
  const after = await stat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.size !== after.size) {
    throw new Error("Sprint 4 provisioner handoff file changed while read.");
  }
  return {
    canonicalPath: await realpath(path),
    device: after.dev,
    inode: after.ino,
    mode: after.mode,
    size: after.size,
    digest: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}

async function assertOwnedPath(
  root: string,
  path: string,
  mode: number,
  directory: boolean,
  expected?: string,
): Promise<void> {
  const canonicalPath = await realpath(path);
  const fromRoot = relative(root, canonicalPath);
  const metadata = await lstat(path);
  if (path !== canonicalPath || (expected !== undefined && canonicalPath !== expected) ||
      fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot) ||
      metadata.isSymbolicLink() || (directory ? !metadata.isDirectory() : !metadata.isFile()) ||
      (metadata.mode & 0o777) !== mode ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error("Sprint 4 provisioner path must be owned, canonical, and private.");
  }
}

export function assertProvisionedRun(run: Sprint4ProvisionedRun): void {
  if (!/^https:\/\/127\.0\.0\.1:\d+$/u.test(run.endpoint) ||
      !/^spki-sha256:[0-9a-f]{64}$/u.test(run.trustIdentity) ||
      typeof run.cleanup !== "function" ||
      Object.values(run.credentialReferences).some((reference) => !isAbsolute(reference))) {
    throw new Error("Sprint 4 provisioner returned an unsafe joined-run contract.");
  }
}

function hasCloudConfiguration(env: NodeJS.ProcessEnv): boolean {
  return ["BORG_CLOUD", "BORG_PROVIDER", "BORG_GLOBAL_ENDPOINT", "OPENAI_API_KEY"].some((name) => env[name] !== undefined);
}

function minimalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { PATH: env["PATH"], HOME: env["HOME"], TMPDIR: env["TMPDIR"] };
}

export async function runBounded(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  timeoutMs = SPRINT4_RUNNER_TIMEOUT_MS,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let overflowed = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    let terminationCompletion: Promise<void> | undefined;
    const terminateTree = (): void => {
      if (child.pid === undefined || terminationCompletion !== undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      terminationCompletion = new Promise((resolveTermination) => {
        terminationTimer = setTimeout(() => {
          if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
          resolveTermination();
        }, 100);
      });
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (target === "stdout") {
        stdoutBytes += chunk.length;
        if (stdoutBytes > SPRINT4_RUNNER_OUTPUT_LIMIT) stdoutOverflow = true;
        const retained = Math.max(0, SPRINT4_RUNNER_OUTPUT_LIMIT - (stdoutBytes - chunk.length));
        if (retained > 0) stdoutChunks.push(chunk.subarray(0, retained));
      } else {
        stderrBytes += chunk.length;
        if (stderrBytes > SPRINT4_RUNNER_OUTPUT_LIMIT) stderrOverflow = true;
        const retained = Math.max(0, SPRINT4_RUNNER_OUTPUT_LIMIT - (stderrBytes - chunk.length));
        if (retained > 0) stderrChunks.push(chunk.subarray(0, retained));
      }
      if ((stdoutOverflow || stderrOverflow) && !overflowed) {
        overflowed = true;
        terminateTree();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree();
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (child.pid !== undefined && terminationCompletion === undefined) {
        try {
          process.kill(-child.pid, 0);
          terminateTree();
        } catch {
          // The owned process group is already gone.
        }
      }
      const finish = (): void => {
        if (timedOut) reject(new Error("Sprint 4 client fixture timed out."));
        else resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          stdoutOverflow,
          stderrOverflow,
          stdoutBytes,
          stderrBytes,
        });
      };
      if (terminationCompletion === undefined) finish();
      else void terminationCompletion.then(finish);
    });
  });
}
