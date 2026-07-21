import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Sprint4ProvisionedRun } from "./sprint4-e2e-provisioning.js";

import {
  SPRINT4_CLIENT_DIRECTORY,
  SPRINT4_JOINED_GATE,
  SPRINT4_RUNNER_OUTPUT_LIMIT,
  SPRINT4_CLIENT_FIXTURE_SHA256,
  SPRINT4_CLIENT_SHA,
  SPRINT4_EXPECTED_CLIENT_MAIN_SHA,
  assertClientPinValues,
  assertSameProvisionedFiles,
  assertProvisionedRun,
  assertStructuredResultContract,
  buildClientFixtureEnvironment,
  cleanupJoinedRun,
  executeJoinedRunner,
  isJoinedRunEnabled,
  parseStructuredResult,
  redactOutput,
  runBounded,
  snapshotOwnedProvisionedFiles,
  validateJoinedRunnerEnvironment,
} from "./sprint4-joined-runner.js";

const writerAId = "55555555-5555-4555-8555-555555555555";
const writerBId = "77777777-7777-4777-8777-777777777777";

function validSuccess(origin = "https://127.0.0.1:1234"): Record<string, unknown> {
  return {
    schema_version: "s4-coupled-e2e/v1", pass: true, client_sha: SPRINT4_EXPECTED_CLIENT_MAIN_SHA, origin,
    simulated_idle_ms: 2_400_000, idle_accepted_model_turns: 0,
    idle_log_before_count: 0, idle_log_after_count: 0, idle_log_before: [], idle_log_after: [], idle_log_stable: true,
    idle_cursor_before: null, idle_cursor_after: null, idle_cursor_stable: true,
    directed_items: 1, directed_accepted_model_turns: 1, directed_unread_occurrences: 1,
    authenticated_writer_ids: [writerAId, writerBId],
    validated_writer_refs: [
      { cube_id: "11111111-1111-4111-8111-111111111111", drone_id: writerAId },
      { cube_id: "11111111-1111-4111-8111-111111111111", drone_id: writerBId },
    ],
    authenticated_writer_count: 2, writer_ids_match_configured: true,
    burst_expected: 150, burst_drained: 150, burst_unique: 150, order_expected_count: 150,
    order_mismatch_count: 0, burst_order_exact: true, drain_pages: 3,
    missing_ids: [], duplicate_count: 0, unexpected_ids: [], status_counts: { "201": 150 },
    http_429_count: 0, econnreset_count: 0, transport_errors: [], forbidden_fetch_attempts: 0,
    all_requests_same_origin: true, phase_complete: true, turn_validation_errors: [], app_server_methods: [],
    phase: {
      stream_headers_ready_at: "2026-07-21T10:00:00.000Z", deadline_fired: false,
      directed_append_succeeded: true, directed_turn_count: 1,
      quiescence_started_at: "2026-07-21T10:00:01.000Z", quiescence_ended_at: "2026-07-21T10:00:07.000Z",
      quiescence_elapsed_ms: 6_000, wall_quiescence_elapsed_ms: 6_000,
      abort_issued_at: "2026-07-21T10:00:07.001Z", abort_reason: "directed observation complete",
      stream_error: { origin: "iterator", code: "ABORT_ERR", message: "directed observation complete" },
      stream_shutdown_clean: true, directed_drain: "succeeded", request_error_count: 0, socket_event_count: 0,
      requests: [], sockets: [],
    },
    cleanup_verified: true,
  };
}

