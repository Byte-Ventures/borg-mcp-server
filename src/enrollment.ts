import type { CredentialAuthority } from "./credentials.js";
import { StorageCapacityError } from "./store.js";

interface EnrollmentEnvelope {
  readonly protocol_version: "1";
  readonly request_id: string;
  readonly payload: {
    readonly invitation: string;
    readonly retry_key: string;
    readonly client_credential: string;
    readonly client_name?: string;
  };
}

export function createEnrollmentExchange(authority: CredentialAuthority) {
  return async (body: unknown): Promise<{
    readonly status: 201 | 400 | 401 | 507;
    readonly body?: unknown;
  }> => {
    let envelope: EnrollmentEnvelope;
    try {
      envelope = decodeEnrollmentEnvelope(body);
    } catch {
      return {
        status: 400,
        body: errorEnvelope(
          "INVALID_INPUT",
          "Invalid enrollment request.",
          safeRequestId(body),
        ),
      };
    }
    let response;
    try {
      response = authority.exchangeInvitation({
        invitation: envelope.payload.invitation,
        retryKey: envelope.payload.retry_key,
        clientCredential: envelope.payload.client_credential,
        ...(envelope.payload.client_name === undefined
          ? {}
          : { clientName: envelope.payload.client_name }),
      });
    } catch (error) {
      if (!(error instanceof StorageCapacityError)) throw error;
      return {
        status: 507,
        body: errorEnvelope("CAPACITY_EXCEEDED", error.message, envelope.request_id),
      };
    }
    if (response === null) {
      return {
        status: 401,
        body: errorEnvelope(
          "AUTH_INVALID",
          "Enrollment authentication failed.",
          envelope.request_id,
        ),
      };
    }
    return {
      status: 201,
      body: {
        protocol_version: "1",
        request_id: envelope.request_id,
        payload: {
          purpose: response.purpose,
          client_id: response.clientId,
          server_capabilities: response.serverCapabilities,
        },
      },
    };
  };
}

function errorEnvelope(
  code: "INVALID_INPUT" | "AUTH_INVALID" | "CAPACITY_EXCEEDED",
  message: string,
  requestId?: string,
) {
  return {
    protocol_version: "1" as const,
    ...(requestId === undefined ? {} : { request_id: requestId }),
    error: { code, message },
  };
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const requestId = (value as Record<string, unknown>)["request_id"];
  return typeof requestId === "string" && /^[A-Za-z0-9._-]{8,128}$/u.test(requestId)
    ? requestId
    : undefined;
}

export function decodeEnrollmentEnvelope(value: unknown): EnrollmentEnvelope {
  const envelope = exactRecord(value, ["protocol_version", "request_id", "payload"]);
  if (envelope["protocol_version"] !== "1") throw new Error("Invalid enrollment request.");
  const requestId = envelope["request_id"];
  if (typeof requestId !== "string" || !/^[A-Za-z0-9._-]{8,128}$/u.test(requestId)) {
    throw new Error("Invalid enrollment request.");
  }
  const payload = exactRecord(
    envelope["payload"],
    ["invitation", "retry_key", "client_credential"],
    ["client_name"],
  );
  const invitation = payload["invitation"];
  if (typeof invitation !== "string" || !/^[A-Za-z0-9_-]{43,1024}$/u.test(invitation)) {
    throw new Error("Invalid enrollment request.");
  }
  const retryKey = payload["retry_key"];
  if (typeof retryKey !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(retryKey)) {
    throw new Error("Invalid enrollment request.");
  }
  const clientCredential = payload["client_credential"];
  if (typeof clientCredential !== "string" ||
      !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(clientCredential)) {
    throw new Error("Invalid enrollment request.");
  }
  const clientName = payload["client_name"];
  if (clientName !== undefined &&
      (typeof clientName !== "string" || Buffer.byteLength(clientName) > 120 ||
       !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/u.test(clientName))) {
    throw new Error("Invalid enrollment request.");
  }
  return {
    protocol_version: "1",
    request_id: requestId,
    payload: clientName === undefined
      ? { invitation, retry_key: retryKey.toLowerCase(), client_credential: clientCredential }
      : {
          invitation,
          retry_key: retryKey.toLowerCase(),
          client_credential: clientCredential,
          client_name: clientName,
        },
  };
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid enrollment request.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(record).some((key) => !allowed.has(key)) ||
      required.some((key) => !Object.hasOwn(record, key))) {
    throw new Error("Invalid enrollment request.");
  }
  return record;
}
