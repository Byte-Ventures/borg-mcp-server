import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Sprint4ProvisionedRun } from "./sprint4-e2e-provisioning.js";

import {
  SPRINT4_CLIENT_DIRECTORY,
  SPRINT4_JOINED_GATE,
  SPRINT4_CLIENT_FIXTURE_SHA256,
  SPRINT4_CLIENT_SHA,
  assertClientPinValues,
  assertProvisionedRun,
  assertStructuredResultContract,
  buildClientFixtureEnvironment,
  cleanupJoinedRun,
  executeJoinedRunner,
  isJoinedRunEnabled,
  parseStructuredResult,
  redactOutput,
  runBounded,
  validateJoinedRunnerEnvironment,
} from "./sprint4-joined-runner.js";

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
    expect(() => assertStructuredResultContract({ pass: true, cleanup_verified: true, client_sha: SPRINT4_CLIENT_SHA, origin: "https://127.0.0.1:1234" }, run)).not.toThrow();
    expect(() => assertStructuredResultContract({ pass: true, cleanup_verified: true, client_sha: "other", origin: "https://127.0.0.1:1234" }, run)).toThrow("pinned");
    expect(() => assertStructuredResultContract({ pass: true, cleanup_verified: true, client_sha: SPRINT4_CLIENT_SHA, origin: "https://127.0.0.1:1234", session_token: "secret" }, run)).toThrow("credential-bearing");
  });

  it("maps checked provisioner references into the selected client fixture contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "borg-s4-runner-contract-"));
    const endpoint = "https://127.0.0.1:1234";
    const trust = "spki-sha256:" + "a".repeat(64);
    const ref = async (name: string, client: string, drone: string, session: string, credential: string): Promise<string> => {
      const path = join(root, name);
      await writeFile(path, JSON.stringify({
        endpoint, trust_material_reference: join(root, "ca.crt"), trust_identity: trust, cube_id: "11111111-1111-4111-8111-111111111111",
        client_id: client, client_credential: `${credential}-client`, role_id: "22222222-2222-4222-8222-222222222222", drone_id: drone,
        session_id: session, session_credential: credential,
      }));
      return path;
    };
    const reader = await ref("reader.json", "reader-client", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "r".repeat(43));
    const writerA = await ref("writer-a.json", "writer-a-client", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666", "a".repeat(43));
    const writerB = await ref("writer-b.json", "writer-b-client", "77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888", "b".repeat(43));
    const run = {
      endpoint, trustMaterialReference: join(root, "ca.crt"), trustIdentity: trust, cubeId: "11111111-1111-4111-8111-111111111111",
      credentialReferences: { reader, writerA, writerB },
      clientIds: { reader: "reader-client", writerA: "writer-a-client", writerB: "writer-b-client" },
      seats: {
        reader: { roleId: "22222222-2222-4222-8222-222222222222", droneId: "33333333-3333-4333-8333-333333333333", sessionId: "44444444-4444-4444-8444-444444444444" },
        writerA: { roleId: "22222222-2222-4222-8222-222222222222", droneId: "55555555-5555-4555-8555-555555555555", sessionId: "66666666-6666-4666-8666-666666666666" },
        writerB: { roleId: "22222222-2222-4222-8222-222222222222", droneId: "77777777-7777-4777-8777-777777777777", sessionId: "88888888-8888-4888-8888-888888888888" },
      }, cleanup: async () => {},
    } as Sprint4ProvisionedRun;
    try {
      const mapped = await buildClientFixtureEnvironment({}, "/tmp/disposable-client", run);
      expect(mapped).toMatchObject({
        BORG_S4_COUPLED_E2E: "1", BORG_E2E_CLIENT_SHA: SPRINT4_CLIENT_SHA,
        BORG_API_URL: endpoint, BORG_E2E_CA_PATH: join(root, "ca.crt"), BORG_E2E_TRUST_IDENTITY: trust,
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
          provision: async () => ({ ...run, cleanup: async () => { cleaned = true; } }),
          spawn: async (command, args, options) => {
            selected = command === "npx" && args.join(" ") === "vitest run __tests__/s4-coupled-e2e.test.ts" &&
              options.env["BORG_S4_COUPLED_E2E"] === "1" && options.env["BORG_E2E_READER_TOKEN"] === "r".repeat(43);
            return { code: 0, stderr: "", stdout: `S4_COUPLED_E2E ${JSON.stringify({ pass: true, cleanup_verified: true, client_sha: SPRINT4_CLIENT_SHA, origin: endpoint })}` };
          },
        },
      );
      expect(outcome).toMatchObject({ pass: true, cleanup_verified: true });
      expect(selected).toBe(true);
      expect(cleaned).toBe(true);
      await writeFile(writerB, JSON.stringify({
        endpoint, trust_material_reference: join(root, "ca.crt"), trust_identity: trust, cube_id: "11111111-1111-4111-8111-111111111111",
        client_id: "writer-b-client", client_credential: "unused", role_id: "22222222-2222-4222-8222-222222222222",
        drone_id: "77777777-7777-4777-8777-777777777777", session_id: "88888888-8888-4888-8888-888888888888", session_credential: "r".repeat(43),
      }));
      await expect(buildClientFixtureEnvironment({}, "/tmp/disposable-client", run)).rejects.toThrow("cross-wired");
      await writeFile(writerB, JSON.stringify({
        endpoint: "https://127.0.0.1:9999", trust_material_reference: join(root, "ca.crt"), trust_identity: trust, cube_id: "11111111-1111-4111-8111-111111111111",
        client_id: "writer-b-client", client_credential: "unused", role_id: "22222222-2222-4222-8222-222222222222",
        drone_id: "77777777-7777-4777-8777-777777777777", session_id: "88888888-8888-4888-8888-888888888888", session_credential: "b".repeat(43),
      }));
      await expect(buildClientFixtureEnvironment({}, "/tmp/disposable-client", run)).rejects.toThrow("does not match");
      await writeFile(writerB, "{}");
      await expect(buildClientFixtureEnvironment({}, "/tmp/disposable-client", run)).rejects.toThrow("incomplete");
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

  it("cleans owned state even if provisioner cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "borg-s4-runner-unit-"));
    await writeFile(join(root, "owned"), "state");
    await expect(cleanupJoinedRun({ cleanup: async () => { throw new Error("cleanup failure"); } }, root)).rejects.toThrow("cleanup failure");
    await expect(rm(root, { recursive: true, force: false })).rejects.toThrow();
  });
});
