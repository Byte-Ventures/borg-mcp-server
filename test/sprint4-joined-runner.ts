/**
 * Persistent, test-only orchestration for the final Sprint 4 joined proof.
 *
 * The companion Vitest file is skipped unless BORG_RUN_S4_JOINED_E2E is exactly
 * "1". This module deliberately owns no production surface.
 */
import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { provisionSprint4E2e, type Sprint4ProvisionedRun } from "./sprint4-e2e-provisioning.js";

export const SPRINT4_CLIENT_SHA = "2ecae18a585b6614e601ef7071e2920ca2b6fe6a";
export const SPRINT4_CLIENT_FIXTURE_SHA256 = "9c8b52102ce815ebd9125c4d4cec8e931ba156cdc00aa2140da2b83eaa44fe3c";
export const SPRINT4_JOINED_GATE = "BORG_RUN_S4_JOINED_E2E";
export const SPRINT4_CLIENT_DIRECTORY = "BORG_RQ_CLIENT_DIRECTORY";
export const SPRINT4_RUNNER_TIMEOUT_MS = 20_000;
export const SPRINT4_RUNNER_OUTPUT_LIMIT = 16_384;

export interface JoinedRunnerEnvironment {
  readonly clientDirectory: string;
}

export interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutOverflow: boolean;
  readonly stderrOverflow: boolean;
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
  await (dependencies.verifyClientPins ?? verifyClientPins)(configuration.clientDirectory);
  const root = await mkdtemp(join(tmpdir(), "borg-s4-joined-"));
  let run: Sprint4ProvisionedRun | undefined;
  try {
    run = await (dependencies.provision ?? provisionSprint4E2e)({
      testMode: true,
      dataDirectory: join(root, "server"),
      host: "127.0.0.1",
      port: 0,
    });
    assertProvisionedRun(run);
    await assertOwnedCredentialReferences(run, root);
    const clientEnvironment = await buildClientFixtureEnvironment(env, configuration.clientDirectory, run);
    const result = await (dependencies.spawn ?? runBounded)(
      "npx",
      ["vitest", "run", "__tests__/s4-coupled-e2e.test.ts"],
      {
        cwd: configuration.clientDirectory,
        env: clientEnvironment,
      },
    );
    if (result.stdoutOverflow || result.stderrOverflow) {
      throw new Error(`Sprint 4 client fixture output exceeded its bound: ${redactOutput(result.stderr || result.stdout)}`);
    }
    if (result.code !== 0) throw new Error(`Sprint 4 client fixture failed: ${redactOutput(result.stderr || result.stdout)}`);
    if (result.stderr.trim() !== "") throw new Error(`Sprint 4 client fixture wrote to stderr: ${redactOutput(result.stderr)}`);
    const structured = parseStructuredResult(result.stdout);
    assertStructuredResultContract(structured, run);
    return structured;
  } finally {
    await cleanupJoinedRun(run, root);
  }
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

/** Maps the reviewed client fixture contract from existing provisioner refs. */
export async function buildClientFixtureEnvironment(
  env: NodeJS.ProcessEnv,
  clientDirectory: string,
  run: Sprint4ProvisionedRun,
): Promise<NodeJS.ProcessEnv> {
  assertProvisionedRun(run);
  const reader = await readCredentialReference(run.credentialReferences.reader);
  const writers = await Promise.all([
    readCredentialReference(run.credentialReferences.writerA),
    readCredentialReference(run.credentialReferences.writerB),
  ]);
  assertReferenceContract(run, reader, run.clientIds.reader, run.seats.reader);
  assertReferenceContract(run, writers[0], run.clientIds.writerA, run.seats.writerA);
  assertReferenceContract(run, writers[1], run.clientIds.writerB, run.seats.writerB);
  if (writers[0].session_credential === reader.session_credential ||
      writers[1].session_credential === reader.session_credential ||
      writers[0].session_credential === writers[1].session_credential ||
      writers[0].drone_id === reader.drone_id ||
      writers[1].drone_id === reader.drone_id ||
      writers[0].drone_id === writers[1].drone_id) {
    throw new Error("Sprint 4 provisioner returned cross-wired session credentials.");
  }
  return {
    ...minimalEnvironment(env),
    [SPRINT4_JOINED_GATE]: "1",
    [SPRINT4_CLIENT_DIRECTORY]: clientDirectory,
    BORG_S4_COUPLED_E2E: "1",
    BORG_E2E_CLIENT_SHA: SPRINT4_CLIENT_SHA,
    BORG_API_URL: run.endpoint,
    BORG_E2E_CA_PATH: run.trustMaterialReference,
    BORG_E2E_TRUST_IDENTITY: run.trustIdentity,
    BORG_E2E_CUBE_ID: run.cubeId,
    BORG_E2E_READER_DRONE_ID: reader.drone_id,
    BORG_E2E_READER_TOKEN: reader.session_credential,
    BORG_E2E_WRITER_REFS: JSON.stringify(writers),
  };
}

