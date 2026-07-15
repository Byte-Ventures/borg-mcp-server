import { isIP } from "node:net";
import { operatorErrors } from "./operator-error.js";

export const DEFAULT_BIND_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7_091;

export interface BindOptionsInput {
  readonly host?: string;
  readonly port?: number;
  readonly lanConsent?: boolean;
}

export interface ResolvedBindOptions {
  readonly host: string;
  readonly port: number;
  readonly mode: "loopback" | "lan";
}

export function resolveBindOptions(input: BindOptionsInput): ResolvedBindOptions {
  const host = input.host ?? DEFAULT_BIND_HOST;
  const port = input.port ?? DEFAULT_PORT;

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw operatorErrors.BIND_PORT_INVALID;
  }
  if (isIP(host) === 0) {
    throw operatorErrors.BIND_HOST_INVALID;
  }
  if (host === "0.0.0.0" || host === "::") {
    throw operatorErrors.BIND_WILDCARD;
  }
  if (isLoopback(host)) {
    return { host, port, mode: "loopback" };
  }
  if (!isPrivateLan(host)) {
    throw operatorErrors.BIND_PUBLIC;
  }
  if (input.lanConsent !== true) {
    throw operatorErrors.BIND_LAN_CONSENT;
  }

  return { host, port, mode: "lan" };
}

function isLoopback(host: string): boolean {
  if (host === "::1") return true;
  if (isIP(host) !== 4) return false;
  return Number(host.split(".")[0]) === 127;
}

function isPrivateLan(host: string): boolean {
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    const first = octets[0];
    const second = octets[1];
    return first === 10 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254);
  }

  const normalized = host.toLowerCase();
  return normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/u.test(normalized);
}
