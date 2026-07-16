import { describe, expect, it } from "vitest";
import { patchRoleSectionText } from "../src/role-section.js";

const roleText =
  "Preamble line.\n\n" +
  "Workflow:\n- old step\n\n" +
  "Project conventions:\n- TDD.\n";

describe("patchRoleSectionText", () => {
  it("replaces one plain-label section without changing adjacent bytes", () => {
    expect(patchRoleSectionText(roleText, {
      action: "replace",
      heading: "workflow",
      body: "- new step",
    })).toBe(
      "Preamble line.\n\n" +
      "workflow:\n- new step\n" +
      "Project conventions:\n- TDD.\n",
    );
  });

  it("inserts after a named section and appends safely after unterminated text", () => {
    expect(patchRoleSectionText(roleText, {
      action: "insert",
      heading: "Review gate",
      body: "- require exact SHA",
      after: "Workflow",
    })).toBe(
      "Preamble line.\n\n" +
      "Workflow:\n- old step\n\n" +
      "Review gate:\n- require exact SHA\n" +
      "Project conventions:\n- TDD.\n",
    );
    expect(patchRoleSectionText("Preamble without newline", {
      action: "insert",
      heading: "Workflow",
      body: "Act.",
    })).toBe("Preamble without newline\nWorkflow:\nAct.\n");
  });

  it("deletes one section and rejects missing, duplicate, or invalid headings", () => {
    expect(patchRoleSectionText(roleText, { action: "delete", heading: "Workflow" })).toBe(
      "Preamble line.\n\nProject conventions:\n- TDD.\n",
    );
    expect(() => patchRoleSectionText(roleText, {
      action: "replace", heading: "Missing", body: "x",
    })).toThrow(/not found/u);
    expect(() => patchRoleSectionText(roleText, {
      action: "insert", heading: "workflow", body: "x",
    })).toThrow(/already exists/u);
    expect(() => patchRoleSectionText(roleText, {
      action: "insert", heading: "**Markdown**", body: "x",
    })).toThrow(/invalid/u);
    expect(() => patchRoleSectionText(roleText, {
      action: "insert", heading: "Injected\nHeading", body: "x",
    })).toThrow(/invalid/u);
  });
});
