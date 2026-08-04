import { isAbsolute, join } from "node:path";

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
  readonly install: readonly [string, ...string[]];
  readonly restart: readonly [string, ...string[]];
  readonly recoverLoaded: readonly [string, ...string[]];
  readonly stop: readonly [string, ...string[]];
  readonly status: readonly [string, ...string[]];
}

const serviceLabel = "ai.borgmcp.server" as const;

export function createManagedServiceDefinition(input: ManagedServiceInput): ManagedServiceDefinition {
  for (const path of [
    input.nodeExecutable,
    input.runtimeRoot,
    input.dataDirectory,
    input.definitionPath,
  ]) {
    if (!isAbsolute(path) || /[\r\n\0]/u.test(path)) {
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
        input.port,
        nodeWarningArgs,
      ),
      install: ["launchctl", "bootstrap", domain, input.definitionPath] as const,
      restart: ["launchctl", "kickstart", "-k", service] as const,
      recoverLoaded: ["launchctl", "kickstart", service] as const,
      stop: ["launchctl", "bootout", service] as const,
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
      input.port,
      nodeWarningArgs,
    ),
    install: ["systemctl", "--user", "enable", "--now", label] as const,
    restart: ["systemctl", "--user", "restart", label] as const,
    recoverLoaded: ["systemctl", "--user", "restart", label] as const,
    stop: ["systemctl", "--user", "stop", label] as const,
    status: [
      "systemctl",
      "--user",
      "show",
      label,
      "--property=LoadState,ActiveState,SubState,MainPID",
    ] as const,
  });
}

function launchdDefinition(
  label: string,
  nodeExecutable: string,
  entrypoint: string,
  dataDirectory: string,
  port: number | undefined,
  nodeWarningArgs: readonly string[],
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>${xml(nodeExecutable)}</string>${nodeWarningArgs.map((arg) => `<string>${xml(arg)}</string>`).join("")}<string>${xml(entrypoint)}</string><string>start</string>${port === undefined ? "" : `<string>--port</string><string>${port}</string>`}</array>
  <key>EnvironmentVariables</key><dict><key>BORG_SERVER_DATA_DIR</key><string>${xml(dataDirectory)}</string><key>BORG_SERVER_PROCESS_MODE</key><string>managed</string></dict>
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
  port: number | undefined,
  nodeWarningArgs: readonly string[],
): string {
  return `[Unit]
Description=Borg MCP server (${label})

[Service]
Type=simple
ExecStart=${systemdQuote(nodeExecutable)}${nodeWarningArgs.map((arg) => ` ${systemdQuote(arg)}`).join("")} ${systemdQuote(entrypoint)} start${port === undefined ? "" : ` --port ${port}`}
Environment=${systemdQuote(`BORG_SERVER_DATA_DIR=${dataDirectory}`)}
Environment="BORG_SERVER_PROCESS_MODE=managed"
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
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
