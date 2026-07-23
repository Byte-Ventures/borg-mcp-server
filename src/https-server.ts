import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { createHash, X509Certificate } from "node:crypto";
import {
  ATTACH_PATH,
  CUBES_PATH,
  ENROLLMENT_EXCHANGE_PATH,
  ErrorCode,
  HEALTH_PATH,
  PROTOCOL_INFO_PATH,
  PROTOCOL_VERSION,
  createProtocolTagPreflight,
} from "borgmcp-shared/protocol";

import { resolveBindOptions, type BindOptionsInput } from "./network-policy.js";
import type { CoordinationRequest, CoordinationResponse } from "./coordination-api.js";
import type { Principal } from "./principal.js";
import { disabledDebugLogger, type DebugLogger, type DebugRoute } from "./debug-log.js";
import { RUNTIME_INFO_PATH, type RuntimeBuildIdentity } from "./runtime-identity.js";

export interface ServiceLimits {
  readonly maxConnections: number;
  readonly maxConnectionsPerAddress: number;
  readonly maxRequestsPerWindow: number;
  readonly maxRequestsPerAddressWindow: number;
  readonly maxRequestsGlobalWindow: number;
  readonly rateLimitWindowMs: number;
  readonly maxRateLimitEntries: number;
  readonly maxStreamsPerCredential: number;
  readonly maxHeaderBytes: number;
  readonly maxRequestBodyBytes: number;
  readonly maxRequestsPerSocket: number;
  readonly requestTimeoutMs: number;
  readonly tlsHandshakeTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly handlerTimeoutMs: number;
}

export const DEFAULT_SERVICE_LIMITS: ServiceLimits = {
  maxConnections: 100,
  maxConnectionsPerAddress: 30,
  maxRequestsPerWindow: 120,
  maxRequestsPerAddressWindow: 600,
  maxRequestsGlobalWindow: 5_000,
  rateLimitWindowMs: 60_000,
  maxRateLimitEntries: 1_024,
  maxStreamsPerCredential: 8,
  maxHeaderBytes: 16_384,
  maxRequestBodyBytes: 65_536,
  maxRequestsPerSocket: 0,
  requestTimeoutMs: 15_000,
  tlsHandshakeTimeoutMs: 10_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  handlerTimeoutMs: 5_000,
};

export interface RequestHandlerContext {
  readonly exchangeEnrollment?: (
    body: unknown,
  ) => Promise<{ readonly status: 201 | 400 | 401 | 426 | 507; readonly body?: unknown }>;
  readonly authorizeCoordination?: (
    authorization: string | undefined,
    signal: AbortSignal,
  ) => Promise<Principal | "missing" | "invalid" | "revoked" | "evicted" | "rejected">;
  readonly handleCoordination?: (request: CoordinationRequest) => Promise<CoordinationResponse>;
  readonly debugLogger: DebugLogger;
  readonly runtimeIdentity?: RuntimeBuildIdentity;
}

export interface HttpsServerOptions {
  readonly bind?: BindOptionsInput;
  readonly tls: {
    readonly key: string | Buffer;
    readonly cert: string | Buffer;
    readonly ca?: string | Buffer;
  };
  readonly exchangeEnrollment?: RequestHandlerContext["exchangeEnrollment"];
  readonly authorizeCoordination?: RequestHandlerContext["authorizeCoordination"];
  readonly handleCoordination?: RequestHandlerContext["handleCoordination"];
  readonly limits?: ServiceLimits;
  readonly debugLogger?: DebugLogger;
  readonly runtimeIdentity?: RuntimeBuildIdentity;
  readonly testHooks?: {
    readonly identifyRemoteAddress?: (socket: Socket) => string;
    readonly identifyConnectionAddress?: (socket: Socket) => string;
    readonly connectionLimitMode?: "loopback" | "lan";
  };
}

export interface RunningServer {
  readonly origin: string;
  readonly limits: ServiceLimits;
  readonly close: () => Promise<void>;
}

