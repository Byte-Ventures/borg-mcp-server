import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { X509Certificate } from "node:crypto";

import { resolveBindOptions, type BindOptionsInput } from "./network-policy.js";

export interface ProtocolInfoDocument {
  readonly protocol_version: string;
  readonly package: {
    readonly name: "borgmcp-shared";
    readonly version: string;
  };
  readonly capabilities: readonly string[];
  readonly limits: {
    readonly max_request_bytes: number;
    readonly max_log_message_bytes: number;
    readonly max_read_page_size: number;
    readonly max_replay_page_size: number;
  };
}

export interface ServiceLimits {
  readonly maxConnections: number;
  readonly maxHeaderBytes: number;
  readonly maxRequestBodyBytes: number;
  readonly maxRequestsPerSocket: number;
  readonly requestTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly handlerTimeoutMs: number;
}

export const DEFAULT_SERVICE_LIMITS: ServiceLimits = {
  maxConnections: 100,
  maxHeaderBytes: 16_384,
  maxRequestBodyBytes: 65_536,
  maxRequestsPerSocket: 100,
  requestTimeoutMs: 15_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  handlerTimeoutMs: 5_000,
};

export interface RequestHandlerContext {
  readonly protocolInfo: ProtocolInfoDocument;
  readonly authorizeProtocol: (
    authorization: string | undefined,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly exchangeEnrollment?: (
    body: unknown,
  ) => Promise<{ readonly status: 201 | 400 | 401; readonly body?: unknown }>;
}

export interface HttpsServerOptions {
  readonly bind?: BindOptionsInput;
  readonly tls: {
    readonly key: string | Buffer;
    readonly cert: string | Buffer;
  };
  readonly protocolInfo: ProtocolInfoDocument;
  readonly authorizeProtocol: RequestHandlerContext["authorizeProtocol"];
  readonly exchangeEnrollment?: RequestHandlerContext["exchangeEnrollment"];
  readonly limits?: ServiceLimits;
}

export interface RunningServer {
  readonly origin: string;
  readonly limits: ServiceLimits;
  readonly close: () => Promise<void>;
}

export async function startHttpsServer(options: HttpsServerOptions): Promise<RunningServer> {
  const bind = resolveBindOptions(options.bind ?? {});
  const limits = options.limits ?? DEFAULT_SERVICE_LIMITS;
  validateLimits(limits);
  validateTlsCertificate(options.tls.cert, bind.host);
  const handlerContext = createRequestHandlerContext(options);

  const server = createServer(
    {
      key: options.tls.key,
      cert: options.tls.cert,
      minVersion: "TLSv1.3",
      maxHeaderSize: limits.maxHeaderBytes,
      requestTimeout: limits.requestTimeoutMs,
      headersTimeout: limits.headersTimeoutMs,
      keepAliveTimeout: limits.keepAliveTimeoutMs,
    },
    createRequestListener(handlerContext, limits),
  );

  applyServerLimits(server, limits);
  server.on("secureConnection", (socket) => socket.disableRenegotiation());
  server.on("tlsClientError", (_error, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  server.on("checkContinue", (_request, response) => sendEmpty(response, 417, true));

  await listen(server, bind.port, bind.host);
  const address = server.address() as AddressInfo;
  const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;

  return {
    origin: `https://${displayHost}:${address.port}`,
    limits,
    close: () => close(server),
  };
}

export function createRequestHandlerContext(
  options: HttpsServerOptions,
): RequestHandlerContext {
  return Object.freeze({
    protocolInfo: options.protocolInfo,
    authorizeProtocol: options.authorizeProtocol,
    ...(options.exchangeEnrollment === undefined
      ? {}
      : { exchangeEnrollment: options.exchangeEnrollment }),
  });
}

function createRequestListener(
  context: RequestHandlerContext,
  limits: ServiceLimits,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("deadline");
      }, limits.handlerTimeoutMs);
      timer.unref();
    });
    const handled = handleRequest(request, response, context, limits, controller.signal)
      .then(() => "handled" as const);

    void Promise.race([handled, deadline])
      .then((outcome) => {
        if (outcome === "deadline") sendEmpty(response, 503, true);
      })
      .catch(() => sendEmpty(response, 500, true))
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestHandlerContext,
  limits: ServiceLimits,
  signal: AbortSignal,
): Promise<void> {
  if (request.headers.origin !== undefined) {
    request.resume();
    sendEmpty(response, 403, true);
    return;
  }

  const requestBody = await readRequestBody(request, limits.maxRequestBodyBytes);
  if (requestBody === "oversized") {
    sendEmpty(response, 413, true);
    return;
  }

  const path = parseRequestPath(request.url);

  if (path === "/healthz") {
    if (requestBody.length !== 0) return sendEmpty(response, 400, true);
    sendEmpty(response, request.method === "GET" ? 204 : 405);
    return;
  }

  if (path === "/api/protocol") {
    if (requestBody.length !== 0) return sendEmpty(response, 400, true);
    const authorized = await context.authorizeProtocol(request.headers.authorization, signal);
    if (!authorized) {
      sendEmpty(response, 401);
      return;
    }
    if (request.method !== "GET") {
      sendEmpty(response, 405);
      return;
    }
    sendJson(response, 200, context.protocolInfo);
    return;
  }

  if (path === "/api/enrollment/exchange") {
    if (request.method !== "POST" || context.exchangeEnrollment === undefined) {
      sendEmpty(response, 405);
      return;
    }
    let decoded: unknown;
    if (requestBody.length === 0) {
      decoded = undefined;
    } else {
      try {
        decoded = JSON.parse(requestBody.toString("utf8"));
      } catch {
        decoded = undefined;
      }
    }
    const result = await context.exchangeEnrollment(decoded);
    if (result.body === undefined) sendEmpty(response, result.status, result.status === 400);
    else if (result.status === 400) sendJson(response, 400, result.body, true);
    else if (result.status === 401) sendJson(response, 401, result.body);
    else sendJson(response, 201, result.body);
    return;
  }

  sendEmpty(response, 404);
}

