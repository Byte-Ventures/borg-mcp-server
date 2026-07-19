import { describe, expect, it } from "vitest";

import {
  patchMessageTaxonomy,
  resolveMessageRouting,
  validateMessageTaxonomy,
} from "../src/message-taxonomy.js";

const roles = [
  { id: "role-coordinator", name: "Coordinator", is_human_seat: true },
  { id: "role-reviewer", name: "Code Reviewer", is_human_seat: false },
];
const drones = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", label: "one-coordinator", role_id: "role-coordinator", posture: "participant" as const },
  { id: "bbbbbbbb-0000-4000-8000-000000000002", label: "one-reviewer", role_id: "role-reviewer", posture: "participant" as const },
  { id: "cccccccc-0000-4000-8000-000000000003", label: "observer", role_id: "role-reviewer", posture: "observer" as const },
];
const taxonomy = validateMessageTaxonomy([
  { class: "status", prefixes: ["DONE"], routing: "directed", default_to: ["coordinator"] },
  { class: "wide", prefixes: ["HALT"], routing: "broadcast" },
])!;

describe("message taxonomy", () => {
  it("canonicalizes classes and rejects ambiguous declarations", () => {
    expect(validateMessageTaxonomy([
      { class: " status ", routing: "broadcast" },
    ])).toEqual([{ class: "status", prefixes: [], routing: "broadcast" }]);
    expect(() => validateMessageTaxonomy([
      { class: "one", prefixes: ["DONE"], routing: "broadcast" },
      { class: "two", prefixes: ["done"], routing: "broadcast" },
    ])).toThrow("prefixes must be unique");
    expect(() => validateMessageTaxonomy([
      { class: "direct", routing: "directed" },
    ])).toThrow("require default recipients");
  });

  it("adds, replaces, and removes classes through whole-taxonomy validation", () => {
    const added = patchMessageTaxonomy(taxonomy, {
      action: "add",
      classDef: { class: "review", prefixes: ["REVIEW"], routing: "directed", default_to: ["code-reviewer"] },
    });
    expect(added).toHaveLength(3);
    const replaced = patchMessageTaxonomy(added, {
      action: "replace",
      classDef: { class: "REVIEW", prefixes: ["CHECK"], routing: "broadcast" },
    });
    expect(replaced?.[2]).toMatchObject({ class: "REVIEW", prefixes: ["CHECK"], routing: "broadcast" });
    expect(patchMessageTaxonomy(replaced, { action: "remove", className: "review" })).toHaveLength(2);
  });

  it("routes explicit targets, classes, prefixes, and fall-open defaults", () => {
    expect(resolveMessageRouting({ message: "DONE: shipped" }, taxonomy, roles, drones))
      .toMatchObject({ visibility: "direct", recipientDroneIds: [drones[0]!.id], routing: { class: "status" } });
    expect(resolveMessageRouting({ message: "ordinary", className: "wide" }, taxonomy, roles, drones))
      .toMatchObject({ visibility: "broadcast", routing: { class: "wide" } });
    expect(resolveMessageRouting({ message: "ordinary", to: ["code-reviewer"] }, taxonomy, roles, drones))
      .toMatchObject({ visibility: "direct", recipientDroneIds: [drones[1]!.id] });
    const stale = validateMessageTaxonomy([
      { class: "stale", prefixes: ["STALE"], routing: "directed", default_to: ["missing-role"] },
    ]);
    expect(resolveMessageRouting({ message: "STALE" }, stale, roles, drones))
      .toMatchObject({ visibility: "broadcast", routing: { class: "stale", fellOpen: true } });
  });

  it("keeps legacy explicit visibility and recipient ids authoritative", () => {
    expect(resolveMessageRouting({
      message: "DONE",
      visibility: "direct",
      recipientDroneIds: [drones[1]!.id],
      className: "wide",
    }, taxonomy, roles, drones)).toMatchObject({
      visibility: "direct",
      recipientDroneIds: [drones[1]!.id],
      routing: { class: null },
    });
  });
});