export async function startHttpsServer(options: HttpsServerOptions): Promise<RunningServer> {
  if (options.handleCoordination !== undefined && options.authorizeCoordination === undefined) {
    throw new Error("Coordination routes require server-derived principal authentication.");
  }
  const bind = resolveBindOptions(options.bind ?? {});
  const limits = options.limits ?? DEFAULT_SERVICE_LIMITS;
  validateLimits(limits);
  validateTlsCertificate(options.tls.cert, bind.host, bind.mode, options.tls.ca);
  const handlerContext = createRequestHandlerContext(options);
  const identifyRemoteAddress = options.testHooks?.identifyRemoteAddress ??
    ((socket: Socket) => socket.remoteAddress ?? "unknown");
  const identifyConnectionAddress = options.testHooks?.identifyConnectionAddress ??
    ((socket: Socket) => socket.remoteAddress ?? "unknown");
  const addressConnectionLimiter = new AddressConnectionLimiter(
    limits.maxConnectionsPerAddress,
    limits.maxConnections,
    identifyConnectionAddress,
    options.testHooks?.connectionLimitMode ?? bind.mode,
  );

  const server = createServer(
    {
      key: options.tls.key,
      cert: options.tls.cert,
      minVersion: "TLSv1.3",
      maxHeaderSize: limits.maxHeaderBytes,
      requestTimeout: limits.requestTimeoutMs,
      handshakeTimeout: limits.tlsHandshakeTimeoutMs,
      headersTimeout: limits.headersTimeoutMs,
      keepAliveTimeout: limits.keepAliveTimeoutMs,
    },
    createRequestListener(
      handlerContext,
      limits,
      identifyRemoteAddress,
      (socket) => addressConnectionLimiter.isRejected(socket),
    ),
  );

  const acceptedSockets = applyServerLimits(server, limits, addressConnectionLimiter);
  server.on("secureConnection", (socket) => {
    socket.disableRenegotiation();
    addressConnectionLimiter.admit(socket);
  });
  server.on("tlsClientError", (_error, socket) => {
    handlerContext.debugLogger.emit({ event: "transport_rejection", reason: "tls_client_error" });
    socket.destroy();
  });
  server.on("clientError", (_error, socket) => {
    handlerContext.debugLogger.emit({ event: "transport_rejection", reason: "http_parser_error" });
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  server.on("checkContinue", (_request, response) => sendEmpty(response, 417, true));

  try {
    await listen(server, bind.port, bind.host);
  } catch (error) {
    server.closeAllConnections();
    try {
      server.close();
    } catch {
      // Preserve the originating listen failure.
    }
    throw error;
  }
  const address = server.address() as AddressInfo;
  const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  let closePromise: Promise<void> | undefined;

  return {
    origin: `https://${displayHost}:${address.port}`,
    limits,
    close: () => {
      closePromise ??= close(server, acceptedSockets);
      return closePromise;
    },
  };
}

export function createRequestHandlerContext(
  options: HttpsServerOptions,
): RequestHandlerContext {
  return Object.freeze({
    ...(options.exchangeEnrollment === undefined
      ? {}
      : { exchangeEnrollment: options.exchangeEnrollment }),
    ...(options.authorizeCoordination === undefined
      ? {}
      : { authorizeCoordination: options.authorizeCoordination }),
    ...(options.handleCoordination === undefined
      ? {}
      : { handleCoordination: options.handleCoordination }),
    ...(options.runtimeIdentity === undefined ? {} : { runtimeIdentity: options.runtimeIdentity }),
    debugLogger: options.debugLogger ?? disabledDebugLogger,
  });
}

function createRequestListener(
  context: RequestHandlerContext,
  limits: ServiceLimits,
  identifyRemoteAddress: (socket: Socket) => string = (socket) => socket.remoteAddress ?? "unknown",
  isConnectionRejected: (socket: Socket) => boolean = () => false,
): (request: IncomingMessage, response: ServerResponse) => void {
  const admissionLimiter = new PreAuthAdmissionLimiter(limits);
  const credentialRateLimiter = new RequestRateLimiter(limits, limits.maxRequestsPerWindow);
  const streamQuota = new ConcurrentQuota(limits.maxStreamsPerCredential);
  return (request, response) => {
    const startedAt = Date.now();
    const trace: RequestTrace = {
      route: debugRoute(request.url),
      method: debugMethod(request.method),
      authentication: "not_required",
    };
    let debugEmitted = false;
    const emitDebug = (): void => {
      if (debugEmitted) return;
      debugEmitted = true;
      const status = response.headersSent ? response.statusCode : 0;
      context.debugLogger.emit({
        event: "request",
        route: trace.route,
        method: trace.method,
        authentication: trace.authentication,
        authorization: trace.authentication === "accepted"
          ? status === 403 || status === 404 ? "denied_or_not_found" : "accepted"
          : "not_checked",
        ...(trace.principal === undefined ? {} : { principal: trace.principal }),
        status,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    };
    response.once("finish", emitDebug);
    response.once("close", emitDebug);
    if (isConnectionRejected(request.socket)) {
      request.resume();
      sendRateLimited(response, 1);
      return;
    }
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("deadline");
      }, limits.handlerTimeoutMs);
      timer.unref();
    });
    const handled = handleRequest(
      request,
      response,
      context,
      limits,
      admissionLimiter,
      credentialRateLimiter,
      streamQuota,
      identifyRemoteAddress,
      controller.signal,
      trace,
    )
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
  admissionLimiter: PreAuthAdmissionLimiter,
  credentialRateLimiter: RequestRateLimiter,
  streamQuota: ConcurrentQuota,
  identifyRemoteAddress: (socket: Socket) => string,
  signal: AbortSignal,
  trace: RequestTrace,
): Promise<void> {
  const addressIdentity = `address:${identifyRemoteAddress(request.socket)}`;
  const preAuthRetry = admissionLimiter.consume(addressIdentity);
  if (preAuthRetry !== null) {
    request.resume();
    sendRateLimited(response, preAuthRetry);
    return;
  }
  if (request.headers.origin !== undefined) {
    request.resume();
    sendEmpty(response, 403, true);
    return;
  }

  const path = parseRequestPath(request.url);

  const requestBody = await readRequestBody(request, limits.maxRequestBodyBytes);
  if (requestBody === "oversized") {
    if (isCoordinationPath(path)) {
      sendJson(response, 413, protocolError("CONTENT_TOO_LARGE", "Request body is too large."), true);
    } else {
      sendEmpty(response, 413, true);
    }
    return;
  }

  if (path === HEALTH_PATH) {
    if (requestBody.length !== 0) return sendEmpty(response, 400, true);
    sendEmpty(response, request.method === "GET" ? 204 : 405);
    return;
  }

  if (path === PROTOCOL_INFO_PATH) {
    if (requestBody.length !== 0) return sendEmpty(response, 400, true);
    if (request.method !== "GET") {
      sendEmpty(response, 405);
      return;
    }
    sendJson(response, 200, createProtocolTagPreflight());
    return;
  }

  if (path === ENROLLMENT_EXCHANGE_PATH) {
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
    if (signal.aborted) return;
    if (result.body === undefined) sendEmpty(response, result.status, result.status === 400);
    else if (result.status === 400) sendJson(response, 400, result.body, true);
    else if (result.status === 401 || result.status === 426 || result.status === 507) {
      sendJson(response, result.status, result.body);
    }
    else sendJson(response, 201, result.body);
    return;
  }

  if (isAuthenticatedPath(path) && context.authorizeCoordination !== undefined) {
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
    const authorization = request.headers.authorization;
    const authentication = await context.authorizeCoordination(authorization, signal);
    trace.authentication = typeof authentication === "string" ? authentication : "accepted";
    if (signal.aborted) return;
    if (typeof authentication === "string") {
      if (authentication === "evicted") {
        sendJson(response, 410, protocolError(ErrorCode.DRONE_EVICTED, "Authentication failed."));
        return;
      }
      const code = authentication === "revoked" ? ErrorCode.SESSION_REVOKED
        : authentication === "rejected" ? ErrorCode.SESSION_REJECTED
        : authentication === "missing" || authorization === undefined ? "AUTH_MISSING" : "AUTH_INVALID";
      sendJson(response, 401, protocolError(code, "Authentication failed."));
      return;
    }
    trace.principal = authentication;
    if (path === RUNTIME_INFO_PATH) {
      if (request.method !== "GET" || requestBody.length !== 0) {
        sendEmpty(response, request.method === "GET" ? 400 : 405, true);
        return;
      }
      if (context.runtimeIdentity === undefined) {
        sendEmpty(response, 404);
        return;
      }
      sendJson(response, 200, context.runtimeIdentity);
      return;
    }
    if (context.handleCoordination === undefined) {
      sendJson(response, 500, protocolError("INTERNAL_ERROR", "Coordination handling is unavailable."), true);
      return;
    }
    const clientIdentity = credentialRateLimitIdentity(authentication, request.method, path);
    const credentialRetry = credentialRateLimiter.consume(clientIdentity);
    if (credentialRetry !== null) return sendRateLimited(response, credentialRetry);
    const query = parseCoordinationQuery(request.url, path);
    if (query === INVALID_COORDINATION_QUERY) {
      sendJson(response, 400, protocolError("INVALID_INPUT", "Invalid query parameters."), true);
      return;
    }
    const result = await context.handleCoordination({
      method: request.method ?? "",
      path,
      principal: authentication,
      ...(decoded === undefined ? {} : { body: decoded }),
      ...query,
      signal,
    });
    if (signal.aborted) {
      if (result.stream !== undefined) await closeRejectedStream(result.stream);
      return;
    }
    if (result.stream !== undefined) {
      const release = streamQuota.acquire(credentialIdentity(authorization) ?? addressIdentity);
      if (release === null) {
        await closeRejectedStream(result.stream);
        sendRateLimited(response, 1);
      }
      else await startEventStream(response, result.stream, release);
    } else if (result.body === undefined) {
      sendEmpty(response, result.status);
    } else {
      sendJson(response, result.status, result.body, result.status === 400 || result.status === 413);
    }
    return;
  }

  sendEmpty(response, 404);
}

interface RequestTrace {
  readonly route: DebugRoute;
  readonly method: string;
  authentication: "not_required" | "missing" | "invalid" | "revoked" | "evicted" | "rejected" | "accepted";
  principal?: Principal;
}

function debugMethod(method: string | undefined): string {
  return method === "GET" || method === "POST" || method === "PUT" ||
    method === "PATCH" || method === "DELETE" ? method : "OTHER";
}

function debugRoute(rawUrl: string | undefined): DebugRoute {
  const path = parseRequestPath(rawUrl);
  if (path === null) return "unknown";
  if (path === HEALTH_PATH) return "health";
  if (path === PROTOCOL_INFO_PATH) return "protocol";
  if (path === RUNTIME_INFO_PATH) return "runtime";
  if (path === ENROLLMENT_EXCHANGE_PATH) return "enrollment_exchange";
  if (path === ATTACH_PATH) return "client_attach";
  if (path === "/api/cubes") return "cubes";
  if (/^\/api\/cubes\/[0-9a-f-]{36}$/iu.test(path)) return "cube";
  if (/^\/api\/cubes\/[0-9a-f-]{36}\/roles$/iu.test(path)) return "cube_roles";
  if (/^\/api\/cubes\/[0-9a-f-]{36}\/roles\/[0-9a-f-]{36}$/iu.test(path)) return "cube_role";
  if (/^\/api\/cubes\/[0-9a-f-]{36}\/roles\/[0-9a-f-]{36}\/section-patch$/iu.test(path)) return "cube_role_section_patch";
  if (/^\/api\/cubes\/[0-9a-f-]{36}\/taxonomy-patch$/iu.test(path)) return "cube_taxonomy_patch";
  if (/^\/api\/cubes\/[0-9a-f-]{36}\/drones$/iu.test(path)) return "cube_drones";
  if (/^\/api\/cubes\/[0-9a-f-]{36}\/logs$/iu.test(path)) return "cube_logs";
  if (/^\/api\/cubes\/[0-9a-f-]{36}\/acks$/iu.test(path)) return "cube_acks";
  if (/^\/api\/cubes\/[0-9a-f-]{36}\/decisions$/iu.test(path)) return "cube_decisions";
  if (/^\/api\/cubes\/[0-9a-f-]{36}\/stream$/iu.test(path)) return "cube_stream";
  return "unknown";
}

async function closeRejectedStream(stream: AsyncIterable<string>): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    await iterator.return?.();
  } catch {
    // Quota rejection must not expose stream cleanup failures.
  }
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

