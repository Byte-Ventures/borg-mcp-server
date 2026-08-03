import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const serverRoot = resolve(process.env.BORG_242_SERVER_ROOT ?? repositoryRoot);
const clientSpec = process.env.BORG_CLIENT_SPEC ?? "borgmcp@2.10.2";
const pythonExecutable = process.env.PYTHON ?? "python3";
const expectGuardPresent = process.argv.includes("--expect-guard-present");
const unexpectedArguments = process.argv.slice(2).filter(
  (argument) => argument !== "--expect-guard-present",
);
if (unexpectedArguments.length > 0) {
  throw new Error("Usage: node scripts/cube-binding-operator-gate.mjs [--expect-guard-present]");
}

const ptyRunner = join(scriptDirectory, "cube-binding-operator-pty-runner.py");
const logRunner = join(scriptDirectory, "cube-binding-operator-log-runner.mjs");
await access(ptyRunner);
await access(logRunner);
await access(join(serverRoot, "dist/store.js"));
await access(join(serverRoot, "node_modules/selfsigned/package.json"));

const serverRequire = createRequire(join(serverRoot, "package.json"));
const { generate } = serverRequire("selfsigned");
const importServerModule = (name) => import(
  pathToFileURL(join(serverRoot, "dist", name)).href
);
const [
  { openStore },
  { CredentialAuthority, CredentialDigester, generateSecret },
  { CoordinationApi },
  { createEnrollmentExchange },
  { startHttpsServer },
] = await Promise.all([
  importServerModule("store.js"),
  importServerModule("credentials.js"),
  importServerModule("coordination-api.js"),
  importServerModule("enrollment.js"),
  importServerModule("https-server.js"),
]);

async function installPublishedClient(installationRoot) {
  const npmHome = join(installationRoot, "npm-home");
  const npmCache = join(installationRoot, "npm-cache");
  const npmConfig = join(installationRoot, "npmrc");
  const npmGlobalConfig = join(installationRoot, "global-npmrc");
  await mkdir(npmHome);
  await mkdir(npmCache);
  await writeFile(npmConfig, "");
  await writeFile(npmGlobalConfig, "");
  await writeFile(
    join(installationRoot, "package.json"),
    `${JSON.stringify({ private: true })}\n`,
  );
  const npmEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")),
  );
  Object.assign(npmEnvironment, {
    HOME: npmHome,
    XDG_CONFIG_HOME: join(installationRoot, "xdg-config"),
    XDG_CACHE_HOME: join(installationRoot, "xdg-cache"),
    XDG_DATA_HOME: join(installationRoot, "xdg-data"),
    npm_config_cache: npmCache,
    npm_config_globalconfig: npmGlobalConfig,
    npm_config_prefix: installationRoot,
    npm_config_userconfig: npmConfig,
  });
  execFileSync(
    "npm",
    [
      "install",
      "--prefix", installationRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--omit=dev",
      "--registry=https://registry.npmjs.org",
      clientSpec,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: npmEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const clientBin = join(installationRoot, "node_modules", "borgmcp", "dist", "claude.js");
  await access(clientBin);
  await access(join(installationRoot, "node_modules", "borgmcp", "dist", "cubes.js"));
  await access(join(installationRoot, "node_modules", "borgmcp", "dist", "remote-client.js"));
  return clientBin;
}

async function runPty(clientBin, args, input, cwd, home) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(
      pythonExecutable,
      [ptyRunner, process.execPath, clientBin, ...args],
      {
        cwd,
        env: { ...process.env, HOME: home, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, 10_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, output });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function runRealClientLog(clientPackageRoot, cwd, home) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [logRunner], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        NO_COLOR: "1",
        BORG_OPERATOR_CLIENT_ROOT: clientPackageRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`published client log runner failed (${code})`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        reject(new Error("published client log runner returned invalid JSON"));
      }
    });
  });
}

