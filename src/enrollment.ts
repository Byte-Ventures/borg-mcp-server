import {
  ErrorCode,
  PROTOCOL_VERSION,
  ProtocolContractError,
  createProtocolEnvelope,
  decodeEnrollmentExchangeRequestEnvelope,
  type EnrollmentExchangeRequest,
  type ProtocolEnvelope,
} from "borgmcp-shared/protocol";
import type { CredentialAuthority } from "./credentials.js";
import { StorageCapacityError } from "./store.js";

type EnrollmentEnvelope = ProtocolEnvelope<EnrollmentExchangeRequest>;

export function createEnrollmentExchange(authority: CredentialAuthority) {
  return async (body: unknown): Promise<{
    readonly status: 201 | 400 | 401 | 426 | 507;
    readonly body?: unknown;
  }> => {
    let envelope: EnrollmentEnvelope;
    try {
      envelope = decodeEnrollmentEnvelope(body);
    } catch (error) {
      if (error instanceof ProtocolContractError &&
          error.code === ErrorCode.UNSUPPORTED_PROTOCOL_VERSION) {
        return {
          status: 426,
          body: errorEnvelope(
            ErrorCode.UNSUPPORTED_PROTOCOL_VERSION,
            "Unsupported protocol version.",
            safeRequestId(body),
          ),
        };
      }
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
      body: createProtocolEnvelope(envelope.request_id, {
          purpose: response.purpose,
          client_id: response.clientId,
          server_capabilities: response.serverCapabilities,
      }),
    };
  };
}

function errorEnvelope(
  code: "INVALID_INPUT" | "AUTH_INVALID" | "CAPACITY_EXCEEDED" | "UNSUPPORTED_PROTOCOL_VERSION",
  message: string,
  requestId?: string,
) {
  return {
    protocol_version: PROTOCOL_VERSION,
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
  try {
    return decodeEnrollmentExchangeRequestEnvelope(value);
  } catch (error) {
    if (error instanceof ProtocolContractError &&
        error.code === ErrorCode.UNSUPPORTED_PROTOCOL_VERSION) throw error;
    throw new Error("Invalid enrollment request.");
  }
}