function sendRateLimited(response: ServerResponse, retryAfter: number): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(429, {
    "cache-control": "no-store",
    connection: "close",
    "content-length": "0",
    "retry-after": retryAfter.toString(),
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

async function startEventStream(
  response: ServerResponse,
  stream: AsyncIterable<string>,
  releaseQuota: () => void,
): Promise<void> {
  if (response.destroyed || response.writableEnded || response.headersSent) {
    releaseQuota();
    await closeRejectedStream(stream);
    return;
  }
  try {
    response.writeHead(200, {
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
  } catch (error) {
    releaseQuota();
    await closeRejectedStream(stream);
    throw error;
  }
  void (async () => {
    try {
      for await (const chunk of stream) {
        if (response.destroyed || response.writableEnded) break;
        if (!response.write(chunk)) await waitForDrain(response);
      }
    } catch {
      // Stream failures terminate the connection without exposing internals.
    } finally {
      releaseQuota();
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  })();
}

function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      response.off("drain", finish);
      response.off("close", finish);
      response.off("error", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
    response.once("error", finish);
  });
}

function protocolError(code: string, message: string): object {
  return { protocol_version: PROTOCOL_VERSION, error: { code, message } };
}

const INVALID_COORDINATION_QUERY = Symbol("invalid-coordination-query");

function parseCoordinationQuery(
  value: string | undefined,
  path: string,
): { readonly cursor?: string; readonly since?: string } | typeof INVALID_COORDINATION_QUERY {
  if (value === undefined) return {};
  try {
    const parsed = new URL(value, "https://local.invalid");
    const keys = [...parsed.searchParams.keys()];
    const allowed = path.endsWith("/stream") ? "cursor" : path.endsWith("/drones") ? "since" : null;
    if (allowed === null) return keys.length === 0 ? {} : INVALID_COORDINATION_QUERY;
    if (keys.some((key) => key !== allowed)) return INVALID_COORDINATION_QUERY;
    const values = parsed.searchParams.getAll(allowed);
    if (values.length === 0) return {};
    if (values.length !== 1 || values[0]!.length === 0) return INVALID_COORDINATION_QUERY;
    return allowed === "cursor" ? { cursor: values[0]! } : { since: values[0]! };
  } catch {
    return INVALID_COORDINATION_QUERY;
  }
}

function isCoordinationPath(path: string | null): path is string {
  return path === ATTACH_PATH || path === CUBES_PATH ||
    path?.startsWith("/api/cubes/") === true;
}

function isAuthenticatedPath(path: string | null): path is string {
  return path === RUNTIME_INFO_PATH || isCoordinationPath(path);
}

function credentialRateLimitIdentity(
  principal: Principal,
  method: string | undefined,
  path: string,
): string {
  const routineRead = (method === "GET" && !path.endsWith("/stream")) ||
    (method === "PUT" && (path.endsWith("/logs") || path.endsWith("/decisions")));
  if (principal.kind === "drone-session" && routineRead) {
    return `drone-session:${principal.id}`;
  }
  return `client:${principal.kind === "drone-session" ? principal.clientId : principal.id}`;
}

function applyServerLimits(
  server: HttpsServer,
  limits: ServiceLimits,
  addressConnectionLimiter: AddressConnectionLimiter,
): Set<Socket> {
  server.maxConnections = limits.maxConnections;
  server.maxRequestsPerSocket = limits.maxRequestsPerSocket;
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = limits.headersTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.setTimeout(
    Math.min(limits.handlerTimeoutMs * 2, 2_147_483_647),
    (socket) => socket.destroy(),
  );
  const acceptedSockets = new Set<Socket>();
  server.on("connection", (socket) => {
    const tracked = socket as Socket;
    acceptedSockets.add(tracked);
    tracked.once("close", () => acceptedSockets.delete(tracked));
    addressConnectionLimiter.admitRaw(tracked);
  });
  return acceptedSockets;
}

class AddressConnectionLimiter {
  readonly #rawConnections: ConcurrentQuota;
  readonly #connections: ConcurrentQuota;
  readonly #rejected = new WeakSet<Socket>();
  readonly #identifyRemoteAddress: (socket: Socket) => string;

  constructor(
    limit: number,
    globalLimit: number,
    identifyRemoteAddress: (socket: Socket) => string,
    bindMode: "loopback" | "lan",
  ) {
    // Loopback clients all share one address, so a normal synchronized fleet
    // burst must be allowed to finish TLS and receive controlled HTTP 429
    // backpressure. LAN binds retain the tighter pre-TLS address bound against
    // incomplete-handshake exhaustion.
    const loopbackLimit = bindMode === "loopback"
      ? globalLimit
      : limit;
    this.#rawConnections = new ConcurrentQuota(
      bindMode === "loopback"
        ? loopbackLimit
        : Math.min(loopbackLimit + 1, globalLimit),
    );
    this.#connections = new ConcurrentQuota(loopbackLimit);
    this.#identifyRemoteAddress = identifyRemoteAddress;
  }

  admitRaw(socket: Socket): void {
    const release = this.#rawConnections.acquire(this.#identifyRemoteAddress(socket));
    if (release === null) {
      socket.destroy();
      return;
    }
    socket.once("close", release);
  }

  admit(socket: Socket): void {
    const release = this.#connections.acquire(this.#identifyRemoteAddress(socket));
    if (release === null) {
      this.#rejected.add(socket);
      return;
    }
    socket.once("close", release);
  }

  isRejected(socket: Socket): boolean {
    return this.#rejected.has(socket);
  }
}

function validateLimits(limits: ServiceLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0 || (value === 0 && name !== "maxRequestsPerSocket")) {
      const range = name === "maxRequestsPerSocket" ? "non-negative" : "positive";
      throw new Error(`${name} must be a ${range} safe integer.`);
    }
  }
  if (limits.headersTimeoutMs > limits.requestTimeoutMs) {
    throw new Error("headersTimeoutMs must not exceed requestTimeoutMs.");
  }
  if (limits.tlsHandshakeTimeoutMs > limits.requestTimeoutMs) {
    throw new Error("tlsHandshakeTimeoutMs must not exceed requestTimeoutMs.");
  }
  if (limits.maxConnectionsPerAddress > limits.maxConnections) {
    throw new Error("maxConnectionsPerAddress must not exceed maxConnections.");
  }
  if (limits.maxStreamsPerCredential > limits.maxConnectionsPerAddress) {
    throw new Error("maxStreamsPerCredential must not exceed maxConnectionsPerAddress.");
  }
  if (limits.maxRequestsPerWindow > limits.maxRequestsPerAddressWindow) {
    throw new Error("maxRequestsPerWindow must not exceed maxRequestsPerAddressWindow.");
  }
  if (limits.maxRequestsPerAddressWindow > limits.maxRequestsGlobalWindow) {
    throw new Error("maxRequestsPerAddressWindow must not exceed maxRequestsGlobalWindow.");
  }
}

