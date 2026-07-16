import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  postpublish,
  readWithPropagationRetry,
  verifyProvenanceStatement,
} from "../scripts/verify-registry-release.mjs";

const tarball = Buffer.from("audited server tarball");
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
const digest = createHash("sha512").update(tarball).digest("hex");
const commit = "0123456789abcdef0123456789abcdef01234567";

function statement() {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "pkg:npm/borgmcp-server@1.2.3", digest: { sha512: digest } }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "https://github.com/Byte-Ventures/borg-mcp-server",
            path: ".github/workflows/release.yml",
            ref: "refs/tags/v1.2.3",
          },
        },
        internalParameters: { github: { event_name: "push" } },
        resolvedDependencies: [{
          uri: "git+https://github.com/Byte-Ventures/borg-mcp-server@refs/tags/v1.2.3",
          digest: { gitCommit: commit },
        }],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
}

describe("npm provenance guard", () => {
  it("survives registry propagation beyond the former twelve-read window", async () => {
    let reads = 0;
    const waits: number[] = [];
    const response = await readWithPropagationRetry(
      async () => {
        reads += 1;
        return { status: reads <= 12 ? 404 : 200 };
      },
      "Provenance verification",
      {
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      },
    );
    expect(response.status).toBe(200);
    expect(reads).toBe(13);
    expect(waits).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      15_000,
      15_000,
      15_000,
      15_000,
      15_000,
      15_000,
      15_000,
      15_000,
    ]);
  });

  it("fails closed after the full production propagation window", async () => {
    let reads = 0;
    await expect(readWithPropagationRetry(
      async () => {
        reads += 1;
        return { status: 404 };
      },
      "Post-publish ownership check",
      { wait: async () => {} },
    )).rejects.toThrow("Post-publish ownership check remained HTTP 404 after 18 attempts.");
    expect(reads).toBe(18);
  });

  it("does not retry terminal non-404 registry responses", async () => {
    let reads = 0;
    const response = await readWithPropagationRetry(
      async () => {
        reads += 1;
        return { status: 503 };
      },
      "Published version verification",
      { wait: async () => {} },
    );
    expect(response.status).toBe(503);
    expect(reads).toBe(1);
  });

  it("verifies version, provenance, and ownership after independent propagation lag", async () => {
    const attestationsUrl =
      "https://registry.npmjs.org/-/npm/v1/attestations/borgmcp-server@1.2.3";
    const reads = new Map<string, number>();
    const response = (status: number, body: unknown = {}) => ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    }) as Response;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const count = (reads.get(url) ?? 0) + 1;
      reads.set(url, count);
      if (count <= 12) return response(404);
      if (url.endsWith("/borgmcp-server/1.2.3")) {
        return response(200, {
          dist: {
            integrity,
            attestations: {
              provenance: { predicateType: "https://slsa.dev/provenance/v1" },
              url: attestationsUrl,
            },
          },
        });
      }
      if (url === attestationsUrl) {
        return response(200, {
          attestations: [{
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payloadType: "application/vnd.in-toto+json",
                payload: Buffer.from(JSON.stringify(statement())).toString("base64"),
              },
            },
          }],
        });
      }
      if (url.endsWith("/borgmcp-server")) {
        return response(200, { maintainers: [{ name: "byteventures" }] });
      }
      throw new Error(`Unexpected registry request: ${url}`);
    });
    const previousOwner = process.env["NPM_EXPECTED_OWNER"];
    const previousSha = process.env["GITHUB_SHA"];
    vi.stubGlobal("fetch", fetchMock);
    process.env["NPM_EXPECTED_OWNER"] = "byteventures";
    process.env["GITHUB_SHA"] = commit;
    try {
      await expect(postpublish("borgmcp-server", "1.2.3", integrity, {
        wait: async () => {},
      })).resolves.toEqual({
        name: "borgmcp-server",
        version: "1.2.3",
        integrity,
        registryState: "verified",
      });
      expect([...reads.values()]).toEqual([13, 13, 13]);
    } finally {
      vi.unstubAllGlobals();
      if (previousOwner === undefined) delete process.env["NPM_EXPECTED_OWNER"];
      else process.env["NPM_EXPECTED_OWNER"] = previousOwner;
      if (previousSha === undefined) delete process.env["GITHUB_SHA"];
      else process.env["GITHUB_SHA"] = previousSha;
    }
  });

  it("accepts an exact artifact, tag, workflow, commit, and builder binding", () => {
    expect(() => verifyProvenanceStatement(
      statement(),
      "application/vnd.in-toto+json",
      "borgmcp-server",
      "1.2.3",
      integrity,
      commit,
    )).not.toThrow();
  });

  it.each([
    ["workflow", (value: ReturnType<typeof statement>) => {
      value.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml";
    }],
    ["tag", (value: ReturnType<typeof statement>) => {
      value.predicate.buildDefinition.externalParameters.workflow.ref = "refs/tags/v9.9.9";
    }],
    ["commit", (value: ReturnType<typeof statement>) => {
      value.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit = "f".repeat(40);
    }],
    ["subject", (value: ReturnType<typeof statement>) => {
      value.subject[0]!.digest.sha512 = "0".repeat(128);
    }],
  ])("rejects a mismatched %s", (_name, mutate) => {
    const value = statement();
    mutate(value);
    expect(() => verifyProvenanceStatement(
      value,
      "application/vnd.in-toto+json",
      "borgmcp-server",
      "1.2.3",
      integrity,
      commit,
    )).toThrow();
  });
});