async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | "oversized"> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    if (!/^\d+$/u.test(declaredLength)) {
      request.resume();
      return "oversized";
    }
    if (Number(declaredLength) > maxBytes) {
      request.resume();
      return "oversized";
    }
  }

  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      request.resume();
      return "oversized";
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function parseRequestPath(value: string | undefined): string | null {
  if (value === undefined || !value.startsWith("/") || value.startsWith("//")) return null;
  try {
    return new URL(value, "https://local.invalid").pathname;
  } catch {
    return null;
  }
}

function sendEmpty(response: ServerResponse, status: number, closeConnection = false): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "cache-control": "no-store",
    ...(closeConnection ? { connection: "close" } : {}),
    "content-length": "0",
  });
  response.end();
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  closeConnection = false,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    ...(closeConnection ? { connection: "close" } : {}),
    "content-length": Buffer.byteLength(body).toString(),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function applyServerLimits(server: HttpsServer, limits: ServiceLimits): void {
  server.maxConnections = limits.maxConnections;
  server.maxRequestsPerSocket = limits.maxRequestsPerSocket;
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = limits.headersTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.setTimeout(
    Math.min(limits.handlerTimeoutMs * 2, 2_147_483_647),
    (socket) => socket.destroy(),
  );
}

function validateLimits(limits: ServiceLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer.`);
    }
  }
  if (limits.headersTimeoutMs > limits.requestTimeoutMs) {
    throw new Error("headersTimeoutMs must not exceed requestTimeoutMs.");
  }
}

function validateTlsCertificate(certificate: string | Buffer, host: string): void {
  const parsed = new X509Certificate(certificate);
  const now = Date.now();
  if (now < parsed.validFromDate.getTime() || now > parsed.validToDate.getTime()) {
    throw new Error("TLS certificate is outside its validity period.");
  }
  if (parsed.ca) {
    throw new Error("TLS certificate must be a non-CA leaf certificate.");
  }
  if (parsed.checkIP(host) === undefined) {
    throw new Error("TLS certificate does not cover the bind address.");
  }
  const serverAuthOid = "1.3.6.1.5.5.7.3.1";
  if (parsed.keyUsage.length > 0 && !parsed.keyUsage.includes(serverAuthOid)) {
    throw new Error("TLS certificate does not permit server authentication.");
  }
}

function listen(server: HttpsServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function close(server: HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}