export function validateTlsCertificate(
  certificate: string | Buffer,
  host: string,
  mode: "loopback" | "lan",
  caCertificate?: string | Buffer,
): void {
  const [parsed, ...intermediates] = parseCertificateBundle(certificate);
  if (parsed === undefined) throw new Error("TLS certificate is missing.");
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
  if (caCertificate === undefined) {
    if (mode === "lan") throw new Error("A private LAN bind requires an explicit TLS trust anchor.");
    return;
  }
  const [trustAnchor, ...additionalIntermediates] = parseCertificateBundle(caCertificate);
  if (trustAnchor === undefined) throw new Error("TLS trust anchor is missing.");
  validateCertificateAuthority(trustAnchor, now, "TLS trust anchor");
  if (!trustAnchor.verify(trustAnchor.publicKey)) {
    throw new Error("TLS trust anchor must be self-signed.");
  }
  const chain = [...intermediates, ...additionalIntermediates];
  for (const intermediate of chain) validateCertificateAuthority(intermediate, now, "TLS intermediate");
  const path = findCertificatePath(parsed, trustAnchor, chain, new Set(), 0);
  if (path === null) {
    throw new Error("TLS certificate is not signed by the configured trust anchor.");
  }
  validatePathLengthConstraints(path);
}

function parseCertificateBundle(value: string | Buffer): X509Certificate[] {
  const text = typeof value === "string" ? value : value.toString("utf8");
  const pem = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu);
  return pem === null ? [new X509Certificate(value)] : pem.map((certificate) => new X509Certificate(certificate));
}

