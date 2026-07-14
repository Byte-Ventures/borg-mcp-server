import { describe, expect, it, vi } from "vitest";

import { decodeEnrollmentEnvelope, createEnrollmentExchange } from "../src/enrollment.js";

const invitation = "a".repeat(43);

describe("enrollment wire adapter", () => {
  it("exact-decodes the borgmcp-shared enrollment envelope", () => {
    expect(decodeEnrollmentEnvelope({
      protocol_version: "1",
      request_id: "request-1234",
      payload: { invitation, client_name: "operator-laptop" },
    })).toEqual({
      protocol_version: "1",
      request_id: "request-1234",
      payload: { invitation, client_name: "operator-laptop" },
    });
  });

  it.each([
    { protocol_version: "1", request_id: "request-1234", payload: { invitation: "weak" } },
    { protocol_version: "1", request_id: "bad", payload: { invitation } },
    { protocol_version: "1", request_id: "request-1234", payload: { invitation, secret: invitation } },
  ])("rejects malformed or ambiguous enrollment input", (value) => {
    expect(() => decodeEnrollmentEnvelope(value)).toThrow("Invalid enrollment request.");
  });

  it("returns the one-time credential in a matching response envelope", async () => {
    const authority = {
      exchangeInvitation: vi.fn().mockReturnValue({
        clientId: "00000000-0000-4000-8000-000000000001",
        credential: "b".repeat(43),
        credentialExpiresAt: null,
      }),
    };
    const exchange = createEnrollmentExchange(authority as never);

    await expect(exchange({
      protocol_version: "1",
      request_id: "request-1234",
      payload: { invitation },
    })).resolves.toEqual({
      status: 201,
      body: {
        protocol_version: "1",
        request_id: "request-1234",
        payload: {
          client_id: "00000000-0000-4000-8000-000000000001",
          credential: "b".repeat(43),
          credential_expires_at: null,
        },
      },
    });
  });

  it("maps malformed envelopes to a bodyless-safe 400 result", async () => {
    const exchange = createEnrollmentExchange({ exchangeInvitation: vi.fn() } as never);
    await expect(exchange({ invitation })).resolves.toEqual({ status: 400 });
  });
});
