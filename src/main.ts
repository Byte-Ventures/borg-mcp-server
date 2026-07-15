#!/usr/bin/env node

import { runCli } from "./cli.js";
import { isFatalTeardownError, nodeServerService } from "./service.js";
import { operatorPublicMessage } from "./operator-error.js";
import { pathToFileURL } from "node:url";

const io = {
  stdout: (message: string): void => console.log(message),
  stderr: (message: string): void => console.error(message),
};

export async function runMain(
  args: readonly string[] = process.argv.slice(2),
  service = nodeServerService,
  output = io,
  fatalExit: (code: number) => never = process.exit,
): Promise<void> {
  try {
    process.exitCode = await runCli(args, service, output);
  } catch (error) {
    if (isFatalTeardownError(error)) {
      output.stderr("Server command failed.");
      fatalExit(1);
    }
    const operatorMessage = operatorPublicMessage(error);
    output.stderr(operatorMessage === null
      ? "Server command failed."
      : `Server command failed: ${operatorMessage}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMain();
}
