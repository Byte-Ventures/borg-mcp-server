import type { ProtocolInfoDocument, ServiceLimits } from "./https-server.js";

export function createPart2ProtocolInfo(limits: ServiceLimits): ProtocolInfoDocument {
  return {
    protocol_version: "1",
    package: {
      name: "borgmcp-shared",
      version: "0.2.2",
    },
    capabilities: [
      "coordination.core",
      "auth.bearer",
      "auth.revocation",
      "auth.retry-safe-enrollment",
      "scope.cube-isolation",
      "transport.tls",
      "authority.no-cloud-fallback",
      "log.cursor",
      "stream.sse",
      "stream.replay",
      "acks",
      "claims",
      "decisions",
    ],
    limits: {
      max_request_bytes: limits.maxRequestBodyBytes,
      max_log_message_bytes: 10_240,
      max_read_page_size: 500,
      max_replay_page_size: 200,
    },
  };
}
