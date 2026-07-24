import { describe, expect, it, vi } from "vitest";

import { decodeEnrollmentEnvelope, createEnrollmentExchange } from "../src/enrollment.js";
import { StorageCapacityError } from "../src/store.js";

const invitation = "a".repeat(43);
const retryKey = "00000000-0000-4000-8000-000000000101";
const clientCredential = `${"b".repeat(42)}A`;
const payload = { invitation, retry_key: retryKey, client_credential: clientCredential };

describe("enrollment wire adapter", () => {
  it("exact-decodes the borgmcp-shared enrollment envelope", () => {
    expect(decodeEnrollmentEnvelope({
      protocol_version: "4",
      request_id: "request-1234",
      payload: { ...payload, client_name: "operator-laptop" },
    })).toEqual({
      protocol_version: "4",
      request_id: "request-1234",
      payload: { ...payload, client_name: "operator-laptop" },
    });
  });

  it.each([
    { protocol_version: "4", request_id: "request-1234", payload: { invitation: "weak" } },
     { protocol_version: "4", request_id: "bad", payload },
     { protocol_version: "4", request_id: "request-1234", payload: { ...payload, secret: invitation } },
  ])("rejects malformed or ambiguous enrollment input", (value) => {
    expect(() => decodeEnrollmentEnvelope(value)).toThrow("Invalid enrollment request.");
  });

  it("returns a non-secret stable identity in a matching response envelope", async () => {
    const authority = {
      exchangeInvitation: vi.fn().mockReturnValue({
        clientId: "00000000-0000-4000-8000-000000000001",
        purpose: "owner",
        serverCapabilities: ["create_cube"],
      }),
    };
    const exchange = createEnrollmentExchange(authority as never);

    await expect(exchange({
      protocol_version: "4",
      request_id: "request-1234",
      payload,
    })).resolves.toEqual({
      status: 201,
      body: {
        protocol_version: "4",
        request_id: "request-1234",
        payload: {
          purpose: "owner",
          client_id: "00000000-0000-4000-8000-000000000001",
          server_capabilities: ["create_cube"],
        },
      },
    });
  });

  it("maps malformed envelopes to the canonical INVALID_INPUT result", async () => {
    const exchange = createEnrollmentExchange({ exchangeInvitation: vi.fn() } as never);
    await expect(exchange({ invitation })).resolves.toEqual({
      status: 400,
      body: {
        protocol_version: "4",
        error: { code: "INVALID_INPUT", message: "Invalid enrollment request." },
      },
    });
  });

  it("rejects an old protocol tag before decoding or reflecting enrollment secrets", async () => {
    const authority = { exchangeInvitation: vi.fn() };
    const exchange = createEnrollmentExchange(authority as never);
    const result = await exchange({
      protocol_version: "2",
      request_id: "request-version-old",
      payload,
    });

    expect(result).toEqual({
      status: 426,
      body: {
        protocol_version: "4",
        request_id: "request-version-old",
        error: {
          code: "UNSUPPORTED_PROTOCOL_VERSION",
          message: "Unsupported protocol version.",
        },
      },
    });
    expect(authority.exchangeInvitation).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(invitation);
    expect(JSON.stringify(result)).not.toContain(clientCredential);
  });

  it("retains a valid request ID in malformed-request errors", async () => {
    const exchange = createEnrollmentExchange({ exchangeInvitation: vi.fn() } as never);
    await expect(exchange({
      protocol_version: "4",
      request_id: "request-1234",
      payload: { ...payload, invitation: "weak" },
    })).resolves.toMatchObject({
      status: 400,
      body: { request_id: "request-1234" },
    });
  });

  it("returns the canonical AUTH_INVALID envelope for invalid or reused invitations", async () => {
    const exchange = createEnrollmentExchange({
      exchangeInvitation: vi.fn().mockReturnValue(null),
    } as never);
    const result = await exchange({
      protocol_version: "4",
      request_id: "request-1234",
      payload,
    });

    expect(result).toEqual({
      status: 401,
      body: {
        protocol_version: "4",
        request_id: "request-1234",
        error: { code: "AUTH_INVALID", message: "Enrollment authentication failed." },
      },
    });
  });

  it("maps capacity failures to a sanitized deterministic response", async () => {
    const exchange = createEnrollmentExchange({
      exchangeInvitation: vi.fn(() => { throw new StorageCapacityError(); }),
    } as never);
    const result = await exchange({
      protocol_version: "4",
      request_id: "request-1234",
      payload,
    });

    expect(result).toEqual({
      status: 507,
      body: {
        protocol_version: "4",
        request_id: "request-1234",
        error: { code: "CAPACITY_EXCEEDED", message: "Storage capacity is unavailable." },
      },
    });
    expect(JSON.stringify(result)).not.toContain(invitation);
  });
});