function validateCertificateAuthority(certificate: X509Certificate, now: number, label: string): void {
  if (!certificate.ca) throw new Error(`${label} must be a CA certificate.`);
  if (now < certificate.validFromDate.getTime() || now > certificate.validToDate.getTime()) {
    throw new Error(`${label} is outside its validity period.`);
  }
  const constraints = readCaConstraints(certificate);
  if (!constraints.basicConstraintsCritical || !constraints.ca || !constraints.keyCertSign) {
    throw new Error(`${label} lacks required CA constraints or certificate-signing usage.`);
  }
}

function findCertificatePath(
  certificate: X509Certificate,
  trustAnchor: X509Certificate,
  intermediates: readonly X509Certificate[],
  visited: Set<string>,
  depth: number,
): X509Certificate[] | null {
  if (depth > 8) return null;
  if (isIssuedBy(certificate, trustAnchor)) return [certificate, trustAnchor];
  for (const intermediate of intermediates) {
    if (visited.has(intermediate.fingerprint256) || !isIssuedBy(certificate, intermediate)) continue;
    visited.add(intermediate.fingerprint256);
    const path = findCertificatePath(intermediate, trustAnchor, intermediates, visited, depth + 1);
    if (path !== null) return [certificate, ...path];
    visited.delete(intermediate.fingerprint256);
  }
  return null;
}