async function readCredentialReference(path: string): Promise<CredentialReference> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path, "utf8"));
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function parseStructuredResult(output: string): Record<string, unknown> {
  if (output.length > SPRINT4_RUNNER_OUTPUT_LIMIT) {
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

export function assertStructuredResultContract(result: Record<string, unknown>, run: Pick<Sprint4ProvisionedRun, "endpoint">): void {
  if (result["client_sha"] !== SPRINT4_CLIENT_SHA || result["origin"] !== run.endpoint) {
    throw new Error("Sprint 4 client fixture result does not match the pinned joined contract.");
  }
  if (containsSensitiveResultField(result)) {
    throw new Error("Sprint 4 client fixture result contains a credential-bearing field.");
  }
}

function containsSensitiveResultField(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    /(?:credential|token|secret|authorization)/iu.test(key) || containsSensitiveResultField(child));
}

export function redactOutput(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"']+/gu, "Bearer [REDACTED]")
    .replace(/((?:["']?(?:client|session)_credential["']?\s*[:=]\s*["']))[^"']+(["'])/gu, "$1[REDACTED]$2")
    .slice(0, SPRINT4_RUNNER_OUTPUT_LIMIT);
}

export async function cleanupJoinedRun(
  run: Pick<Sprint4ProvisionedRun, "cleanup"> | undefined,
  root: string,
  remove: (path: string, options: { readonly recursive: true; readonly force: true }) => Promise<void> = rm,
): Promise<void> {
  let failure: unknown;
  try {
    await run?.cleanup();
  } catch (error) {
    failure = error;
  }
  try {
    await remove(root, { recursive: true, force: true });
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

export async function assertOwnedCredentialReferences(run: Sprint4ProvisionedRun, root: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  await Promise.all(Object.values(run.credentialReferences).map(async (reference) => {
    const canonicalReference = await realpath(reference);
    const pathFromRoot = relative(canonicalRoot, canonicalReference);
    const metadata = await lstat(reference);
    if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot) ||
        !metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
      throw new Error("Sprint 4 credential reference must be an owned canonical 0600 file.");
    }
  }));
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
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let overflowed = false;
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const value = chunk.toString("utf8");
      if (target === "stdout") {
        if (stdout.length + value.length > SPRINT4_RUNNER_OUTPUT_LIMIT) stdoutOverflow = true;
        stdout = (stdout + value).slice(0, SPRINT4_RUNNER_OUTPUT_LIMIT);
      } else {
        if (stderr.length + value.length > SPRINT4_RUNNER_OUTPUT_LIMIT) stderrOverflow = true;
        stderr = (stderr + value).slice(0, SPRINT4_RUNNER_OUTPUT_LIMIT);
      }
      if ((stdoutOverflow || stderrOverflow) && !overflowed) {
        overflowed = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("Sprint 4 client fixture timed out."));
      else resolve({ code: code ?? 1, stdout, stderr, stdoutOverflow, stderrOverflow });
    });
  });
}
