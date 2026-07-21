/**
 * Persistent, test-only orchestration for the final Sprint 4 joined proof.
 *
 * The companion Vitest file is skipped unless BORG_RUN_S4_JOINED_E2E is exactly
 * "1". This module deliberately owns no production surface.
 */
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
}

export interface JoinedRunnerDependencies {
  readonly provision?: typeof provisionSprint4E2e;
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
  await verifyClientPins(configuration.clientDirectory);
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
    const result = await (dependencies.spawn ?? runBounded)(
      "npx",
      ["vitest", "run", "__tests__/s4-coupled-e2e.test.ts"],
      {
        cwd: configuration.clientDirectory,
        env: {
          ...minimalEnvironment(env),
          [SPRINT4_JOINED_GATE]: "1",
          [SPRINT4_CLIENT_DIRECTORY]: configuration.clientDirectory,
          BORG_RQ_SPRINT4_SERVER_RUN: JSON.stringify({
            endpoint: run.endpoint,
            trust_material_reference: run.trustMaterialReference,
            trust_identity: run.trustIdentity,
            cube_id: run.cubeId,
            credential_references: run.credentialReferences,
          }),
        },
      },
    );
    if (result.code !== 0) throw new Error(`Sprint 4 client fixture failed: ${redactOutput(result.stderr || result.stdout)}`);
    return parseStructuredResult(result.stdout);
  } finally {
    await cleanupJoinedRun(run, root);
  }
}

export function parseStructuredResult(output: string): Record<string, unknown> {
  const line = output.split("\n").find((value) => value.startsWith("S4_COUPLED_E2E "));
  if (line === undefined) throw new Error("Sprint 4 client fixture did not emit a structured result.");
  try {
    const value: unknown = JSON.parse(line.slice("S4_COUPLED_E2E ".length));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Sprint 4 client fixture emitted an invalid structured result.");
  }
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
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const value = chunk.toString("utf8");
      if (target === "stdout") stdout = (stdout + value).slice(0, SPRINT4_RUNNER_OUTPUT_LIMIT);
      else stderr = (stderr + value).slice(0, SPRINT4_RUNNER_OUTPUT_LIMIT);
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
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
