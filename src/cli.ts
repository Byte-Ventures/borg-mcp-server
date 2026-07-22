import type { ServerService } from "./service.js";
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
  start    Start the server process
  status [--json]  Report exact local runtime evidence
  version [--json]  Report the installed controller version
  update [--json]  Verify and activate the latest server artifact
  stop [--json]  Stop the managed local server
  invite   Create a single-use invitation in an interactive terminal.
  client-rotate <client-id>  Rotate one client credential offline
  client-revoke <client-id>  Revoke one client and its credentials offline
  client-grant <client-id> <cube-id> <read|write|manage>  Set one offline cube grant
  client-ungrant <client-id> <cube-id>  Remove one offline cube grant
  client-invite [<cube-name-or-id>] [--access <read|write|manage>]
             Create a client invitation; scoped invitations default to write
  owner-invite   Replace the unclaimed owner enrollment invitation using a hidden recovery prompt
  help     Show this help

Start options:
  --host <ip>      Explicit bind address (default: 127.0.0.1)
  --port <number>  Listen port (default: 7091)
  --lan            Consent to this start on a private LAN address
  --log-level debug  Emit centrally redacted structured diagnostics to stderr

Setup options:
  --reinitialize   Destroy and recreate the existing server identity and database

TLS files:
  BORG_SERVER_DATA_DIR (default: ~/.borg/server), or explicit
  BORG_SERVER_TLS_KEY_FILE, BORG_SERVER_TLS_CERT_FILE, and BORG_SERVER_TLS_CA_FILE

Invitation commands may run alongside a live server. Stop the server before
setup, rotation, revocation, grant changes, or reinitialization.

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
      const artifact = result.artifact === undefined
        ? "Artifact: unavailable"
        : `Artifact: ${artifactIdentity} (${result.artifact.integrity})`;
      if (io.isTTY === false) {
        io.stdout(JSON.stringify({
          status: "prepared",
          artifact: artifactIdentity,
          build_identity: result.artifact?.sourceSha ?? null,
          owner_access: "prepared",
          process: "stopped",
        }));
        return 0;
      }
      if ("existing" in result) {
        io.stdout([
          "Local server is already prepared.",
          artifact,
          `Build identity: ${result.artifact?.sourceSha ?? "unavailable"}`,
          "Data and identity: unchanged",
          "No server process started.",
          "Next: borg-mcp-server start",
        ].join("\n"));
        return 0;
      }
      io.stdout([
        "Local server setup completed.",
        artifact,
        "Local owner access: prepared.",
        "No server process started.",
        "Next: start the server, then run borg assimilate.",
      ].join("\n"));
      return 0;
    case "start":
      await service.start(extraArgs);
      return 0;
    case "status": {
      if (extraArgs.length > 1 || (extraArgs.length === 1 && extraArgs[0] !== "--json") ||
          service.status === undefined) return invalidArguments(io);
      const status = await service.status();
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
          data_identity: status.dataIdentity,
          next_action: status.nextAction,
        }));
      } else {
        io.stdout(renderRuntimeStatus(status));
      }
      return 0;
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
          artifact: `borgmcp-server@${result.artifact.version}`,
          artifact_integrity: result.artifact.integrity,
          build_identity: result.runningIdentity?.source_sha ?? result.artifact.sourceSha,
          mode: result.outcome === "updated" ? "managed" : "stopped",
          data_identity: result.dataIdentity,
        }));
      } else if (result.outcome === "updated") {
        io.stdout([
          `Verifying borgmcp-server@${result.artifact.version}...`,
          "Artifact verified and activated.",
          "Restarting the verified local server...",
          `Local server is running.`,
          `Artifact: borgmcp-server@${result.artifact.version} (${result.artifact.integrity})`,
          `Build identity: ${result.runningIdentity?.source_sha ?? "unavailable"}`,
          "Data and identity: preserved",
          "Next: borg-mcp-server status",
        ].join("\n"));
      } else {
        io.stdout([
          `Verifying borgmcp-server@${result.artifact.version}...`,
          "Artifact verified and activated.",
          "No server process started.",
          `Artifact: borgmcp-server@${result.artifact.version} (${result.artifact.integrity})`,
          `Build identity: ${result.artifact.sourceSha ?? "unavailable"}`,
          "Data and identity: preserved",
          "Next: borg-mcp-server start",
        ].join("\n"));
      }
      return 0;
    }
    case "client-rotate":
      if (extraArgs.length !== 1 || service.rotateClient === undefined) return invalidArguments(io);
      io.stdout(`Client credential rotated (shown once): ${await service.rotateClient(extraArgs[0]!)}`);
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
      if (io.readSecret === undefined) return invalidArguments(io);
      const scoped = command === "client-invite" ? parseClientInviteArguments(extraArgs) : null;
      if ((command === "owner-invite" && extraArgs.length !== 0) || scoped === undefined) {
        return invalidArguments(io);
      }
      const operation = command === "client-invite"
        ? service.createClientInvitation
        : service.replaceOwnerInvitation;
      if (operation === undefined) return invalidArguments(io);
      const recovery = await io.readSecret("Recovery credential (hidden input): ");
      const result = command === "client-invite"
        ? scoped?.cubeSelector === undefined
          ? await operation(recovery)
          : await operation(recovery, scoped.cubeSelector, scoped.access)
        : await operation(recovery);
      if (typeof result === "string") {
        io.stdout(command === "client-invite"
          ? `Client enrollment invitation (single-use, shown once): ${result}`
          : `Owner enrollment invitation (single-use, shown once): ${result}`);
      } else {
        io.stdout(
          `Cube: ${JSON.stringify(result.cubeName)} (${result.cubeId})\n` +
          `Grant: ${grantSummary(result.access)}\n` +
          `Client enrollment invitation (single-use, shown once): ${result.invitation}`,
        );
      }
      return 0;
    }
    case "invite": {
      if (extraArgs.length !== 0 || service.invite === undefined) return invalidArguments(io);
      if (io.isTTY !== true) {
        io.stderr("Invitation creation requires an interactive terminal.");
        return 1;
      }
      const invitation = await service.invite();
      io.stdout(`Invitation (single-use; shown once): ${invitation}\nShare it only with the intended recipient.`);
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
  const heading = status.status === "running"
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
    `Data and identity: ${status.dataIdentity}`,
  ];
  if (status.nextAction !== null) lines.push(`Next: ${status.nextAction}.`);
  return lines.join("\n");
}

function parseClientInviteArguments(
  args: readonly string[],
): { readonly cubeSelector?: string; readonly access?: "read" | "write" | "manage" } | undefined {
  if (args.length === 0) return {};
  const cubeSelector = args[0];
  if (cubeSelector === undefined || cubeSelector.startsWith("--")) return undefined;
  if (args.length === 1) return { cubeSelector };
  if (args.length !== 3 || args[1] !== "--access") return undefined;
  const access = args[2];
  if (access !== "read" && access !== "write" && access !== "manage") return undefined;
  return { cubeSelector, access };
}

function grantSummary(access: "read" | "write" | "manage"): string {
  if (access === "read") return "read (observe - discover, attach as observer, and read)";
  if (access === "manage") return "manage (administer - coordinate plus cube administration)";
  return "write (coordinate - attach, read, post, acknowledge, and receive directed wakes)";
}

function invalidArguments(io: CliIo): 1 {
  io.stderr("Invalid command arguments.");
  return 1;
}
