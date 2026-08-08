import type { ServerService } from "./service.js";
import { sanitizeTerminalText } from "./dashboard.js";
import { RuntimeUpdateFailure } from "./runtime-operator.js";
import { SERVER_PACKAGE_VERSION } from "./runtime-identity.js";

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
  readonly readSecret?: (prompt: string) => Promise<string>;
  readonly isTTY?: boolean;
}

const usage = `Usage: borg-mcp-server <command> [options]

Commands:
  setup [--reinitialize]  Prepare an offline server installation
  cert-reissue --host <ip>  Add a private-LAN address to the server certificate
  start    Start the server process
  dashboard [--ascii]  View the running local server without stopping it
  status [--json]  Report exact local runtime evidence
  version [--json]  Report the installed controller version
  update [--json]  Verify the latest runtime and report any controller step
  stop [--json]  Stop the managed local server
  recover-stale-lock [--json]  Preserve a safely identified stale runtime lock
  invite [<client-name>]  Create a named client enrollment invitation interactively.
           An enrolled client has no cube access until it is granted.
  client-rotate <client-id>  Rotate one client credential while the server is live
  client-list  List clients, ID-derived handles, states, and cube grants while the server is live
  client-revoke <client-name-or-handle>  Revoke one client and its credentials while the server is live
  client-grant <client-name-or-handle> <cube-id> <read|write|manage>  Set one cube grant while the server is live
  client-ungrant <client-name-or-handle> <cube-id>  Remove one cube grant while the server is live
  help     Show this help

Start options:
  --host <ip>      Explicit bind address (default: 127.0.0.1)
  --port <number>  Listen port (default: 7091)
  --lan            Consent to this start on a private LAN address
  --ascii          Use strict 7-bit dashboard glyphs
  --log-level debug  Emit centrally redacted structured diagnostics to stderr

Dashboard options:
  --ascii          Use strict 7-bit dashboard glyphs

Setup options:
  --reinitialize   Recreate the database and leaf identity; preserve the CA when present

TLS files:
  BORG_SERVER_DATA_DIR (default: ~/.borg/server), or explicit
  BORG_SERVER_TLS_KEY_FILE, BORG_SERVER_TLS_CERT_FILE, and BORG_SERVER_TLS_CA_FILE

Invitation minting is an additive local operation and may run while the server is
live. Client listing, rotation, revocation, and grant changes are operator-only
live-safe operations; the running server observes committed changes on the next
request.

Stop the server before setup or reinitialization.

Invitation access:
  read    observe: discover, attach as observer, and read
  write   coordinate: attach, read, post, acknowledge, and receive directed wakes (default)
  manage  administer: coordinate plus cube administration; explicit only`;

