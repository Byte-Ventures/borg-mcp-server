import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "Byte-Ventures/borg-mcp-server";
const PACKAGE_NAME = "borgmcp-server";
const API = "https://api.github.com";
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function fail(message) {
  throw new Error(message);
}

function git(root, args, raw = false) {
  const value = execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return raw ? value : value.trim();
}

async function registryPackage(name, version) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { headers: { accept: "application/json" }, cache: "no-store" },
  );
  if (!response.ok) fail(`Published package lookup returned HTTP ${response.status}.`);
  return response.json();
}

export function assembleReleaseBody({ version, integrity, tag, commit, releaseNotes }) {
  return [
    "## Package",
    "",
    `- Registry: https://www.npmjs.com/package/${PACKAGE_NAME}/v/${version}`,
    `- Live integrity: \`${integrity}\``,
    "- Published through npm Trusted Publishing with provenance.",
    "",
    "## Source",
    "",
    `- Tag: https://github.com/${REPOSITORY}/releases/tag/${tag}`,
    `- Commit: https://github.com/${REPOSITORY}/commit/${commit}`,
    "",
    "## News and fixes",
    "",
    releaseNotes,
  ].join("\n");
}

const systemAuthorities = Object.freeze({
  git,
  registryPackage,
  request(url, options) {
    return fetch(url, options);
  },
});

export async function createGithubRelease(version, {
  root = process.cwd(),
  token = process.env.GITHUB_TOKEN,
  authorities = systemAuthorities,
} = {}) {
  if (!VERSION_RE.test(version ?? "")) fail("Released version must be a stable X.Y.Z version.");
  if (!token) fail("GITHUB_TOKEN is required to create a GitHub Release.");
  const tag = `v${version}`;
  const ref = `refs/tags/${tag}`;
  if (authorities.git(root, ["cat-file", "-t", ref]) !== "tag") {
    fail(`Release tag is not annotated: ${tag}`);
  }
  const commit = authorities.git(root, ["rev-parse", `${ref}^{commit}`]);
  const tagMessage = authorities.git(root, ["for-each-ref", "--format=%(contents)", ref]);
  if (!tagMessage) fail(`Annotated release tag has no message: ${tag}`);
  let releaseNotes;
  try {
    releaseNotes = authorities.git(root, ["show", `${commit}:docs/releases/${version}.md`], true);
  } catch {
    fail(`Tagged release notes are missing: docs/releases/${version}.md`);
  }
  if (!releaseNotes.trim()) fail(`Tagged release notes are blank: docs/releases/${version}.md`);
  const published = await authorities.registryPackage(PACKAGE_NAME, version);
  const integrity = published?.dist?.integrity;
  if (published?.name !== PACKAGE_NAME || published?.version !== version || typeof integrity !== "string") {
    fail("Published package identity or integrity is invalid.");
  }
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
  const releaseUrl = `${API}/repos/${REPOSITORY}/releases/tags/${tag}`;
  const existing = await authorities.request(releaseUrl, { headers, cache: "no-store" });
  if (existing.status !== 404) {
    if (existing.ok) fail(`GitHub Release already exists for ${tag}.`);
    fail(`GitHub Release existence check returned HTTP ${existing.status}.`);
  }
  const body = assembleReleaseBody({ version, integrity, tag, commit, releaseNotes });
  const created = await authorities.request(`${API}/repos/${REPOSITORY}/releases`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tag_name: tag, name: tagMessage, make_latest: "true", body }),
  });
  if (!created.ok) fail(`GitHub Release creation returned HTTP ${created.status}.`);
  return created.json();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [version, ...extra] = process.argv.slice(2);
  if (!version || extra.length > 0) fail("Usage: node scripts/create-github-release.mjs <version>");
  console.log(JSON.stringify(await createGithubRelease(version), null, 2));
}
