export type RoleSectionPatchOp =
  | { readonly action: "replace"; readonly heading: string; readonly body: string }
  | {
    readonly action: "insert";
    readonly heading: string;
    readonly body: string;
    readonly after?: string | null;
  }
  | { readonly action: "delete"; readonly heading: string };

interface RoleSection {
  readonly heading: string | null;
  readonly body: string;
}

export function patchRoleSectionText(text: string, operation: RoleSectionPatchOp): string {
  validateHeading(operation.heading);
  const sections = parseSections(text);
  const target = normalizedHeading(operation.heading);
  const index = sections.findIndex((section) =>
    section.heading !== null && normalizedHeading(section.heading) === target
  );

  if (operation.action === "replace") {
    if (index === -1) throw new Error("Role section not found.");
    sections[index] = renderedSection(operation.heading, operation.body);
    return serializeSections(sections);
  }
  if (operation.action === "delete") {
    if (index === -1) throw new Error("Role section not found.");
    sections.splice(index, 1);
    return serializeSections(sections);
  }
  if (index !== -1) throw new Error("Role section already exists.");

  const section = renderedSection(operation.heading, operation.body);
  if (operation.after == null) {
    ensureTrailingNewline(sections, sections.length - 1);
    sections.push(section);
    return serializeSections(sections);
  }
  validateHeading(operation.after);
  const after = normalizedHeading(operation.after);
  const afterIndex = sections.findIndex((candidate) =>
    candidate.heading !== null && normalizedHeading(candidate.heading) === after
  );
  if (afterIndex === -1) throw new Error("Role section insertion point does not exist.");
  ensureTrailingNewline(sections, afterIndex);
  sections.splice(afterIndex + 1, 0, section);
  return serializeSections(sections);
}

function parseSections(text: string): RoleSection[] {
  const sections: RoleSection[] = [];
  const lines = text.split("\n");
  let heading: string | null = null;
  let body = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const sourceLine = index < lines.length - 1 ? `${line}\n` : line;
    if (isLabelLine(line)) {
      sections.push({ heading, body });
      heading = line.slice(0, -1).trim();
      body = sourceLine;
    } else {
      body += sourceLine;
    }
  }
  sections.push({ heading, body });
  return sections;
}

function isLabelLine(line: string): boolean {
  if (/^\s/u.test(line) || !line.endsWith(":")) return false;
  const label = line.slice(0, -1);
  return label.length > 0 && label.length <= 60 && !label.includes(":") &&
    !/^[*\-#>`]/u.test(label);
}

function renderedSection(heading: string, body: string): RoleSection {
  const normalizedBody = body === "" || body.endsWith("\n") ? body : `${body}\n`;
  return {
    heading: heading.trim(),
    body: `${heading.trim()}:\n${normalizedBody}`,
  };
}

function ensureTrailingNewline(sections: RoleSection[], index: number): void {
  const section = sections[index];
  if (section !== undefined && section.body !== "" && !section.body.endsWith("\n")) {
    sections[index] = { ...section, body: `${section.body}\n` };
  }
}

function serializeSections(sections: readonly RoleSection[]): string {
  return sections.map((section) => section.body).join("");
}

function normalizedHeading(heading: string): string {
  return heading.trim().toLowerCase();
}

function validateHeading(heading: string): void {
  if (typeof heading !== "string" || /[\r\n]/u.test(heading) ||
      !isLabelLine(`${heading.trim()}:`)) {
    throw new TypeError("Role section heading is invalid.");
  }
}
