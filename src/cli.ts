import type { ServerService } from "./service.js";

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const usage = `Usage: borg-mcp-server <command> [options]

Commands:
  setup    Prepare an offline server installation
  start    Start the server process
  client-rotate <client-id>  Rotate one client credential offline
  client-revoke <client-id>  Revoke one client and its credentials offline
  help     Show this help

Start options:
  --host <ip>      Explicit bind address (default: 127.0.0.1)
  --port <number>  Listen port (default: 7091)
  --lan            Consent to this start on a private LAN address

TLS files:
  BORG_SERVER_DATA_DIR (default: ~/.borg/server), or explicit
  BORG_SERVER_TLS_KEY_FILE, BORG_SERVER_TLS_CERT_FILE, and BORG_SERVER_TLS_CA_FILE

Stop the server before running client-rotate or client-revoke.`;

export async function runCli(
  args: readonly string[],
  service: ServerService,
  io: CliIo,
): Promise<number> {
  const [command, ...extraArgs] = args;

  switch (command) {
    case "setup":
      if (extraArgs.length !== 0) return invalidArguments(io);
      if (service.setup === undefined) {
        io.stderr("Server setup is unavailable.");
        return 1;
      }
      const result = await service.setup();
      io.stdout(`Server setup complete.\nRecovery credential (shown once): ${result.recoveryCredential}\nInitial enrollment invitation (shown once): ${result.initialInvitation}`);
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

function invalidArguments(io: CliIo): 1 {
  io.stderr("Invalid command arguments.");
  return 1;
}
