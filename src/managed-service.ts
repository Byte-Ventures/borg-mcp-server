import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { managedServiceControllerMismatch, operatorErrors } from "./operator-error.js";

export type ManagedServicePlatform = "launchd" | "systemd";

export interface ManagedServiceInput {
  readonly platform: ManagedServicePlatform;
  readonly nodeExecutable: string;
  readonly nodeVersion?: string;
  readonly runtimeRoot: string;
  readonly dataDirectory: string;
  readonly definitionPath: string;
  readonly launchdDomain?: string;
  readonly label?: string;
  readonly port?: number;
}

export interface ManagedServiceDefinition {
  readonly platform: ManagedServicePlatform;
  readonly label: string;
  readonly definitionPath: string;
  readonly content: string;
  readonly ownershipMarker: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly install: readonly [string, ...string[]];
  readonly restart: readonly [string, ...string[]];
  readonly recoverLoaded: readonly [string, ...string[]];
  readonly unload: readonly [string, ...string[]];
  readonly rollbackRemove: readonly [string, ...string[]];
  readonly reload: readonly [string, ...string[]] | null;
  readonly status: readonly [string, ...string[]];
}

export interface ManagedServiceCommandRunner {
  (
    command: readonly [string, ...string[]],
    signal: AbortSignal,
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

const serviceLabel = "ai.borgmcp.server" as const;

export function createManagedServiceDefinition(input: ManagedServiceInput): ManagedServiceDefinition {
  for (const path of [
    input.nodeExecutable,
    input.runtimeRoot,
    input.dataDirectory,
    input.definitionPath,
  ]) {
    if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) {
      throw new Error("Managed service paths must be absolute and single-line.");
    }
  }
  const label = input.label ?? serviceLabel;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/u.test(label)) {
    throw new Error("Managed service label is invalid.");
  }
  if (input.port !== undefined &&
      (!Number.isSafeInteger(input.port) || input.port < 0 || input.port > 65_535)) {
    throw new Error("Managed service port is invalid.");
  }
  const entrypoint = join(input.runtimeRoot, "current", "package", "dist", "main.js");
  const stdoutPath = join(input.dataDirectory, "logs", "managed.stdout.log");
  const stderrPath = join(input.dataDirectory, "logs", "managed.stderr.log");
  const ownershipMarker = `borgmcp-server-owned:${label}`;
  const nodeWarningArgs = node22WarningArgs(input.nodeVersion);
  if (input.platform === "launchd") {
    const domain = input.launchdDomain;
    if (domain === undefined || !/^gui\/[1-9][0-9]*$/u.test(domain)) {
      throw new Error("Managed launchd domain is invalid.");
    }
    const service = `${domain}/${label}`;
    return Object.freeze({
      platform: "launchd",
      label,
      definitionPath: input.definitionPath,
      content: launchdDefinition(
        label,
        input.nodeExecutable,
        entrypoint,
        input.dataDirectory,
        stdoutPath,
        stderrPath,
        input.port,
        nodeWarningArgs,
        ownershipMarker,
      ),
      ownershipMarker,
      stdoutPath,
      stderrPath,
      install: ["launchctl", "bootstrap", domain, input.definitionPath] as const,
      restart: ["launchctl", "kickstart", "-k", service] as const,
      recoverLoaded: ["launchctl", "kickstart", service] as const,
      unload: ["launchctl", "bootout", service] as const,
      rollbackRemove: ["launchctl", "bootout", service] as const,
      reload: null,
      status: ["launchctl", "print", service] as const,
    });
  }
  return Object.freeze({
    platform: "systemd",
    label,
    definitionPath: input.definitionPath,
    content: systemdDefinition(
      label,
      input.nodeExecutable,
      entrypoint,
      input.dataDirectory,
      stdoutPath,
      stderrPath,
      input.port,
      nodeWarningArgs,
      ownershipMarker,
    ),
    ownershipMarker,
    stdoutPath,
    stderrPath,
    install: ["systemctl", "--user", "enable", "--now", label] as const,
    restart: ["systemctl", "--user", "restart", label] as const,
    recoverLoaded: ["systemctl", "--user", "restart", label] as const,
    unload: ["systemctl", "--user", "stop", label] as const,
    rollbackRemove: ["systemctl", "--user", "disable", "--now", label] as const,
    reload: ["systemctl", "--user", "daemon-reload"] as const,
    status: [
      "systemctl",
      "--user",
      "show",
      label,
      "--property=LoadState,ActiveState,SubState,MainPID,FragmentPath",
    ] as const,
  });
}

export function createBoundManagedServiceRunner(
  definition: ManagedServiceDefinition,
  run: ManagedServiceCommandRunner,
): ManagedServiceCommandRunner {
  let guardedRemovalCompleted = false;
  return async (command, signal) => {
    if (!commandsEqual(command, definition.status)) {
      const allowMissingDefinition = guardedRemovalCompleted && definition.reload !== null &&
        commandsEqual(command, definition.reload);
      guardedRemovalCompleted = false;
      await assertManagedServiceControllerBindingInternal(
        definition,
        run,
        signal,
        allowMissingDefinition,
      );
    }
    const result = await run(command, signal);
    guardedRemovalCompleted = commandsEqual(command, definition.rollbackRemove);
    return result;
  };
}

export async function assertManagedServiceControllerBinding(
  definition: ManagedServiceDefinition,
  run: ManagedServiceCommandRunner,
  signal: AbortSignal,
): Promise<void> {
  await assertManagedServiceControllerBindingInternal(definition, run, signal, false);
}

