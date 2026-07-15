import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  clientPrincipal,
  droneSessionPrincipal,
  operatorPrincipal,
  assertServerDerivedPrincipal,
} from "../src/principal.js";
import { openStore } from "../src/store.js";

describe("Principal", () => {
  it("creates immutable server-derived identity shapes without product roles", () => {
    const operator = operatorPrincipal("00000000-0000-4000-8000-000000000001");
    const client = clientPrincipal("00000000-0000-4000-8000-000000000002");
    const drone = droneSessionPrincipal({
      id: "00000000-0000-4000-8000-000000000003",
      clientId: "00000000-0000-4000-8000-000000000002",
      cubeId: "00000000-0000-4000-8000-000000000004",
      droneId: "00000000-0000-4000-8000-000000000005",
    });

    expect(Object.isFrozen(operator)).toBe(true);
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(drone)).toBe(true);
    expect("role" in operator).toBe(false);
    expect("role" in client).toBe(false);
    expect("role" in drone).toBe(false);
  });

  it("rejects non-canonical identity values", () => {
    expect(() => clientPrincipal("not-an-id")).toThrow("Principal id must be a canonical UUID.");
  });

  it("does not accept a structurally forged operator principal", async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "borg-principal-forgery-")),
    );
    const path = join(directory, "borg.db");
    const runtime = await openStore({ path });
    try {
      expect(() => runtime.forPrincipal({
        kind: "operator",
        id: "00000000-0000-4000-8000-000000000001",
      } as never)).toThrow("Principal must be created by the server authentication boundary.");
    } finally {
      runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts only exact factory principals across all kinds", () => {
    const principals = [
      operatorPrincipal("00000000-0000-4000-8000-000000000011"),
      clientPrincipal("00000000-0000-4000-8000-000000000012"),
      droneSessionPrincipal({
        id: "00000000-0000-4000-8000-000000000013",
        clientId: "00000000-0000-4000-8000-000000000012",
        cubeId: "00000000-0000-4000-8000-000000000014",
        droneId: "00000000-0000-4000-8000-000000000015",
      }),
    ];
    for (const principal of principals) {
      expect(() => assertServerDerivedPrincipal(principal)).not.toThrow();
    }
  });

  it("rejects inherited brands, shadowed escalation, accessors, polluted prototypes, and clones", () => {
    const valid = clientPrincipal("00000000-0000-4000-8000-000000000021");
    const inheritedBrand = Object.freeze(Object.create(valid) as object);
    const escalation = Object.create(valid) as Record<string, unknown>;
    Object.defineProperties(escalation, {
      kind: { value: "operator", enumerable: true },
      id: { value: "00000000-0000-4000-8000-000000000022", enumerable: true },
      shadow: { value: true, enumerable: true },
    });
    Object.freeze(escalation);
    const getter = vi.fn(() => {
      throw new Error("attacker getter executed");
    });
    const accessor = {} as Record<string, unknown>;
    Object.defineProperties(accessor, {
      kind: { get: getter, enumerable: true },
      id: { value: "00000000-0000-4000-8000-000000000023", enumerable: true },
    });
    Object.freeze(accessor);
    const pollutedPrototype = {
      kind: "operator",
      id: "00000000-0000-4000-8000-000000000024",
    };
    const polluted = Object.freeze(Object.create(pollutedPrototype) as object);
    const clone = Object.freeze({ kind: "client", id: valid.id });

    for (const forged of [inheritedBrand, escalation, accessor, polluted, clone]) {
      expect(() => assertServerDerivedPrincipal(forged)).toThrow(
        "Principal must be created by the server authentication boundary.",
      );
    }
    expect(getter).not.toHaveBeenCalled();
  });
});
