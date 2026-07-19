import { readFile, readdir } from "node:fs/promises";
import { posix } from "node:path";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";

describe("clean-checkout verification", () => {
  it("builds ignored dist artifacts before typecheck and compiled-artifact tests", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");

    expect(packageJson.scripts["check"]).toBe("npm run build && npm run typecheck && npm test");
    expect(packageJson.scripts["pretest"]).toBe("npm run build");
    expect(gitignore.split(/\r?\n/u)).toContain("dist/");
  });

  it("keeps compiled-artifact imports runtime-resolved for no-dist typechecks", async () => {
    for (const bypass of [
      'import ( /* whitespace */ "../dist/main.js")',
      'import("\\u002e\\u002e/dist/main.js")',
      'import("../generated/../dist/main.js")',
      'import value from "../dist/main.js"',
      'export * from "../dist/main.js"',
      'require("../dist/main.js")',
    ]) {
      expect(generatedDistImports(bypass)).not.toEqual([]);
    }
    for (const allowed of [
      '// import("../dist/main.js")',
      'const documentation = "import(\\"../dist/main.js\\")"',
      'const modulePath = "../dist/main.js"; import(modulePath)',
      'import("../src/main.js")',
    ]) {
      expect(generatedDistImports(allowed)).toEqual([]);
    }
    for (const file of ["main.test.ts", "service.test.ts"]) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      expect(generatedDistImports(source)).toEqual([]);
      expect(source).toContain("await import(");
    }
  });

  it("keeps hosted review actions and static OAuth credentials out of workflows", async () => {
    const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
    const workflowNames = (await readdir(workflowDirectory))
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
    const forbidden = [
      /anthropics\/claude-code-action/iu,
      /\$\{\{\s*secrets\.[A-Z0-9_]*OAUTH_TOKEN\s*\}\}/iu,
      /plugin_marketplaces\s*:/iu,
    ];

    for (const name of workflowNames) {
      const workflow = await readFile(new URL(name, workflowDirectory), "utf8");
      for (const pattern of forbidden) {
        expect(workflow, `${name} contains forbidden hosted review integration ${pattern}`)
          .not.toMatch(pattern);
      }
    }
  });
});

function generatedDistImports(source: string): string[] {
  const scanner = createScanner(true, undefined, source);
  const tokens: Array<{ kind: SyntaxKind; text: string; value: string }> = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() });
  }
  const matches: string[] = [];
  const inspectSpecifier = (index: number): void => {
    const token = tokens[index];
    if (token === undefined || (token.kind !== SyntaxKind.StringLiteral &&
        token.kind !== SyntaxKind.NoSubstitutionTemplateLiteral)) return;
    const normalized = posix.normalize(token.value.replaceAll("\\", "/"));
    if (normalized === "../dist" || normalized.startsWith("../dist/")) matches.push(token.value);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if ((token.kind === SyntaxKind.ImportKeyword || token.text === "require") &&
        tokens[index + 1]?.kind === SyntaxKind.OpenParenToken) {
      inspectSpecifier(index + 2);
      continue;
    }
    if (token.kind === SyntaxKind.ImportKeyword) {
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor]!;
        if (candidate.kind === SyntaxKind.SemicolonToken) break;
        if (candidate.kind === SyntaxKind.StringLiteral ||
            candidate.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
          inspectSpecifier(cursor);
          break;
        }
      }
      continue;
    }
    if (token.kind === SyntaxKind.ExportKeyword) {
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor]!;
        if (candidate.kind === SyntaxKind.SemicolonToken) break;
        if (candidate.kind === SyntaxKind.FromKeyword) inspectSpecifier(cursor + 1);
      }
    }
  }
  return matches;
}