describe("Sprint 4 joined runner safeguards", () => {
  it("requires the narrow declaration-time gate and an absolute client directory", () => {
    expect(isJoinedRunEnabled({ [SPRINT4_JOINED_GATE]: "1" })).toBe(true);
    expect(isJoinedRunEnabled({ [SPRINT4_JOINED_GATE]: "true" })).toBe(false);
    expect(() => validateJoinedRunnerEnvironment({})).toThrow("explicit opt-in");
    expect(() => validateJoinedRunnerEnvironment({ [SPRINT4_JOINED_GATE]: "1", [SPRINT4_CLIENT_DIRECTORY]: "relative" })).toThrow("absolute");
    expect(() => validateJoinedRunnerEnvironment({ [SPRINT4_JOINED_GATE]: "1", [SPRINT4_CLIENT_DIRECTORY]: "/tmp/client", BORG_CLOUD: "1" })).toThrow("Cloud");
  });

  it("rejects either client pin before any provisioned state exists", () => {
    expect(() => assertClientPinValues("bad", SPRINT4_CLIENT_FIXTURE_SHA256)).toThrow("SHA");
    expect(() => assertClientPinValues(SPRINT4_CLIENT_SHA, "bad")).toThrow("hash");
  });

  it("parses only the structured result and redacts credential-shaped output", () => {
    expect(parseStructuredResult("noise\nS4_COUPLED_E2E {\"pass\":true,\"cleanup_verified\":true}\n")).toEqual({ pass: true, cleanup_verified: true });
    expect(() => parseStructuredResult("S4_COUPLED_E2E []")).toThrow("invalid");
    expect(() => parseStructuredResult("S4_COUPLED_E2E {\"pass\":true,\"cleanup_verified\":true}\nS4_COUPLED_E2E {\"pass\":true,\"cleanup_verified\":true}")).toThrow("exactly one");
    expect(() => parseStructuredResult("S4_COUPLED_E2E {\"pass\":true,\"cleanup_verified\":false}")).toThrow("invalid");
    expect(() => parseStructuredResult("S4_COUPLED_E2E " + "x".repeat(20_000))).toThrow("exceeded");
    expect(redactOutput("Bearer secret client_credential\":\"also-secret\"")).not.toContain("secret");
  });

  it("requires a successful, pinned, credential-safe result", () => {
    const run = { endpoint: "https://127.0.0.1:1234" } as never;
    expect(() => assertStructuredResultContract(validSuccess(), run)).not.toThrow();
    expect(() => assertStructuredResultContract({ ...validSuccess(), client_sha: "other" }, run)).toThrow("pinned");
    expect(() => assertStructuredResultContract({ ...validSuccess(), session_token: "secret" }, run)).toThrow("unexpected");
    expect(() => assertStructuredResultContract({ ...validSuccess(), burst_drained: 149 }, run)).toThrow("burst");
    expect(() => assertStructuredResultContract({ ...validSuccess(), idle_cursor_stable: false }, run)).toThrow("idle-cursor");
    expect(() => assertStructuredResultContract({ ...validSuccess(), phase: { ...(validSuccess()["phase"] as object), quiescence_elapsed_ms: 5_999 } }, run)).toThrow("quiescence");
  });

  it("rejects every missing, contradictory, or over-cap proof class", () => {
    const run = { endpoint: "https://127.0.0.1:1234" } as never;
    const invalid = (mutate: (result: Record<string, unknown>) => void): void => {
      const result = structuredClone(validSuccess());
      mutate(result);
      expect(() => assertStructuredResultContract(result, run)).toThrow();
    };
    invalid((result) => { delete result["schema_version"]; });
    invalid((result) => { result["unexpected"] = true; });
    invalid((result) => { result["pass"] = false; });
    invalid((result) => { result["cleanup_verified"] = false; });
    invalid((result) => { result["idle_log_before"] = [{ id: writerAId, created_at: "2026-07-21T10:00:00.000Z" }]; result["idle_log_before_count"] = 1; });
    invalid((result) => { result["directed_unread_occurrences"] = 2; });
    invalid((result) => { result["authenticated_writer_ids"] = [writerAId, writerBId, "99999999-9999-4999-8999-999999999999"]; });
    invalid((result) => { result["order_mismatch_count"] = 1; });
    invalid((result) => { result["status_counts"] = { "429": 1 }; result["http_429_count"] = 1; });
    invalid((result) => { result["transport_errors"] = [{ code: "ECONNRESET", message: "transport failure" }]; });
    invalid((result) => { result["forbidden_fetch_attempts"] = 1; });
    invalid((result) => { result["app_server_methods"] = ["x".repeat(65)]; });
    invalid((result) => { (result["phase"] as Record<string, unknown>)["stream_shutdown_clean"] = false; });
    invalid((result) => { (result["phase"] as Record<string, unknown>)["abort_reason"] = "other"; });
    invalid((result) => { (result["phase"] as Record<string, unknown>)["request_error_count"] = 10_001; });
    invalid((result) => { (result["phase"] as Record<string, unknown>)["socket_event_count"] = 10_001; });
    invalid((result) => { (result["phase"] as Record<string, unknown>)["sockets"] = Array.from({ length: 513 }, (_, index) => ({ event: "socket_free", socket_id: `s${index}` })); });
  });

  it("maps checked provisioner references into the selected client fixture contract", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "borg-s4-runner-contract-")));
    const endpoint = "https://127.0.0.1:1234";
    const trust = "spki-sha256:" + "a".repeat(64);
    const ref = async (name: string, client: string, drone: string, session: string, credential: string): Promise<string> => {
      const path = join(root, "server", "s4-e2e-credentials", name);
      await writeFile(path, JSON.stringify({
        endpoint, trust_material_reference: join(root, "server", "ca.crt"), trust_identity: trust, cube_id: "11111111-1111-4111-8111-111111111111",
        client_id: client, client_credential: `${credential}-client`, role_id: "22222222-2222-4222-8222-222222222222", drone_id: drone,
        session_id: session, session_credential: credential,
      }), { mode: 0o600 });
      return path;
    };
    await mkdir(join(root, "server", "s4-e2e-credentials"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "server", "ca.crt"), "test-ca", { mode: 0o600 });
    const reader = await ref("reader.json", "reader-client", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "r".repeat(43));
    const writerA = await ref("writer-a.json", "writer-a-client", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666", "a".repeat(43));
    const writerB = await ref("writer-b.json", "writer-b-client", "77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888", "b".repeat(43));
    const run = {
      endpoint, trustMaterialReference: join(root, "server", "ca.crt"), trustIdentity: trust, cubeId: "11111111-1111-4111-8111-111111111111",
      credentialReferences: { reader, writerA, writerB },
      clientIds: { reader: "reader-client", writerA: "writer-a-client", writerB: "writer-b-client" },
      seats: {
        reader: { roleId: "22222222-2222-4222-8222-222222222222", droneId: "33333333-3333-4333-8333-333333333333", sessionId: "44444444-4444-4444-8444-444444444444" },
        writerA: { roleId: "22222222-2222-4222-8222-222222222222", droneId: "55555555-5555-4555-8555-555555555555", sessionId: "66666666-6666-4666-8666-666666666666" },
        writerB: { roleId: "22222222-2222-4222-8222-222222222222", droneId: "77777777-7777-4777-8777-777777777777", sessionId: "88888888-8888-4888-8888-888888888888" },
      }, cleanup: async () => {},
    } as Sprint4ProvisionedRun;
    try {
      const initialSnapshot = await snapshotOwnedProvisionedFiles(run, root);
      await expect(snapshotOwnedProvisionedFiles(run, root)).resolves.toBeDefined();
      const shared = await mkdtemp(join(tmpdir(), "borg-s4-runner-shared-"));
      try {
        const sharedReference = join(shared, "reader.json");
        await writeFile(sharedReference, await readFile(reader), { mode: 0o600 });
        await expect(snapshotOwnedProvisionedFiles({ ...run, credentialReferences: { ...run.credentialReferences, reader: sharedReference } }, root)).rejects.toThrow("shared or cross-wired");
      } finally {
        await rm(shared, { recursive: true, force: true });
      }
      const mapped = await buildClientFixtureEnvironment({}, "/tmp/disposable-client", run);
      expect(mapped).toMatchObject({
        BORG_S4_COUPLED_E2E: "1", BORG_E2E_CLIENT_SHA: SPRINT4_EXPECTED_CLIENT_MAIN_SHA,
        BORG_API_URL: endpoint, BORG_E2E_CA_PATH: join(root, "server", "ca.crt"), BORG_E2E_TRUST_IDENTITY: trust,
        BORG_E2E_CUBE_ID: "11111111-1111-4111-8111-111111111111",
        BORG_E2E_READER_DRONE_ID: "33333333-3333-4333-8333-333333333333",
        BORG_E2E_READER_TOKEN: "r".repeat(43),
      });
      expect(mapped["BORG_RQ_SPRINT4_SERVER_RUN"]).toBeUndefined();
      expect(JSON.parse(mapped["BORG_E2E_WRITER_REFS"]!)).toMatchObject([{ drone_id: "55555555-5555-4555-8555-555555555555" }, { drone_id: "77777777-7777-4777-8777-777777777777" }]);
      let selected = false;
      let cleaned = false;
      const outcome = await executeJoinedRunner(
        { [SPRINT4_JOINED_GATE]: "1", [SPRINT4_CLIENT_DIRECTORY]: "/tmp/disposable-client" },
        {
          verifyClientPins: async () => {},
          provision: async (input) => {
            const references = join(input.dataDirectory, "s4-e2e-credentials");
            await mkdir(references, { recursive: true, mode: 0o700 });
            const caPath = join(input.dataDirectory, "ca.crt");
            await writeFile(caPath, "test-ca", { mode: 0o600 });
            const copy = async (name: "reader" | "writerA" | "writerB"): Promise<string> => {
              const filename = name === "writerA" ? "writer-a.json" : name === "writerB" ? "writer-b.json" : "reader.json";
              const path = join(references, filename);
              const reference = JSON.parse(await readFile(run.credentialReferences[name], "utf8")) as Record<string, unknown>;
              reference["trust_material_reference"] = caPath;
              await writeFile(path, JSON.stringify(reference), { mode: 0o600 });
              return path;
            };
            return {
              ...run,
              trustMaterialReference: caPath,
              credentialReferences: { reader: await copy("reader"), writerA: await copy("writerA"), writerB: await copy("writerB") },
              cleanup: async () => { cleaned = true; },
            };
          },
          spawn: async (command, args, options) => {
            selected = command === "npx" && args.join(" ") === "vitest run __tests__/s4-coupled-e2e.test.ts" &&
              options.env["BORG_S4_COUPLED_E2E"] === "1" && options.env["BORG_E2E_READER_TOKEN"] === "r".repeat(43);
            const stdout = `S4_COUPLED_E2E ${JSON.stringify(validSuccess(endpoint))}`;
            return { code: 0, stderr: "", stdout, stdoutOverflow: false, stderrOverflow: false, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0 };
          },
        },
      );
      expect(outcome).toMatchObject({ pass: true, cleanup_verified: true });
      expect(selected).toBe(true);
      expect(cleaned).toBe(true);
      await writeFile(writerB, JSON.stringify({
        endpoint, trust_material_reference: join(root, "server", "ca.crt"), trust_identity: trust, cube_id: "11111111-1111-4111-8111-111111111111",
        client_id: "writer-b-client", client_credential: "unused", role_id: "22222222-2222-4222-8222-222222222222",
        drone_id: "77777777-7777-4777-8777-777777777777", session_id: "88888888-8888-4888-8888-888888888888", session_credential: "r".repeat(43),
      }));
      await expect(buildClientFixtureEnvironment({}, "/tmp/disposable-client", run)).rejects.toThrow("cross-wired");
      await writeFile(writerB, JSON.stringify({
        endpoint: "https://127.0.0.1:9999", trust_material_reference: join(root, "server", "ca.crt"), trust_identity: trust, cube_id: "11111111-1111-4111-8111-111111111111",
        client_id: "writer-b-client", client_credential: "unused", role_id: "22222222-2222-4222-8222-222222222222",
        drone_id: "77777777-7777-4777-8777-777777777777", session_id: "88888888-8888-4888-8888-888888888888", session_credential: "b".repeat(43),
      }));
      await expect(buildClientFixtureEnvironment({}, "/tmp/disposable-client", run)).rejects.toThrow("does not match");
      await writeFile(writerB, "{}");
      await expect(buildClientFixtureEnvironment({}, "/tmp/disposable-client", run)).rejects.toThrow("incomplete");
      const changedSnapshot = await snapshotOwnedProvisionedFiles(run, root);
      expect(() => assertSameProvisionedFiles(initialSnapshot, changedSnapshot)).toThrow("changed before spawn");
      await writeFile(join(root, "server", "ca.crt"), "changed", { mode: 0o600 });
      const changedCaSnapshot = await snapshotOwnedProvisionedFiles(run, root);
      expect(() => assertSameProvisionedFiles(changedSnapshot, changedCaSnapshot)).toThrow("changed before spawn");
      const replacement = join(root, "server", "s4-e2e-credentials", "reader-replacement.json");
      await writeFile(replacement, await readFile(reader), { mode: 0o600 });
      await rename(replacement, reader);
      const swappedSnapshot = await snapshotOwnedProvisionedFiles(run, root);
      expect(() => assertSameProvisionedFiles(changedCaSnapshot, swappedSnapshot)).toThrow("changed before spawn");
      await chmod(writerA, 0o640);
      await expect(snapshotOwnedProvisionedFiles(run, root)).rejects.toThrow("private");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unsafe or non-cleanup provisioner contract before fixture spawn", () => {
    expect(() => assertProvisionedRun({
      endpoint: "https://localhost:1234",
      trustIdentity: "spki-sha256:" + "a".repeat(64),
      credentialReferences: { reader: "/tmp/a", writerA: "/tmp/b", writerB: "/tmp/c" },
      cleanup: async () => {},
    } as never)).toThrow("unsafe");
    expect(() => assertProvisionedRun({
      endpoint: "https://127.0.0.1:1234",
      trustIdentity: "spki-sha256:" + "a".repeat(64),
      credentialReferences: { reader: "/tmp/a", writerA: "/tmp/b", writerB: "/tmp/c" },
      cleanup: undefined,
    } as never)).toThrow("unsafe");
  });

  it("bounds spawn errors and stalled children", async () => {
    await expect(runBounded("definitely-not-a-command", [], { cwd: process.cwd(), env: {} }, 100)).rejects.toThrow();
    await expect(runBounded(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { cwd: process.cwd(), env: process.env }, 10)).rejects.toThrow("timed out");
  });

  it("fails closed when spawned stdout overflows before or after a plausible result", async () => {
    const record = `S4_COUPLED_E2E ${JSON.stringify({ pass: true, cleanup_verified: true })}`;
    const before = await runBounded(process.execPath, ["-e", `process.stdout.write('x'.repeat(${SPRINT4_RUNNER_OUTPUT_LIMIT + 1}) + ${JSON.stringify(record)})`], { cwd: process.cwd(), env: process.env });
    const after = await runBounded(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(record)} + 'x'.repeat(${SPRINT4_RUNNER_OUTPUT_LIMIT + 1}))`], { cwd: process.cwd(), env: process.env });
    const straddling = await runBounded(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(record)} + 'x'.repeat(${SPRINT4_RUNNER_OUTPUT_LIMIT}) + ${JSON.stringify(record)})`], { cwd: process.cwd(), env: process.env });
    const stderr = await runBounded(process.execPath, ["-e", `process.stderr.write('x'.repeat(${SPRINT4_RUNNER_OUTPUT_LIMIT + 1}))`], { cwd: process.cwd(), env: process.env });
    const exact = await runBounded(process.execPath, ["-e", `process.stdout.write('x'.repeat(${SPRINT4_RUNNER_OUTPUT_LIMIT}))`], { cwd: process.cwd(), env: process.env });
    expect(before.stdoutOverflow).toBe(true);
    expect(after.stdoutOverflow).toBe(true);
    expect(straddling.stdoutOverflow).toBe(true);
    expect(stderr.stderrOverflow).toBe(true);
    expect(exact.stdoutOverflow).toBe(false);
    expect(exact.stdoutBytes).toBe(SPRINT4_RUNNER_OUTPUT_LIMIT);
  });

  it("cleans owned state even if provisioner cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "borg-s4-runner-unit-"));
    await writeFile(join(root, "owned"), "state");
    await expect(cleanupJoinedRun({ cleanup: async () => { throw new Error("cleanup failure"); } }, root)).rejects.toThrow("cleanup failure");
    await expect(rm(root, { recursive: true, force: false })).rejects.toThrow();
  });
});
