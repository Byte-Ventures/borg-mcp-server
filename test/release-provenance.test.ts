import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyProvenanceStatement } from "../scripts/verify-registry-release.mjs";

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
