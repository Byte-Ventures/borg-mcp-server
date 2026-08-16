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
  { class: "status", prefixes: ["DONE"], lifecycle: "completion" },
  { class: "wide", prefixes: ["HALT"] },
])!;

describe("message taxonomy", () => {
  it("canonicalizes classes and rejects ambiguous declarations", () => {
    expect(validateMessageTaxonomy([
      { class: " status " },
    ])).toEqual([{ class: "status", prefixes: [] }]);
    expect(() => validateMessageTaxonomy([
      { class: "one", prefixes: ["DONE"] },
      { class: "two", prefixes: ["done"] },
    ])).toThrow("prefixes must be unique");
    expect(() => validateMessageTaxonomy([
      { class: "legacy", routing: "broadcast" },
    ])).toThrow("unknown field");
    expect(() => validateMessageTaxonomy([
      { class: "legacy", default_to: ["coordinator"] },
    ])).toThrow("unknown field");
  });

  it("adds, replaces, and removes classes through whole-taxonomy validation", () => {
    const added = patchMessageTaxonomy(taxonomy, {
      action: "add",
      classDef: { class: "review", prefixes: ["REVIEW"] },
    });
    expect(added).toHaveLength(3);
    const replaced = patchMessageTaxonomy(added, {
      action: "replace",
      classDef: { class: "REVIEW", prefixes: ["CHECK"] },
    });
    expect(replaced?.[2]).toEqual({ class: "REVIEW", prefixes: ["CHECK"] });
    expect(patchMessageTaxonomy(replaced, { action: "remove", className: "review" })).toHaveLength(2);
  });

  it("classifies messages without changing their explicit audience", () => {
    expect(resolveMessageRouting({ message: "DONE: shipped", to: "broadcast" }, taxonomy, roles, drones))
      .toEqual({
        visibility: "broadcast",
        recipientDroneIds: [],
        routing: { class: "status", recipients: [] },
      });
    expect(resolveMessageRouting({
      message: "ordinary",
      className: "wide",
      to: "broadcast",
    }, taxonomy, roles, drones))
      .toMatchObject({ visibility: "broadcast", routing: { class: "wide" } });
    expect(resolveMessageRouting({ message: "ordinary", to: ["code-reviewer"] }, taxonomy, roles, drones))
      .toEqual({
        visibility: "direct",
        recipientDroneIds: [drones[1]!.id],
        routing: { class: null, recipients: [drones[1]!.id] },
      });
    expect(resolveMessageRouting({ message: "DONE", to: ["code-reviewer"] }, taxonomy, roles, drones))
      .toMatchObject({
        visibility: "direct",
        recipientDroneIds: [drones[1]!.id],
        routing: { class: "status" },
      });
  });

  it("fails closed when an explicit recipient selector does not resolve", () => {
    expect(() => resolveMessageRouting(
      { message: "DONE", to: ["missing-role"] },
      taxonomy,
      roles,
      drones,
    )).toThrow("Recipient does not exist");
    expect(() => resolveMessageRouting(
      { message: "DONE", to: ["observer"] },
      taxonomy,
      roles,
      drones,
    )).toThrow("Recipient does not exist");
  });
});