export async function runCli(
  args: readonly string[],
  service: ServerService,
  io: CliIo,
): Promise<number> {
  const [command, ...extraArgs] = args;

  switch (command) {
    case "--version":
    case "version": {
      if (command === "--version" ? extraArgs.length !== 0 :
          extraArgs.length > 1 || (extraArgs.length === 1 && extraArgs[0] !== "--json")) {
        return invalidArguments(io);
      }
      if (extraArgs[0] === "--json" || io.isTTY === false) {
        io.stdout(JSON.stringify({ controller: `borgmcp-server@${SERVER_PACKAGE_VERSION}` }));
      } else {
        io.stdout(`borgmcp-server@${SERVER_PACKAGE_VERSION}`);
      }
      return 0;
    }
    case "setup":
      if (extraArgs.length > 1 || (extraArgs.length === 1 && extraArgs[0] !== "--reinitialize")) {
        return invalidArguments(io);
      }
      if (service.setup === undefined) {
        io.stderr("Server setup is unavailable.");
        return 1;
      }
      const result = await service.setup({ reinitialize: extraArgs[0] === "--reinitialize" });
      const artifactIdentity = result.artifact === undefined
        ? "borgmcp-server@unavailable"
        : `borgmcp-server@${result.artifact.version}`;
      const clientOnboarding = process.env["BORG_CLIENT_ONBOARDING"] === "1";
      if (io.isTTY === false) {
        io.stdout(JSON.stringify({
          status: "prepared",
          artifact: artifactIdentity,
          build_identity: result.artifact?.sourceSha ?? null,
          bind_host: result.bindHost,
          owner_access: "prepared",
          process: "stopped",
        }));
        return 0;
      }
      if ("existing" in result) {
        const lines = [
          "Your local server is already prepared.",
          "Your server data and identity are unchanged.",
          `Prepared bind address: ${result.bindHost}`,
          "This address is written into the server certificate.",
          "Setup did not start the server.",
        ];
        if (!clientOnboarding) {
          lines.push(
            "Next, run:",
            "  borg server start",
            "Leave that terminal open while the server is running.",
          );
        }
        io.stdout(lines.join("\n"));
        return 0;
      }
      const lines = [
        "Local server setup completed.",
        "Your server data and identity are ready.",
        `Prepared bind address: ${result.bindHost}`,
        "This address is written into the server certificate.",
      ];
      if (!clientOnboarding) {
        lines.push(
          "Next, run:",
          "  borg server start",
          "Leave that terminal open while the server is running.",
          "After installing the borg client, open a second terminal in your Git repository and run:",
          "  borg assimilate",
        );
      }
      io.stdout(lines.join("\n"));
      return 0;
    case "cert-reissue": {
      if (extraArgs.length !== 2 || extraArgs[0] !== "--host" ||
          extraArgs[1] === undefined || service.reissueCertificate === undefined) {
        return invalidArguments(io);
      }
      const result = await service.reissueCertificate(extraArgs[1]);
      io.stdout(
        `Server certificate reissued for ${result.hosts.join(", ")}.\n` +
        `Next: restart the server with \`borg server start --host ${extraArgs[1]} --lan\`.`,
      );
      return 0;
    }
    case "start":
      await service.start(extraArgs);
      return 0;
    case "dashboard": {
      if (service.dashboard === undefined || extraArgs.length > 1 ||
          (extraArgs.length === 1 && extraArgs[0] !== "--ascii")) {
        return invalidArguments(io);
      }
      await service.dashboard({ ascii: extraArgs[0] === "--ascii" });
      return 0;
    }
    case "status": {
      if (extraArgs.length > 1 || (extraArgs.length === 1 && extraArgs[0] !== "--json") ||
          service.status === undefined) return invalidArguments(io);
      const status = await service.status();
      const runtimeLock = status.runtimeLock ?? { state: "clear" as const };
      const serviceState = status.serviceState ??
        (status.serviceAdapter === null ? "absent" as const : "active" as const);
      if (extraArgs[0] === "--json" || io.isTTY === false) {
        io.stdout(JSON.stringify({
          status: status.status,
          installed_controller: `borgmcp-server@${status.controllerVersion}`,
          prepared_runtime: status.preparedArtifact === null
            ? null
            : `borgmcp-server@${status.preparedArtifact.version}`,
          prepared_integrity: status.preparedArtifact?.integrity ?? null,
          running_runtime: status.runningArtifact === null
            ? null
            : `borgmcp-server@${status.runningArtifact.version}`,
          running_integrity: status.runningArtifact?.integrity ?? null,
          build_identity: status.buildIdentity,
          endpoint: status.endpoint,
          mode: status.mode,
          service_adapter: status.serviceAdapter,
          service_state: serviceState,
          service_recovery: renderServiceRecovery(
            status.serviceRecoveryCommand ?? null,
            false,
          ),
          runtime_lock: renderRuntimeLockDiagnostic(runtimeLock),
          data_identity: status.dataIdentity,
          next_action: renderNextAction(status.nextAction),
        }));
      } else {
        io.stdout(renderRuntimeStatus(status));
      }
      return runtimeLock.state === "stale" ? 1 : 0;
    }
    case "stop": {
      if (extraArgs.length > 1 || (extraArgs.length === 1 && extraArgs[0] !== "--json") ||
          service.stop === undefined) return invalidArguments(io);
      const result = await service.stop();
      const machine = extraArgs[0] === "--json" || io.isTTY === false;
      if (machine) {
        io.stdout(JSON.stringify({ status: result.outcome, data_identity: "preserved" }));
      } else if (result.outcome === "stopped") {
        io.stdout("Managed local server stopped.\nData and identity: preserved\nNext: borg-mcp-server start");
      } else if (result.outcome === "already-stopped") {
        io.stdout("Local server is already stopped.\nData and identity: preserved\nNext: borg-mcp-server start");
      } else {
        io.stdout("The local server is running in the foreground.\nStop it with Ctrl-C in its owning terminal.");
      }
      return result.outcome === "foreground-action-required" ? 1 : 0;
    }
    case "update": {
      if (extraArgs.length > 1 || (extraArgs.length === 1 && extraArgs[0] !== "--json") ||
          service.update === undefined) return invalidArguments(io);
      let result: Awaited<ReturnType<NonNullable<ServerService["update"]>>>;
      try {
        result = await service.update();
      } catch (error) {
        if (!(error instanceof RuntimeUpdateFailure)) throw error;
        renderUpdateFailure(error, io, extraArgs[0] === "--json" || io.isTTY === false);
        return 1;
      }
      if (extraArgs[0] === "--json" || io.isTTY === false) {
        io.stdout(JSON.stringify({
          status: result.outcome,
          installed_controller: `borgmcp-server@${result.controllerVersion}`,
          artifact: `borgmcp-server@${result.artifact.version}`,
          artifact_integrity: result.artifact.integrity,
          running_runtime: result.runningIdentity === null
            ? null
            : `borgmcp-server@${result.runningIdentity.package_version}`,
          build_identity: result.runningIdentity?.source_sha ?? result.artifact.sourceSha,
          mode: result.outcome === "updated" ? "managed" : "stopped",
          service_adapter: result.serviceAdapter ?? null,
          service_state: result.serviceState ??
            (result.serviceAdapter === null || result.serviceAdapter === undefined ? "absent" : "active"),
          service_recovery: renderServiceRecovery(
            result.serviceRecoveryCommand ?? null,
            false,
          ),
          data_identity: result.dataIdentity,
          next_action: renderNextAction(result.nextAction),
        }));
      } else if (result.outcome === "updated") {
        io.stdout([
          `Verifying borgmcp-server@${result.artifact.version}...`,
          "Artifact verified and activated.",
          "Restarting the verified local server...",
          `Local server is running.`,
          `Artifact: borgmcp-server@${result.artifact.version} (${result.artifact.integrity})`,
          `Build identity: ${result.runningIdentity?.source_sha ?? "unavailable"}`,
          ...renderControllerCompletion(result.controllerVersion, result.artifact.version),
          ...renderManagedServiceCompletion(result),
          "Data and identity: preserved",
          `Next: ${renderNextAction(result.nextAction) ?? "borg-mcp-server status"}`,
        ].join("\n"));
      } else {
        io.stdout([
          `Verifying borgmcp-server@${result.artifact.version}...`,
          "Artifact verified and activated.",
          "No server process started.",
          `Artifact: borgmcp-server@${result.artifact.version} (${result.artifact.integrity})`,
          `Build identity: ${result.artifact.sourceSha ?? "unavailable"}`,
          ...renderControllerCompletion(result.controllerVersion, result.artifact.version),
          ...renderManagedServiceCompletion(result),
          "Data and identity: preserved",
          `Next: ${renderNextAction(result.nextAction) ?? "borg-mcp-server start"}`,
        ].join("\n"));
      }
      return 0;
    }
    case "recover-stale-lock": {
      if (extraArgs.length > 1 || (extraArgs.length === 1 && extraArgs[0] !== "--json") ||
          service.recoverStaleLock === undefined) return invalidArguments(io);
      const result = await service.recoverStaleLock();
      if (extraArgs[0] === "--json" || io.isTTY === false) {
        io.stdout(JSON.stringify({
          status: "recovered",
          previous_pid: result.stale.pid,
          process_state: "absent",
          preserved_lock: result.backupPath,
          process: "stopped",
          next_action: "borg-mcp-server status",
        }));
      } else {
        io.stdout([
          "Stale runtime lock preserved.",
          `Recorded PID: ${result.stale.pid} (absent)`,
          `Preserved lock: ${result.backupPath}`,
          "No server process started.",
          "Next: borg-mcp-server status",
        ].join("\n"));
      }
      return 0;
    }
    case "client-rotate":
      if (extraArgs.length !== 1 || service.rotateClient === undefined) return invalidArguments(io);
      io.stdout(`Client credential rotated (shown once): ${await service.rotateClient(extraArgs[0]!)}`);
      return 0;
    case "client-list":
      if (extraArgs.length !== 0 || service.listClients === undefined) return invalidArguments(io);
      io.stdout(renderClientList(await service.listClients()));
      return 0;
    case "client-revoke":
      if (extraArgs.length !== 1 || service.revokeClient === undefined) return invalidArguments(io);
      await service.revokeClient(extraArgs[0]!);
      io.stdout("Client revoked.");
      return 0;
    case "client-grant": {
      if (extraArgs.length !== 3 || service.grantClient === undefined) return invalidArguments(io);
      const access = extraArgs[2];
      if (access !== "read" && access !== "write" && access !== "manage") return invalidArguments(io);
      await service.grantClient(extraArgs[0]!, extraArgs[1]!, access);
      io.stdout("Client cube grant updated.");
      return 0;
    }
    case "client-ungrant":
      if (extraArgs.length !== 2 || service.ungrantClient === undefined) return invalidArguments(io);
      await service.ungrantClient(extraArgs[0]!, extraArgs[1]!);
      io.stdout("Client cube grant removed.");
      return 0;
    case "client-invite":
    case "owner-invite": {
      if (!recoveryCredentialIsOperatorAvailable()) {
        io.stderr(command === "client-invite"
          ? "client-invite is not supported. Creating a scoped invitation requires a recovery credential, and this server does not issue one.\n" +
            "To enroll an additional client or device, run `borg server invite` in an interactive terminal. An enrolled client has no cube access until the server operator grants it."
          : "owner-invite is not supported. Replacing an owner enrollment invitation requires a recovery credential, and this server does not issue one.\n" +
            "To enroll an additional client or device, run `borg server invite` in an interactive terminal.");
        return 1;
      }

      if (io.readSecret === undefined) return invalidArguments(io);
      if (extraArgs.length !== 0) return invalidArguments(io);
      const operation = command === "client-invite"
        ? service.createClientInvitation
        : service.replaceOwnerInvitation;
      if (operation === undefined) return invalidArguments(io);
      const recovery = await io.readSecret("Recovery credential (hidden input): ");
      const result = await operation(recovery);
      io.stdout(command === "client-invite"
        ? `Client enrollment invitation (single-use, shown once): ${result}`
        : `Owner enrollment invitation (single-use, shown once): ${result}`);
      return 0;
    }
    case "invite": {
      if (extraArgs.length > 1 || service.invite === undefined) return invalidArguments(io);
      if (io.isTTY !== true) {
        io.stderr("Invitation creation requires an interactive terminal.");
        return 1;
      }
      const result = await service.invite(extraArgs[0]);
      io.stdout(
        `Client enrollment invitation (single-use, shown once): ${result.invitation}\n` +
        "Share it only with the intended recipient." +
        (result.loopbackOnly
          ? "\nThis invitation works only on this machine. For another machine, run cert-reissue, restart, then mint again."
          : ""),
      );
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      io.stdout(usage);
      return 0;
    default:
      io.stderr("Unknown command.");
      return 1;
  }
}

function recoveryCredentialIsOperatorAvailable(): boolean {
  return false;
}

function renderUpdateFailure(failure: RuntimeUpdateFailure, io: CliIo, machine: boolean): void {
  const state = failure.code === "ARTIFACT_VERIFICATION_FAILED"
    ? "verification_failed"
    : failure.recovery === "restored"
      ? "restored"
      : failure.recovery === "stopped"
        ? "stopped"
        : "recovery_failed";
  if (machine) {
    io.stdout(JSON.stringify({
      status: "failed",
      error_code: failure.code,
      recovery: state,
      data_identity: "preserved",
    }));
    return;
  }
  if (failure.code === "ARTIFACT_VERIFICATION_FAILED") {
    io.stderr([
      "Update stopped: artifact verification failed.",
      "No activation occurred.",
      "The last verified runtime remains available.",
      "Next: borg-mcp-server status",
    ].join("\n"));
    return;
  }
  io.stderr([
    "Update stopped: activation did not complete.",
    failure.recovery === "restored"
      ? "The last verified runtime was restored."
      : failure.recovery === "stopped"
        ? "The server stopped safely."
        : "Recovery did not complete; inspect server status.",
    "Data and identity: preserved",
    "Next: borg-mcp-server status",
  ].join("\n"));
}

function renderRuntimeStatus(status: Awaited<ReturnType<NonNullable<ServerService["status"]>>>): string {
  const runtimeLock = status.runtimeLock ?? { state: "clear" as const };
  const serviceState = status.serviceState ??
    (status.serviceAdapter === null ? "absent" as const : "active" as const);
  const heading = runtimeLock.state === "stale"
    ? "Local server is stopped with a stale runtime lock."
    : status.status === "running"
    ? status.buildIdentity === null
      ? "Local server is reachable, but its running build identity is unavailable."
      : "Local server is running."
    : "Local server is stopped.";
  const lines = [
    heading,
    `Installed controller: borgmcp-server@${status.controllerVersion}`,
    status.preparedArtifact === null
      ? "Prepared runtime: unavailable"
      : `Prepared runtime: borgmcp-server@${status.preparedArtifact.version} (${status.preparedArtifact.integrity})`,
    status.runningArtifact === null
      ? "Running runtime: unavailable"
      : `Running runtime: borgmcp-server@${status.runningArtifact.version} (${status.runningArtifact.integrity ?? "unavailable"})`,
    `Build identity: ${status.buildIdentity ?? "unavailable"}`,
    `Endpoint: ${status.endpoint ?? "unavailable"}`,
    `Mode: ${status.mode === "managed" && status.serviceAdapter !== null
      ? `managed (${status.serviceAdapter})`
      : status.mode}`,
    `Managed service: ${serviceState}${status.serviceAdapter === null
      ? ""
      : ` (${status.serviceAdapter})`}`,
    `Data and identity: ${status.dataIdentity}`,
  ];
  if (runtimeLock.state === "stale") {
    lines.push(
      `Stale lock PID: ${runtimeLock.pid} (absent)`,
      `Stale lock mode: ${runtimeLock.mode}`,
      `Recovery: ${runtimeLock.recoveryAction}`,
    );
  }
  const serviceRecovery = renderServiceRecovery(status.serviceRecoveryCommand ?? null, true);
  if (serviceRecovery !== null) lines.push(`Service recovery: ${serviceRecovery}`);
  const nextAction = renderNextAction(status.nextAction);
  if (nextAction !== null) lines.push(`Next: ${nextAction}.`);
  return lines.join("\n");
}

function renderRuntimeLockDiagnostic(
  diagnostic: Awaited<ReturnType<NonNullable<ServerService["status"]>>>["runtimeLock"],
): Readonly<Record<string, unknown>> {
  if (diagnostic.state === "clear") return Object.freeze({ state: "clear" });
  return Object.freeze({
    state: "stale",
    pid: diagnostic.pid,
    process_state: diagnostic.processState,
    runtime: `borgmcp-server@${diagnostic.identity.package_version}`,
    runtime_integrity: diagnostic.identity.artifact_integrity,
    build_identity: diagnostic.identity.source_sha,
    endpoint: diagnostic.endpoint,
    mode: diagnostic.mode,
    recovery_action: diagnostic.recoveryAction,
  });
}

function renderServiceRecovery(
  command: readonly [string, ...string[]] | null,
  tty: boolean,
): string | Readonly<{ kind: "run-platform-command"; command: readonly string[] }> | null {
  if (command === null) return null;
  if (tty) return renderShellCommand(command);
  return Object.freeze({ kind: "run-platform-command", command });
}

function renderShellCommand(command: readonly [string, ...string[]]): string {
  return command.map((argument) => /^[A-Za-z0-9_./:@+-]+$/u.test(argument)
    ? argument
    : `'${argument.replaceAll("'", "'\"'\"'")}'`).join(" ");
}

function renderControllerCompletion(
  controllerVersion: string,
  runtimeVersion: string,
): readonly string[] {
  return controllerVersion === runtimeVersion
    ? []
    : [`Installed controller remains: borgmcp-server@${controllerVersion}`];
}

function renderManagedServiceCompletion(
  result: Awaited<ReturnType<NonNullable<ServerService["update"]>>>,
): readonly string[] {
  const adapter = result.serviceAdapter ?? null;
  const state = result.serviceState ??
    (adapter === null ? "absent" as const : "active" as const);
  const lines = [
    `Managed service: ${state}${adapter === null ? "" : ` (${adapter})`}`,
  ];
  const recovery = renderServiceRecovery(result.serviceRecoveryCommand ?? null, true);
  if (recovery !== null) lines.push(`Service recovery: ${recovery}`);
  return lines;
}

function renderNextAction(
  action: Awaited<ReturnType<NonNullable<ServerService["status"]>>>["nextAction"],
): string | null {
  if (action === null) return null;
  return action.kind === "update-runtime"
    ? "borg-mcp-server update"
    : `npm install --global borgmcp-server@${action.version}`;
}

function renderClientList(
  clients: Awaited<ReturnType<NonNullable<ServerService["listClients"]>>>,
): string {
  if (clients.length === 0) return "No clients.";
  return clients.flatMap((client) => [
    `${sanitizeTerminalText(client.name)} [${client.handle}] ${client.state}`,
    ...(client.grants.length === 0
      ? ["  No cube grants."]
      : client.grants.map((grant) =>
        `  ${grant.access}  ${sanitizeTerminalText(grant.cubeName)} (${grant.cubeId})`)),
  ]).join("\n");
}

function invalidArguments(io: CliIo): 1 {
  io.stderr("Invalid command arguments.");
  return 1;
}
