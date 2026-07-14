#!/usr/bin/env node

import { runCli } from "./cli.js";
import { foundationService } from "./service.js";

const io = {
  stdout: (message: string): void => console.log(message),
  stderr: (message: string): void => console.error(message),
};

try {
  process.exitCode = await runCli(process.argv.slice(2), foundationService, io);
} catch {
  io.stderr("Server command failed.");
  process.exitCode = 1;
}
