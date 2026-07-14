import type { BindOptionsInput } from "./network-policy.js";

export function parseStartOptions(args: readonly string[]): BindOptionsInput {
  let host: string | undefined;
  let port: number | undefined;
  let lanConsent = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--lan") {
      if (lanConsent) throw new Error("--lan may be provided only once.");
      lanConsent = true;
      continue;
    }
    if (argument === "--host") {
      if (host !== undefined) throw new Error("--host may be provided only once.");
      host = requiredValue(args, index, "--host");
      index += 1;
      continue;
    }
    if (argument === "--port") {
      if (port !== undefined) throw new Error("--port may be provided only once.");
      const value = requiredValue(args, index, "--port");
      if (!/^\d+$/u.test(value)) throw new Error("--port must be an integer.");
      port = Number(value);
      index += 1;
      continue;
    }
    throw new Error("Unknown start option.");
  }

  return {
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(lanConsent ? { lanConsent: true } : {}),
  };
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}