function isIssuedBy(certificate: X509Certificate, issuer: X509Certificate): boolean {
  return certificate.checkIssued(issuer) && certificate.verify(issuer.publicKey);
}

function validatePathLengthConstraints(path: readonly X509Certificate[]): void {
  for (let index = 1; index < path.length; index += 1) {
    const authority = path[index]!;
    const { pathLength } = readCaConstraints(authority);
    if (pathLength === null) continue;
    const subordinateAuthorities = path.slice(1, index)
      .filter((certificate) => certificate.subject !== certificate.issuer).length;
    if (subordinateAuthorities > pathLength) {
      throw new Error("TLS certificate chain exceeds a CA path-length constraint.");
    }
  }
}

interface CaConstraints {
  readonly basicConstraintsCritical: boolean;
  readonly ca: boolean;
  readonly pathLength: number | null;
  readonly keyCertSign: boolean;
}

function readCaConstraints(certificate: X509Certificate): CaConstraints {
  const extensions = readCertificateExtensions(certificate.raw);
  const basic = extensions.get("551d13");
  const keyUsage = extensions.get("551d0f");
  if (basic === undefined || keyUsage === undefined) {
    return { basicConstraintsCritical: false, ca: false, pathLength: null, keyCertSign: false };
  }
  const basicSequence = readDerElement(basic.value, 0, basic.value.length);
  if (basicSequence.tag !== 0x30 || basicSequence.end !== basic.value.length) throw new Error("Invalid CA constraints.");
  const basicChildren = readDerChildren(basic.value, basicSequence);
  const caElement = basicChildren.find((element) => element.tag === 0x01);
  const pathElement = basicChildren.find((element) => element.tag === 0x02);
  const usageBits = readDerElement(keyUsage.value, 0, keyUsage.value.length);
  if (usageBits.tag !== 0x03 || usageBits.end !== keyUsage.value.length ||
      usageBits.contentStart + 1 >= usageBits.end) throw new Error("Invalid CA key usage.");
  return {
    basicConstraintsCritical: basic.critical,
    ca: caElement !== undefined && basic.value[caElement.contentStart] !== 0,
    pathLength: pathElement === undefined ? null : readDerInteger(basic.value, pathElement),
    keyCertSign: (keyUsage.value[usageBits.contentStart + 1]! & 0x04) !== 0,
  };
}

