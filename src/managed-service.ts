import { isAbsolute, join } from "node:path";

export type ManagedServicePlatform = "launchd" | "systemd";

export interface ManagedServiceInput {
  readonly platform: ManagedServicePlatform;
  readonly nodeExecutable: string;
  readonly runtimeRoot: string;
  readonly dataDirectory: string;
  readonly definitionPath: string;
  readonly launchdDomain?: string;
}

export interface ManagedServiceDefinition {
  readonly platform: ManagedServicePlatform;
  readonly label: "ai.borgmcp.server";
  readonly definitionPath: string;
  readonly content: string;
  readonly install: readonly [string, ...string[]];
  readonly restart: readonly [string, ...string[]];
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
  const entrypoint = join(input.runtimeRoot, "current", "package", "dist", "main.js");
  if (input.platform === "launchd") {
    const domain = input.launchdDomain;
    if (domain === undefined || !/^gui\/[1-9][0-9]*$/u.test(domain)) {
      throw new Error("Managed launchd domain is invalid.");
    }
    const service = `${domain}/${serviceLabel}`;
    return Object.freeze({
      platform: "launchd",
      label: serviceLabel,
      definitionPath: input.definitionPath,
      content: launchdDefinition(input.nodeExecutable, entrypoint, input.dataDirectory),
      install: ["launchctl", "bootstrap", domain, input.definitionPath] as const,
      restart: ["launchctl", "kickstart", "-k", service] as const,
      stop: ["launchctl", "bootout", service] as const,
      status: ["launchctl", "print", service] as const,
    });
  }
  return Object.freeze({
    platform: "systemd",
    label: serviceLabel,
    definitionPath: input.definitionPath,
    content: systemdDefinition(input.nodeExecutable, entrypoint, input.dataDirectory),
    install: ["systemctl", "--user", "enable", "--now", serviceLabel] as const,
    restart: ["systemctl", "--user", "restart", serviceLabel] as const,
    stop: ["systemctl", "--user", "stop", serviceLabel] as const,
    status: ["systemctl", "--user", "show", serviceLabel, "--property=ActiveState,SubState,MainPID"] as const,
  });
}

function launchdDefinition(nodeExecutable: string, entrypoint: string, dataDirectory: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${serviceLabel}</string>
  <key>ProgramArguments</key><array><string>${xml(nodeExecutable)}</string><string>${xml(entrypoint)}</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>BORG_SERVER_DATA_DIR</key><string>${xml(dataDirectory)}</string><key>BORG_SERVER_PROCESS_MODE</key><string>managed</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}

function systemdDefinition(nodeExecutable: string, entrypoint: string, dataDirectory: string): string {
  return `[Unit]
Description=Borg MCP server

[Service]
Type=simple
ExecStart=${systemdQuote(nodeExecutable)} ${systemdQuote(entrypoint)} start
Environment=${systemdQuote(`BORG_SERVER_DATA_DIR=${dataDirectory}`)}
Environment="BORG_SERVER_PROCESS_MODE=managed"
Restart=on-failure
RestartSec=2
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
