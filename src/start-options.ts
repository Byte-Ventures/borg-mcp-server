import type { BindOptionsInput } from "./network-policy.js";
import { operatorErrors, type OperatorErrorCode } from "./operator-error.js";

export function parseStartOptions(args: readonly string[]): BindOptionsInput {
  let host: string | undefined;
  let port: number | undefined;
  let lanConsent = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--lan") {
      if (lanConsent) throw operatorErrors.START_LAN_DUPLICATE;
      lanConsent = true;
      continue;
    }
    if (argument === "--host") {
      if (host !== undefined) throw operatorErrors.START_HOST_DUPLICATE;
      host = requiredValue(args, index, "START_HOST_MISSING");
      index += 1;
      continue;
    }
    if (argument === "--port") {
      if (port !== undefined) throw operatorErrors.START_PORT_DUPLICATE;
      const value = requiredValue(args, index, "START_PORT_MISSING");
      if (!/^\d+$/u.test(value)) throw operatorErrors.START_PORT_INVALID;
      port = Number(value);
      index += 1;
      continue;
    }
    throw operatorErrors.START_OPTION_UNKNOWN;
  }

  return {
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(lanConsent ? { lanConsent: true } : {}),
  };
}

function requiredValue(args: readonly string[], index: number, code: OperatorErrorCode): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw operatorErrors[code];
  }
  return value;
}
