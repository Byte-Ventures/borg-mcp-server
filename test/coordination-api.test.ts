import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CoordinationApi } from "../src/coordination-api.js";
import {
  CredentialAuthority,
  CredentialDigester,
  LiveCredentialRegistry,
} from "../src/credentials.js";
import { openStore, type StoreRuntime } from "../src/store.js";

const directories: string[] = [];
let runtime: StoreRuntime | undefined;
let digester: CredentialDigester | undefined;

afterEach(async () => {
  runtime?.close();
  digester?.destroy();
  runtime = undefined;
  digester = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("coordination stream setup", () => {
  it("releases live registrations and listeners when stream setup fails", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 4));
    const registry = new LiveCredentialRegistry();
    const authority = new CredentialAuthority(runtime.credentials, digester, () => new Date(), registry);
    const invitation = authority.createBootstrapInvitation(60_000);
    const enrollment = authority.exchangeInvitation({ invitation });
    expect(enrollment).not.toBeNull();
    const clientId = enrollment!.clientId;
    const authorization = `Bearer ${enrollment!.credential}`;
    const cubeId = "00000000-0000-4000-8000-000000000021";
    runtime.maintenance.createCube({ id: cubeId, name: "Authorized", directive: "" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    const api = new CoordinationApi(runtime, authority);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await api.handle({
        method: "GET",
        path: "/api/cubes/00000000-0000-4000-8000-000000000022/stream",
        authorization,
        signal: new AbortController().signal,
      });
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe("NOT_FOUND");
      expect(registry.activeSessionCount(clientId)).toBe(0);
    }

    const invalidCursor = Buffer.from(JSON.stringify({
      id: "00000000-0000-4000-8000-000000000023",
      created_at: "2026-07-14T13:00:00.000Z",
    })).toString("base64url");
    const invalidReplay = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/stream`,
      authorization,
      cursor: invalidCursor,
      signal: new AbortController().signal,
    });
    expect(invalidReplay.status).toBe(404);
    expect(registry.activeSessionCount(clientId)).toBe(0);

  });
});
