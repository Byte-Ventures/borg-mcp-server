import type { ServerService } from "./service.js";

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
  readonly readSecret?: (prompt: string) => Promise<string>;
}

const usage = `Usage: borg-mcp-server <command> [options]

Commands:
  setup [--reinitialize]  Prepare an offline server installation
  start    Start the server process
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
    case "setup":
      if (extraArgs.length > 1 || (extraArgs.length === 1 && extraArgs[0] !== "--reinitialize")) {
        return invalidArguments(io);
      }
      if (service.setup === undefined) {
        io.stderr("Server setup is unavailable.");
        return 1;
      }
      const result = await service.setup({ reinitialize: extraArgs[0] === "--reinitialize" });
      io.stdout(`Server setup complete.\nRecovery credential (shown once; keep offline): ${result.recoveryCredential}\nOwner enrollment invitation (single-use, shown once; enroll the owner client): ${result.initialInvitation}\nSetup created no cube.\nNext: start the server with \`borg-mcp-server start\`.`);
      return 0;
    case "start":
      await service.start(extraArgs);
      return 0;
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