let root;
let clientInstallation;
let runtime;
let digester;
let database;
let server;
try {
  clientInstallation = await mkdtemp(join(tmpdir(), "borg-242-client-"));
  const clientBin = await installPublishedClient(clientInstallation);
  root = await realpath(await mkdtemp(join(tmpdir(), "borg-242-operator-")));
  const repoFirst = join(root, "repo-first");
  const repoSecond = join(root, "repo-second");
  const home = join(root, "home");
  await mkdir(repoFirst);
  await mkdir(repoSecond);
  await mkdir(home);
  execFileSync("git", ["init", "--quiet", repoFirst]);
  execFileSync("git", ["init", "--quiet", repoSecond]);
  for (const repository of [repoFirst, repoSecond]) {
    execFileSync("git", [
      "-C", repository, "remote", "add", "origin", "https://github.com/example/shared.git",
    ]);
  }

  const databasePath = join(root, "borg.db");
  runtime = await openStore({ path: databasePath });
  digester = new CredentialDigester(Buffer.alloc(32, 7));
  const authority = new CredentialAuthority(runtime.credentials, digester);
  const api = new CoordinationApi(runtime, authority);
  const enrollment = createEnrollmentExchange(authority);
  const ca = await generate([{ name: "commonName", value: "Borg 242 Test CA" }], {
    algorithm: "sha256",
    keyType: "ec",
    extensions: [
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    ],
  });
  const material = await generate([{ name: "commonName", value: "localhost" }], {
    algorithm: "sha256",
    keyType: "ec",
    ca: { key: ca.private, cert: ca.cert },
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, keyAgreement: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
    ],
  });
  server = await startHttpsServer({
    bind: { port: 0 },
    tls: { key: material.private, cert: material.cert, ca: ca.cert },
    authorizeCoordination: async (authorization) => authority.authenticateStatus(authorization),
    exchangeEnrollment: (body) => enrollment(body),
    handleCoordination: (request) => api.handle(request),
  });

  const ownerInvitation = authority.createBootstrapInvitation(60_000);
  const ownerCredential = generateSecret();
  const ownerEnrollment = authority.exchangeInvitation({
    invitation: ownerInvitation,
    retryKey: randomUUID(),
    clientCredential: ownerCredential,
  });
  if (ownerEnrollment === null) throw new Error("owner enrollment fixture failed");
  const owner = authority.authenticate(`Bearer ${ownerCredential}`);
  if (owner === null) throw new Error("owner authentication fixture failed");
  const ownerStore = runtime.forPrincipal(owner);
  const created = ownerStore.createCube({
    retryKey: randomUUID(),
    name: "Shared Cube",
    workingRepoName: "owner",
    repository: { kind: "origin", value: "https://github.com/example/shared" },
    template: "default",
  });
  const spki = createHash("sha256")
    .update(new X509Certificate(ca.cert).publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const invitation = authority.createInvitationArtifactForOwnerCredential(
    ownerCredential,
    60_000,
    server.origin,
    spki,
    "second-machine",
  );
  if (invitation === null) throw new Error("client invitation fixture failed");

  const first = await runPty(clientBin, ["assimilate", "--enroll"], `${invitation}\n`, repoFirst, home);
  if (!first.output.includes("Ordinary client enrolled")) {
    throw new Error("first real client enrollment did not reach the ordinary-client result");
  }
  const identityStatePath = join(home, ".config", "borgmcp", "repository-identities.json");
  let savedAssociationsBeforeSecond = 0;
  try {
    const state = JSON.parse(await readFile(identityStatePath, "utf8"));
    if (
      state === null || typeof state !== "object" || Array.isArray(state) ||
      state.version !== 1 ||
      state.localIdentities === null || typeof state.localIdentities !== "object" ||
      Array.isArray(state.localIdentities) ||
      state.associations === null || typeof state.associations !== "object" ||
      Array.isArray(state.associations)
    ) {
      throw new Error("repository identity state has an unexpected shape");
    }
    savedAssociationsBeforeSecond = Object.keys(state.associations ?? {}).length;
  } catch (error) {
    if (error?.code === "ENOENT") {
      savedAssociationsBeforeSecond = 0;
    } else if (error instanceof Error && error.message === "repository identity state has an unexpected shape") {
      throw error;
    } else {
      throw new Error("repository identity state could not be read or decoded", { cause: error });
    }
  }
  if (savedAssociationsBeforeSecond !== 0) {
    throw new Error("saved repository association existed before the second invocation");
  }

  database = new DatabaseSync(databasePath);
  const clientRow = database.prepare(
    "SELECT id FROM clients WHERE id <> ? ORDER BY created_at DESC LIMIT 1",
  ).get(owner.id);
  if (clientRow === undefined || typeof clientRow.id !== "string") {
    throw new Error("second client was not enrolled");
  }
  runtime.maintenance.grantClientCube({
    clientId: clientRow.id,
    cubeId: created.cubeId,
    access: "manage",
  });

  const second = await runPty(
    clientBin,
    ["assimilate", "--host", server.origin, "--cube-name", "Shared Cube", "--here", "--cli", "codex"],
    "\n\n",
    repoSecond,
    home,
  );
  const linkPromptReached = second.output.includes("Link this repository to that cube?");
  if (!linkPromptReached) throw new Error("second real client did not reach the link prompt");
  const secondOutputLower = second.output.toLowerCase();
  const conflictObserved = /already associated|another repository|cube conflict|access denied|does not have permission/u.test(
    secondOutputLower,
  );
  const counts = database.prepare(
    "SELECT (SELECT COUNT(*) FROM repository_associations) AS associations, " +
    "(SELECT COUNT(*) FROM drones WHERE client_id = ?) AS drones",
  ).get(clientRow.id);
  const associationCount = Number(counts.associations);
  const droneCount = Number(counts.drones);

  const invitationAbsentFromFullCaptures =
    !first.output.includes(invitation) && !second.output.includes(invitation);
  if (!invitationAbsentFromFullCaptures) {
    throw new Error("invitation appeared in the full captured PTY output");
  }

  if (expectGuardPresent) {
    if (!conflictObserved || associationCount !== 1 || droneCount !== 0) {
      throw new Error("guard-present control did not refuse before attach with count=1 and no drone");
    }
    console.log(JSON.stringify({
      mode: "guard-present-control",
      first_enrollment_reached: true,
      saved_associations_before_second: savedAssociationsBeforeSecond,
      link_prompt_reached: true,
      association_count: associationCount,
      second_client_drone_count: droneCount,
      attach_succeeded: false,
      invitation_absent_from_full_captures: true,
    }));
  } else {
    if (conflictObserved || associationCount !== 2 || droneCount !== 1) {
      throw new Error("widened operator path did not associate and attach the second client");
    }
    const realClientLog = await runRealClientLog(
      join(clientInstallation, "node_modules", "borgmcp"),
      repoSecond,
      home,
    );
    if (realClientLog.active !== true || realClientLog.posted !== true || realClientLog.read !== true) {
      throw new Error("published client appendLog/readLog acceptance failed");
    }
    console.log(JSON.stringify({
      mode: "widened-positive",
      first_enrollment_reached: true,
      saved_associations_before_second: savedAssociationsBeforeSecond,
      link_prompt_reached: true,
      association_count: associationCount,
      second_client_drone_count: droneCount,
      attach_succeeded: true,
      real_client_log: realClientLog,
      invitation_absent_from_full_captures: true,
    }));
  }
} finally {
  if (database !== undefined) database.close();
  if (server !== undefined) await server.close();
  if (runtime !== undefined) runtime.close();
  if (digester !== undefined) digester.destroy();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  if (clientInstallation !== undefined) {
    await rm(clientInstallation, { recursive: true, force: true });
  }
}