function readCertificateExtensions(certificate: Buffer): Map<string, { critical: boolean; value: Buffer }> {
  const outer = readDerElement(certificate, 0, certificate.length);
  const outerChildren = readDerChildren(certificate, outer);
  const tbs = outerChildren[0];
  if (outer.tag !== 0x30 || tbs?.tag !== 0x30) throw new Error("Invalid X.509 certificate encoding.");
  const extensionWrapper = readDerChildren(certificate, tbs).find((element) => element.tag === 0xa3);
  if (extensionWrapper === undefined) return new Map();
  const wrapperChildren = readDerChildren(certificate, extensionWrapper);
  const extensionSequence = wrapperChildren[0];
  if (extensionSequence?.tag !== 0x30) throw new Error("Invalid X.509 extension encoding.");
  const result = new Map<string, { critical: boolean; value: Buffer }>();
  for (const extension of readDerChildren(certificate, extensionSequence)) {
    if (extension.tag !== 0x30) throw new Error("Invalid X.509 extension encoding.");
    const fields = readDerChildren(certificate, extension);
    const oid = fields[0];
    const hasCriticalField = fields[1]?.tag === 0x01;
    const critical = hasCriticalField && certificate[fields[1]!.contentStart] !== 0;
    const value = fields[hasCriticalField ? 2 : 1];
    if (oid?.tag !== 0x06 || value?.tag !== 0x04) throw new Error("Invalid X.509 extension encoding.");
    result.set(
      certificate.subarray(oid.contentStart, oid.end).toString("hex"),
      { critical, value: certificate.subarray(value.contentStart, value.end) },
    );
  }
  return result;
}

interface DerElement {
  readonly tag: number;
  readonly contentStart: number;
  readonly end: number;
}

function readDerElement(data: Buffer, offset: number, limit: number): DerElement {
  if (offset + 2 > limit) throw new Error("Invalid DER encoding.");
  const tag = data[offset]!;
  const firstLength = data[offset + 1]!;
  let length = firstLength;
  let contentStart = offset + 2;
  if ((firstLength & 0x80) !== 0) {
    const lengthBytes = firstLength & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || contentStart + lengthBytes > limit) {
      throw new Error("Invalid DER encoding.");
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = (length * 256) + data[contentStart + index]!;
    }
    contentStart += lengthBytes;
  }
  const end = contentStart + length;
  if (end > limit || end < contentStart) throw new Error("Invalid DER encoding.");
  return { tag, contentStart, end };
}

function readDerChildren(data: Buffer, parent: DerElement): DerElement[] {
  const children: DerElement[] = [];
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const child = readDerElement(data, offset, parent.end);
    children.push(child);
    offset = child.end;
  }
  if (offset !== parent.end) throw new Error("Invalid DER encoding.");
  return children;
}

