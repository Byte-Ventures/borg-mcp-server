import { describe, expect, it, vi } from "vitest";
import { createDebugLogger, disabledDebugLogger } from "../src/debug-log.js";
import { clientPrincipal } from "../src/principal.js";

describe("debug logger", () => {
  it("is silent when disabled and swallows local writer failures", () => {
    const writer = vi.fn();
    disabledDebugLogger.emit({
      event: "transport_rejection",
      reason: "tls_client_error",
    });
    expect(writer).not.toHaveBeenCalled();
    expect(() => createDebugLogger(() => { throw new Error("private writer failure"); }).emit({
      event: "transport_rejection",
      reason: "http_parser_error",
    })).not.toThrow();
  });

  it("reconstructs allowlisted JSON without traversing hostile fields", () => {
    const lines: string[] = [];
    const logger = createDebugLogger((line) => lines.push(line));
    const secret = "secret-material-that-must-never-be-logged";
    logger.emit({
      event: "request",
      route: "cube_logs",
      method: "POST",
      authentication: "accepted",
      authorization: "accepted",
      principal: clientPrincipal("00000000-0000-4000-8000-000000000101"),
      status: 201,
      durationMs: 3,
      authorizationHeader: `Bearer ${secret}`,
      requestBody: { message: secret },
      error: new Error(secret),
    } as never);
    logger.emit({
      event: "activity_append",
      cubeId: "00000000-0000-4000-8000-000000000102",
      entryId: "00000000-0000-4000-8000-000000000103",
      principal: clientPrincipal("00000000-0000-4000-8000-000000000101"),
      droneId: null,
      visibility: "direct",
      recipientDroneIds: ["00000000-0000-4000-8000-000000000104"],
      message: secret,
    } as never);

    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain(secret);
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "debug",
      event: "request",
      route: "cube_logs",
      method: "POST",
      authentication: "accepted",
      authorization: "accepted",
      principal_kind: "client",
      principal_id: "00000000-0000-4000-8000-000000000101",
      status: 201,
      duration_ms: 3,
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      event: "activity_append",
      recipient_count: 1,
      recipient_drone_ids: ["00000000-0000-4000-8000-000000000104"],
    });
  });

  it("drops unknown event shapes entirely", () => {
    const writer = vi.fn();
    createDebugLogger(writer).emit({ event: "raw_error", message: "secret" } as never);
    expect(writer).not.toHaveBeenCalled();
  });
});