async function assertManagedServiceControllerBindingInternal(
  definition: ManagedServiceDefinition,
  run: ManagedServiceCommandRunner,
  signal: AbortSignal,
  allowMissingDefinition: boolean,
): Promise<void> {
  let loadedPath: string | null;
  try {
    const result = await run(definition.status, signal);
    loadedPath = controllerDefinitionPath(definition, result.stdout);
  } catch (error) {
    if (definition.platform === "launchd" &&
        typeof error === "object" && error !== null &&
        (error as { readonly code?: unknown }).code === 113) {
      loadedPath = null;
    } else {
      throw error;
    }
  }
  if (loadedPath !== null && loadedPath !== definition.definitionPath) {
    throw managedServiceControllerMismatch(definition.definitionPath, loadedPath);
  }
  const definitionExists = await assertSecureManagedServiceDefinition(
    definition.definitionPath,
  );
  if (loadedPath !== null && !definitionExists && !allowMissingDefinition) {
    throw operatorErrors.MANAGED_SERVICE_DEFINITION_UNSAFE;
  }
}

async function assertSecureManagedServiceDefinition(path: string): Promise<boolean> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const uid = process.getuid?.();
  if (path !== resolve(path) || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.size > 64 * 1024 || (uid !== undefined && before.uid !== uid) ||
      (before.mode & 0o077) !== 0) {
    throw operatorErrors.MANAGED_SERVICE_DEFINITION_UNSAFE;
  }
  try {
    if (await realpath(dirname(path)) !== dirname(path) || await realpath(path) !== path) {
      throw operatorErrors.MANAGED_SERVICE_DEFINITION_UNSAFE;
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
          opened.nlink !== 1 || opened.size > 64 * 1024 ||
          (uid !== undefined && opened.uid !== uid) || (opened.mode & 0o077) !== 0) {
        throw operatorErrors.MANAGED_SERVICE_DEFINITION_UNSAFE;
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error === operatorErrors.MANAGED_SERVICE_DEFINITION_UNSAFE) throw error;
    throw operatorErrors.MANAGED_SERVICE_DEFINITION_UNSAFE;
  }
  return true;
}

function controllerDefinitionPath(
  definition: ManagedServiceDefinition,
  output: string,
): string | null {
  if (definition.platform === "launchd") {
    const path = /(?:^|\n)\s*path = (.*)(?:\n|$)/u.exec(output)?.[1];
    if (path === undefined || !validControllerPath(path)) {
      throw operatorErrors.MANAGED_SERVICE_CONTROLLER_FOREIGN;
    }
    return path;
  }
  const loadState = /(?:^|\n)LoadState=([^\n]*)(?:\n|$)/u.exec(output)?.[1];
  if (loadState === "not-found") return null;
  const path = /(?:^|\n)FragmentPath=([^\n]*)(?:\n|$)/u.exec(output)?.[1];
  if (loadState === undefined || path === undefined || !validControllerPath(path)) {
    throw operatorErrors.MANAGED_SERVICE_CONTROLLER_FOREIGN;
  }
  return path;
}

function validControllerPath(path: string): boolean {
  return path.length > 0 && path.length <= 4_096 && isAbsolute(path) &&
    !/[\u0000-\u001f\u007f]/u.test(path);
}

function commandsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function launchdDefinition(
  label: string,
  nodeExecutable: string,
  entrypoint: string,
  dataDirectory: string,
  stdoutPath: string,
  stderrPath: string,
  port: number | undefined,
  nodeWarningArgs: readonly string[],
  ownershipMarker: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${ownershipMarker} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>${xml(nodeExecutable)}</string>${nodeWarningArgs.map((arg) => `<string>${xml(arg)}</string>`).join("")}<string>${xml(entrypoint)}</string><string>start</string>${port === undefined ? "" : `<string>--port</string><string>${port}</string>`}</array>
  <key>EnvironmentVariables</key><dict><key>BORG_SERVER_DATA_DIR</key><string>${xml(dataDirectory)}</string><key>BORG_SERVER_PROCESS_MODE</key><string>managed</string></dict>
  <key>StandardOutPath</key><string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xml(stderrPath)}</string>
  <key>Umask</key><integer>63</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}

function systemdDefinition(
  label: string,
  nodeExecutable: string,
  entrypoint: string,
  dataDirectory: string,
  stdoutPath: string,
  stderrPath: string,
  port: number | undefined,
  nodeWarningArgs: readonly string[],
  ownershipMarker: string,
): string {
  return `# ${ownershipMarker}
[Unit]
Description=Borg MCP server (${label})

[Service]
Type=simple
ExecStart=${systemdQuote(nodeExecutable)}${nodeWarningArgs.map((arg) => ` ${systemdQuote(arg)}`).join("")} ${systemdQuote(entrypoint)} start${port === undefined ? "" : ` --port ${port}`}
Environment=${systemdQuote(`BORG_SERVER_DATA_DIR=${dataDirectory}`)}
Environment="BORG_SERVER_PROCESS_MODE=managed"
UMask=0077
StandardOutput=${systemdQuote(`append:${stdoutPath}`)}
StandardError=${systemdQuote(`append:${stderrPath}`)}
Restart=on-failure
RestartSec=2
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;
}

function node22WarningArgs(nodeVersion: string | undefined): readonly string[] {
  const major = (nodeVersion ?? process.versions.node).split(".")[0];
  return major === "22" ? ["--disable-warning=ExperimentalWarning"] : [];
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
