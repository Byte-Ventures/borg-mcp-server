import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "borgmcp-server";
const ALLOWLIST_PATH = "scripts/release-identity-allowlist.json";
const PACKAGE_PATH = "package.json";
const LOCK_PATH = "npm-shrinkwrap.json";
const VERSION_CONSTANT_PATH = "src/runtime-identity.ts";
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function fail(message) {
  throw new Error(message);
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function parseJson(raw, path) {
  try { return JSON.parse(raw); } catch { fail(`${path} is not valid JSON.`); }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function version(value, description) {
  if (!VERSION_RE.test(value ?? "")) fail(`${description} must be a stable x.y.z version.`);
  return value;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function decodePins(raw) {
  const pins = parseJson(raw, ALLOWLIST_PATH)?.versionPins;
  if (!Array.isArray(pins) || pins.some((path) => typeof path !== "string" || !path)) {
    fail(`${ALLOWLIST_PATH} has an invalid versionPins array.`);
  }
  return pins;
}

async function readWorking(root, path) {
  return readFile(join(root, path), "utf8");
}

function readRef(root, ref, path) {
  return execFileSync("git", ["show", `${ref}:${path}`], { cwd: root, encoding: "utf8" });
}

function manifestVersion(raw, path) {
  const manifest = parseJson(raw, path);
  if (manifest.name !== PACKAGE_NAME) fail(`${path} has the wrong package name.`);
  return version(manifest.version, `${path} version`);
}

export async function prepareRelease(root, targetVersion) {
  const target = version(targetVersion, "Target version");
  if (git(root, ["status", "--porcelain"]) !== "") fail("release:prepare requires a clean working tree.");
  const manifest = parseJson(await readWorking(root, PACKAGE_PATH), PACKAGE_PATH);
  const current = manifestVersion(canonicalJson(manifest), PACKAGE_PATH);
  if (compareVersions(target, current) <= 0) fail("Target version must be newer than the current version.");
  manifest.version = target;
  await writeFile(join(root, PACKAGE_PATH), canonicalJson(manifest));

  const lock = parseJson(await readWorking(root, LOCK_PATH), LOCK_PATH);
  if (lock.name !== PACKAGE_NAME || lock.version !== current || lock.packages?.[""]?.version !== current) {
    fail(`${LOCK_PATH} root identity is invalid.`);
  }
  lock.version = target;
  lock.packages[""].version = target;
  await writeFile(join(root, LOCK_PATH), canonicalJson(lock));

  const paths = [PACKAGE_PATH, LOCK_PATH, VERSION_CONSTANT_PATH];
  const constant = await readWorking(root, VERSION_CONSTANT_PATH);
  const oldLiteral = `export const SERVER_PACKAGE_VERSION = "${current}";`;
  if (constant.split(oldLiteral).length !== 2) fail(`${VERSION_CONSTANT_PATH} package version is invalid.`);
  await writeFile(join(root, VERSION_CONSTANT_PATH), constant.replace(oldLiteral,
    `export const SERVER_PACKAGE_VERSION = "${target}";`));

  for (const path of decodePins(await readWorking(root, ALLOWLIST_PATH))) {
    const raw = await readWorking(root, path);
    if (!raw.includes(current)) fail(`Version pin is missing from ${path}.`);
    await writeFile(join(root, path), raw.replaceAll(current, target));
    paths.push(path);
  }
  return Object.freeze({ oldVersion: current, newVersion: target, paths: Object.freeze(paths.sort()) });
}

export function verifyReleaseIdentity(root, base, candidate) {
  const oldVersion = manifestVersion(readRef(root, base, PACKAGE_PATH), PACKAGE_PATH);
  const candidateManifest = parseJson(readRef(root, candidate, PACKAGE_PATH), PACKAGE_PATH);
  const newVersion = manifestVersion(canonicalJson(candidateManifest), PACKAGE_PATH);
  if (compareVersions(newVersion, oldVersion) <= 0) fail("Candidate package version is not newer than base.");
  const lock = parseJson(readRef(root, candidate, LOCK_PATH), LOCK_PATH);
  if (lock.name !== PACKAGE_NAME || lock.version !== newVersion ||
      lock.packages?.[""]?.name !== PACKAGE_NAME || lock.packages?.[""]?.version !== newVersion) {
    fail("Candidate lock and package identity differ.");
  }
  const constant = readRef(root, candidate, VERSION_CONSTANT_PATH);
  if (!constant.includes(`export const SERVER_PACKAGE_VERSION = "${newVersion}";`)) {
    fail("Candidate runtime package identity differs.");
  }
  for (const path of decodePins(readRef(root, candidate, ALLOWLIST_PATH))) {
    const raw = readRef(root, candidate, path);
    if (!raw.includes(newVersion) || raw.includes(oldVersion)) fail(`Candidate version pin differs: ${path}`);
  }
  return Object.freeze({ base, candidate, oldVersion, newVersion });
}

export function classifyReleasePullRequest(root, input) {
  if (input.repository !== "Byte-Ventures/borg-mcp-server" ||
      input.headRepository !== input.repository || !input.headRef.startsWith("release/")) {
    fail("Release identity classification requires a same-repository release/* pull request.");
  }
  return verifyReleaseIdentity(root, input.base, input.candidate);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  if (action === "prepare" && args.length === 1) {
    console.log(JSON.stringify(await prepareRelease(process.cwd(), args[0]), null, 2));
  } else if (action === "verify" && args.length === 4 && args[0] === "--base" && args[2] === "--candidate") {
    console.log(JSON.stringify(verifyReleaseIdentity(process.cwd(), args[1], args[3]), null, 2));
  } else if (action === "classify") {
    const values = new Map();
    for (let index = 0; index < args.length; index += 2) values.set(args[index], args[index + 1]);
    console.log(JSON.stringify(classifyReleasePullRequest(process.cwd(), {
      base: values.get("--base"), candidate: values.get("--candidate"),
      repository: values.get("--repository"), headRepository: values.get("--head-repository"),
      headRef: values.get("--head-ref"),
    }), null, 2));
  } else {
    fail("Usage: release-identity.mjs <prepare|verify|classify> ...");
  }
}