function readDerInteger(data: Buffer, element: DerElement): number {
  if (element.tag !== 0x02 || element.contentStart === element.end ||
      (data[element.contentStart]! & 0x80) !== 0) throw new Error("Invalid DER integer.");
  let value = 0;
  for (let offset = element.contentStart; offset < element.end; offset += 1) {
    value = (value * 256) + data[offset]!;
    if (!Number.isSafeInteger(value)) throw new Error("DER integer exceeds policy.");
  }
  return value;
}

export class RequestRateLimiter {
  readonly #limits: Pick<ServiceLimits, "maxRequestsPerWindow" | "rateLimitWindowMs" | "maxRateLimitEntries">;
  readonly #clock: () => number;
  readonly #maxRequests: number;
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(limits: ServiceLimits, maxRequests = limits.maxRequestsPerWindow, clock: () => number = Date.now) {
    this.#limits = limits;
    this.#maxRequests = maxRequests;
    this.#clock = clock;
  }

  consume(identity: string): number | null {
    const reservation = this.reserve(identity);
    reservation.commit();
    return reservation.retryAfter;
  }

  reserve(identity: string): RateLimitReservation {
    const now = this.#clock();
    const existing = this.#buckets.get(identity);
    if (existing !== undefined && existing.resetAt > now) {
      if (existing.count >= this.#maxRequests) {
        return rejectedReservation(Math.max(1, Math.ceil((existing.resetAt - now) / 1_000)));
      }
      existing.count += 1;
      return acceptedReservation(() => { existing.count -= 1; });
    }
    if (existing !== undefined) this.#buckets.delete(identity);
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now) this.#buckets.delete(key);
    }
    if (this.#buckets.size >= this.#limits.maxRateLimitEntries) {
      return rejectedReservation(Math.max(1, Math.ceil(this.#limits.rateLimitWindowMs / 1_000)));
    }
    const bucket = { count: 1, resetAt: now + this.#limits.rateLimitWindowMs };
    this.#buckets.set(identity, bucket);
    return acceptedReservation(() => {
      if (this.#buckets.get(identity) === bucket) this.#buckets.delete(identity);
    });
  }
}

export class PreAuthAdmissionLimiter {
  readonly #global: RequestRateLimiter;
  readonly #address: RequestRateLimiter;

  constructor(limits: ServiceLimits, clock: () => number = Date.now) {
    this.#global = new RequestRateLimiter(limits, limits.maxRequestsGlobalWindow, clock);
    this.#address = new RequestRateLimiter(limits, limits.maxRequestsPerAddressWindow, clock);
  }

  consume(addressIdentity: string): number | null {
    const address = this.#address.reserve(addressIdentity);
    if (address.retryAfter !== null) return address.retryAfter;
    const global = this.#global.reserve("global");
    if (global.retryAfter !== null) {
      address.rollback();
      return global.retryAfter;
    }
    address.commit();
    global.commit();
    return null;
  }
}

interface RateLimitReservation {
  readonly retryAfter: number | null;
  readonly commit: () => void;
  readonly rollback: () => void;
}

function acceptedReservation(undo: () => void): RateLimitReservation {
  let active = true;
  return {
    retryAfter: null,
    commit: () => { active = false; },
    rollback: () => {
      if (!active) return;
      active = false;
      undo();
    },
  };
}

function rejectedReservation(retryAfter: number): RateLimitReservation {
  return { retryAfter, commit: () => undefined, rollback: () => undefined };
}

export class ConcurrentQuota {
  readonly #limit: number;
  readonly #counts = new Map<string, number>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  acquire(identity: string): (() => void) | null {
    const count = this.#counts.get(identity) ?? 0;
    if (count >= this.#limit) return null;
    this.#counts.set(identity, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.#counts.get(identity) ?? 1) - 1;
      if (remaining <= 0) this.#counts.delete(identity);
      else this.#counts.set(identity, remaining);
    };
  }
}

function credentialIdentity(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  return `credential:${createHash("sha256").update(authorization).digest("base64url")}`;
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

async function close(server: HttpsServer, acceptedSockets: Set<Socket>): Promise<void> {
  const socketClosures = [...acceptedSockets].map((socket) => new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  }));
  const listenerClosure = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
  for (const socket of acceptedSockets) socket.destroy();
  server.closeAllConnections();
  await Promise.all([listenerClosure, ...socketClosures]);
  if (acceptedSockets.size !== 0) throw new Error("HTTPS socket closure could not be confirmed.");
}
