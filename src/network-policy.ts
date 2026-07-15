import { isIP } from "node:net";

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
    throw new Error("Port must be an integer from 0 to 65535.");
  }
  if (isIP(host) === 0) {
    throw new Error("Bind host must be an explicit IP address.");
  }
  if (host === "0.0.0.0" || host === "::") {
    throw new Error("Wildcard bind addresses are prohibited.");
  }
  if (isLoopback(host)) {
    return { host, port, mode: "loopback" };
  }
  if (!isPrivateLan(host)) {
    throw new Error("Public-routable binds are unsupported.");
  }
  if (input.lanConsent !== true) {
    throw new Error("A private LAN bind requires explicit --lan consent for this start.");
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
