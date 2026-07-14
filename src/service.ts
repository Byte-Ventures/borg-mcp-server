import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { bootstrapServer, loadDigestKey, type BootstrapResult } from "./bootstrap.js";
import { CredentialAuthority, CredentialDigester } from "./credentials.js";
import { createEnrollmentExchange } from "./enrollment.js";
import {
  DEFAULT_SERVICE_LIMITS,
  startHttpsServer,
  type HttpsServerOptions,
  type RunningServer,
} from "./https-server.js";
import { createPart2ProtocolInfo } from "./protocol-draft.js";
import { resolveBindOptions } from "./network-policy.js";
import { parseStartOptions } from "./start-options.js";
import { openStore } from "./store.js";

export interface ServerService {
  readonly start: (args: readonly string[]) => Promise<void>;
  readonly setup?: () => Promise<BootstrapResult>;
}

export interface ServerEnvironment {
  readonly BORG_SERVER_TLS_KEY_FILE?: string;
  readonly BORG_SERVER_TLS_CERT_FILE?: string;
  readonly BORG_SERVER_DATA_DIR?: string;
  readonly BORG_SERVER_BIND_HOST?: string;
}

interface ServiceDependencies {
  readonly environment: ServerEnvironment;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly startServer: (options: HttpsServerOptions) => Promise<RunningServer>;
  readonly onStarted: (origin: string) => void;
  readonly waitForShutdown: (server: RunningServer) => Promise<void>;
}

export function createNodeServerService(dependencies: ServiceDependencies): ServerService {
  return {
    async start(args): Promise<void> {
      const bind = parseStartOptions(args);
      const dataDirectory = dependencies.environment.BORG_SERVER_DATA_DIR;
      const keyPath = dependencies.environment.BORG_SERVER_TLS_KEY_FILE ??
        (dataDirectory === undefined ? undefined : join(dataDirectory, "server.key"));
      const certificatePath = dependencies.environment.BORG_SERVER_TLS_CERT_FILE ??
        (dataDirectory === undefined ? undefined : join(dataDirectory, "server.crt"));
      if (keyPath === undefined || certificatePath === undefined) {
        throw new Error("Server data directory or TLS files must be configured.");
      }

      const key = await dependencies.readFile(keyPath);
      let running: RunningServer;
      let authRuntime: Awaited<ReturnType<typeof openStore>> | undefined;
      let digester: CredentialDigester | undefined;
      try {
        const cert = await dependencies.readFile(certificatePath);
        let authority: CredentialAuthority | undefined;
        if (dataDirectory !== undefined) {
          authRuntime = await openStore({ path: join(dataDirectory, "borg.db") });
          const digestKey = await loadDigestKey(join(dataDirectory, "credential-digest.key"));
          digester = new CredentialDigester(digestKey);
          digestKey.fill(0);
          authority = new CredentialAuthority(authRuntime.credentials, digester);
        }
        running = await dependencies.startServer({
          bind,
          tls: { key, cert },
          limits: DEFAULT_SERVICE_LIMITS,
          protocolInfo: createPart2ProtocolInfo(DEFAULT_SERVICE_LIMITS),
          authorizeProtocol: async (authorization) =>
            authority !== undefined && authority.authenticate(authorization) !== null,
          ...(authority === undefined
            ? {}
            : { exchangeEnrollment: createEnrollmentExchange(authority) }),
        });
      } catch (error) {
        digester?.destroy();
        authRuntime?.close();
        throw error;
      } finally {
        key.fill(0);
      }
      dependencies.onStarted(running.origin);
      try {
        await dependencies.waitForShutdown(running);
      } finally {
        digester?.destroy();
        authRuntime?.close();
      }
    },
  };
}

export function selectServerEnvironment(environment: NodeJS.ProcessEnv): ServerEnvironment {
  const keyFile = environment["BORG_SERVER_TLS_KEY_FILE"];
  const certificateFile = environment["BORG_SERVER_TLS_CERT_FILE"];
  const dataDirectory = environment["BORG_SERVER_DATA_DIR"];
  const bindHost = environment["BORG_SERVER_BIND_HOST"];
  return {
    ...(keyFile === undefined ? {} : { BORG_SERVER_TLS_KEY_FILE: keyFile }),
    ...(certificateFile === undefined
      ? {}
      : { BORG_SERVER_TLS_CERT_FILE: certificateFile }),
    ...(dataDirectory === undefined ? {} : { BORG_SERVER_DATA_DIR: dataDirectory }),
    ...(bindHost === undefined ? {} : { BORG_SERVER_BIND_HOST: bindHost }),
  };
}

const serverEnvironment = selectServerEnvironment(process.env);
const dataDirectory = serverEnvironment.BORG_SERVER_DATA_DIR ?? join(homedir(), ".borg", "server");
const setupBindHost = resolveBindOptions({
  ...(serverEnvironment.BORG_SERVER_BIND_HOST === undefined
    ? {}
    : { host: serverEnvironment.BORG_SERVER_BIND_HOST }),
  lanConsent: true,
}).host;
const startOnlyService = createNodeServerService({
  environment: { ...serverEnvironment, BORG_SERVER_DATA_DIR: dataDirectory },
  readFile,
  startServer: startHttpsServer,
  onStarted: (origin) => console.error(`Borg server listening on ${origin}`),
  waitForShutdown,
});
export const nodeServerService: ServerService = {
  start: startOnlyService.start,
  setup: () => bootstrapServer(dataDirectory, setupBindHost),
};

function waitForShutdown(server: RunningServer): Promise<void> {
  return new Promise((resolve, reject) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void server.close().then(resolve, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
