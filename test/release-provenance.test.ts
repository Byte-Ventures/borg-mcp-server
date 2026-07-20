import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  readWithPropagationRetry,
  verifyArtifactReport,
  verifyPostpublish,
  verifyPrepublish,
} from "../scripts/verify-registry-release.mjs";

const integrity = `sha512-${createHash("sha512").update("audited server tarball").digest("base64")}`;
const report = { name: "borgmcp-server", version: "1.2.3", integrity };

const response = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

describe("minimal npm registry assurance", () => {
  it("delegates provenance verification to npm audit signatures", async () => {
    const source = await readFile("scripts/verify-registry-release.mjs", "utf8");
    for (const removed of ["dsseEnvelope", "verifyProvenanceStatement", "in-toto", "SLSA", "attestations"]) {
      expect(source).not.toContain(removed);
    }
  });

  it("binds the verifier report to the exact package, version, and SHA-512 integrity", () => {
    expect(verifyArtifactReport(report, "1.2.3")).toEqual(report);
    expect(() => verifyArtifactReport({ ...report, name: "other" }, "1.2.3"))
      .toThrow("must be borgmcp-server");
    expect(() => verifyArtifactReport({ ...report, version: "1.2.4" }, "1.2.3"))
      .toThrow("exactly 1.2.3");
    expect(() => verifyArtifactReport({ ...report, integrity: "sha512-short" }, "1.2.3"))
      .toThrow("full SHA-512 integrity");
  });

  it("accepts only an unused version owned solely by the reviewed maintainer", async () => {
    const responses = [
      response(404),
      response(200, { maintainers: [{ name: "byteventures" }] }),
    ];
    await expect(verifyPrepublish(report, {
      expectedVersion: "1.2.3",
      expectedOwner: "byteventures",
      request: async () => responses.shift()!,
    })).resolves.toEqual({
      name: "borgmcp-server",
      version: "1.2.3",
      registryState: "owned",
    });
  });

  it("rejects an existing immutable version before reading package ownership", async () => {
    let requests = 0;
    await expect(verifyPrepublish(report, {
      expectedVersion: "1.2.3",
      expectedOwner: "byteventures",
      request: async () => {
        requests += 1;
        return response(200);
      },
    })).rejects.toThrow("already exists and is immutable");
    expect(requests).toBe(1);
  });

  it.each([
    ["wrong configured owner", "other", [{ name: "byteventures" }], "must equal the reviewed owner"],
    ["wrong registry owner", "byteventures", [{ name: "other" }], "ownership differs"],
    ["multiple registry owners", "byteventures", [{ name: "byteventures" }, { name: "other" }], "ownership differs"],
  ])("rejects %s", async (_case, expectedOwner, maintainers, message) => {
    const responses = [response(404), response(200, { maintainers })];
    await expect(verifyPrepublish(report, {
      expectedVersion: "1.2.3",
      expectedOwner,
      request: async () => responses.shift()!,
    })).rejects.toThrow(message);
  });

  it("rejects an unexpectedly unclaimed package instead of bootstrapping ownership", async () => {
    const responses = [response(404), response(404)];
    await expect(verifyPrepublish(report, {
      expectedVersion: "1.2.3",
      expectedOwner: "byteventures",
      request: async () => responses.shift()!,
    })).rejects.toThrow("unexpectedly unclaimed");
  });

  it("survives registry propagation beyond the former twelve-read window", async () => {
    let reads = 0;
    const waits: number[] = [];
    const result = await verifyPostpublish(report, {
      expectedVersion: "1.2.3",
      request: async () => {
        reads += 1;
        return reads <= 12 ? response(404) : response(200, { dist: { integrity } });
      },
      wait: async (milliseconds: number) => {
        waits.push(milliseconds);
      },
    });
    expect(result).toEqual({ ...report, registryState: "verified" });
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

  it("fails closed after the bounded registry propagation window", async () => {
    let reads = 0;
    await expect(verifyPostpublish(report, {
      expectedVersion: "1.2.3",
      request: async () => {
        reads += 1;
        return response(404);
      },
      wait: async () => {},
    })).rejects.toThrow("remained HTTP 404 after 18 attempts");
    expect(reads).toBe(18);
  });

  it("does not retry terminal registry errors", async () => {
    let reads = 0;
    const result = await readWithPropagationRetry(
      async () => {
        reads += 1;
        return response(503);
      },
      "Published version verification",
      { wait: async () => {} },
    );
    expect(result.status).toBe(503);
    expect(reads).toBe(1);
  });

  it("rejects a registry integrity mismatch", async () => {
    await expect(verifyPostpublish(report, {
      expectedVersion: "1.2.3",
      request: async () => response(200, { dist: { integrity: "sha512-wrong" } }),
    })).rejects.toThrow("Registry integrity mismatch");
  });
});
