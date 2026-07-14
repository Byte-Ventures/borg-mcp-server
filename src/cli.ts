import type { ServerService } from "./service.js";

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const usage = `Usage: borg-mcp-server <command> [options]

Commands:
  setup    Prepare an offline server installation
  start    Start the server process
  help     Show this help

Start options:
  --host <ip>      Explicit bind address (default: 127.0.0.1)
  --port <number>  Listen port (default: 7443)
  --lan            Consent to this start on a private LAN address

TLS files:
  BORG_SERVER_TLS_KEY_FILE and BORG_SERVER_TLS_CERT_FILE`;

export async function runCli(
  args: readonly string[],
  service: ServerService,
  io: CliIo,
): Promise<number> {
  const [command, ...extraArgs] = args;

  if (command !== "start" && extraArgs.length > 0) {
    io.stderr("This command does not accept arguments yet.");
    return 1;
  }

  switch (command) {
    case "setup":
      io.stderr(
        "Server setup is not implemented in this foundation build; no listener was started.",
      );
      return 1;
    case "start":
      await service.start(extraArgs);
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
