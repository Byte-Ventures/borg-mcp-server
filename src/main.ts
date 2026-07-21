#!/usr/bin/env node

import { runCli, type CliIo } from "./cli.js";
import { isFatalTeardownError, nodeServerService } from "./service.js";
import { operatorPublicMessage } from "./operator-error.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const io = {
  stdout: (message: string): void => console.log(message),
  stderr: (message: string): void => console.error(message),
  readSecret: readHiddenSecret,
  isTTY: process.stdout.isTTY === true,
};

async function readHiddenSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdin.setRawMode === undefined) {
    throw new Error("Private terminal input is unavailable.");
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer | string): void => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 3) {
          cleanup();
          reject(new Error("Private terminal input was cancelled."));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          resolve(value);
          return;
        }
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else if (byte >= 32 && byte <= 126 && value.length < 1_024) value += String.fromCharCode(byte);
      }
    };
    process.stdin.on("data", onData);
  });
}

export async function runMain(
  args: readonly string[] = process.argv.slice(2),
  service = nodeServerService,
  output: CliIo = io,
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

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runMain();
}
