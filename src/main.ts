#!/usr/bin/env node

import { runCli } from "./cli.js";
import { FatalTeardownError, nodeServerService } from "./service.js";
import { pathToFileURL } from "node:url";

const io = {
  stdout: (message: string): void => console.log(message),
  stderr: (message: string): void => console.error(message),
};

export async function runMain(
  args = process.argv.slice(2),
  service = nodeServerService,
  output = io,
  fatalExit: (code: number) => never = process.exit,
): Promise<void> {
  try {
    process.exitCode = await runCli(args, service, output);
  } catch (error) {
    output.stderr("Server command failed.");
    if (error instanceof FatalTeardownError) fatalExit(1);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMain();
}
