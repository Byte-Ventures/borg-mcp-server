import type { ServerService } from "./service.js";

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const usage = `Usage: borg-mcp-server <command>

Commands:
  setup    Prepare an offline server installation
  start    Start the server process
  help     Show this help`;

export async function runCli(
  args: readonly string[],
  service: ServerService,
  io: CliIo,
): Promise<number> {
  const [command, ...extraArgs] = args;

  if (extraArgs.length > 0) {
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
      await service.start();
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
