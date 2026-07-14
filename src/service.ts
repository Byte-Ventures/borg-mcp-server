import { readFile } from "node:fs/promises";

import {
  DEFAULT_SERVICE_LIMITS,
  startHttpsServer,
  type HttpsServerOptions,
  type RunningServer,
} from "./https-server.js";
import { createPart2ProtocolInfo } from "./protocol-draft.js";
import { parseStartOptions } from "./start-options.js";

export interface ServerService {
  readonly start: (args: readonly string[]) => Promise<void>;
}

export interface ServerEnvironment {
  readonly BORG_SERVER_TLS_KEY_FILE?: string;
  readonly BORG_SERVER_TLS_CERT_FILE?: string;
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
      const keyPath = dependencies.environment.BORG_SERVER_TLS_KEY_FILE;
      const certificatePath = dependencies.environment.BORG_SERVER_TLS_CERT_FILE;
      if (keyPath === undefined || certificatePath === undefined) {
        throw new Error("TLS key and certificate files must be configured.");
      }

      const key = await dependencies.readFile(keyPath);
      let running: RunningServer;
      try {
        const cert = await dependencies.readFile(certificatePath);
        running = await dependencies.startServer({
          bind,
          tls: { key, cert },
          limits: DEFAULT_SERVICE_LIMITS,
          protocolInfo: createPart2ProtocolInfo(DEFAULT_SERVICE_LIMITS),
          authorizeProtocol: async () => false,
        });
      } finally {
        key.fill(0);
      }
      dependencies.onStarted(running.origin);
      await dependencies.waitForShutdown(running);
    },
  };
}

export function selectServerEnvironment(environment: NodeJS.ProcessEnv): ServerEnvironment {
  const keyFile = environment["BORG_SERVER_TLS_KEY_FILE"];
  const certificateFile = environment["BORG_SERVER_TLS_CERT_FILE"];
  return {
    ...(keyFile === undefined ? {} : { BORG_SERVER_TLS_KEY_FILE: keyFile }),
    ...(certificateFile === undefined
      ? {}
      : { BORG_SERVER_TLS_CERT_FILE: certificateFile }),
  };
}

export const nodeServerService = createNodeServerService({
  environment: selectServerEnvironment(process.env),
  readFile,
  startServer: startHttpsServer,
  onStarted: (origin) => console.error(`Borg server listening on ${origin}`),
  waitForShutdown,
});

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
