import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const registryOrigin = "https://registry.npmjs.org";
const exactVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const integrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const sourceShaPattern = /^[0-9a-f]{40}$/u;

export interface RegistryRuntimeArtifact {
  readonly tarballPath: string;
  readonly version: string;
  readonly integrity: string;
  readonly sourceSha: string | null;
  readonly cleanup: () => Promise<void>;
}

export interface RegistryArtifactSource {
  readonly latest: (runtimeRoot: string, signal: AbortSignal) => Promise<RegistryRuntimeArtifact>;
}

export function createRegistryArtifactSource(
  request: typeof fetch = fetch,
): RegistryArtifactSource {
  return {
    async latest(runtimeRoot, signal): Promise<RegistryRuntimeArtifact> {
      if (!isAbsolute(runtimeRoot)) throw new Error("Runtime root must be absolute.");
      try {
        const existing = await lstat(runtimeRoot);
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          throw new Error("Runtime root must be a private directory.");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
      }
      const root = await realpath(runtimeRoot);
      const rootMetadata = await lstat(root);
      if ((rootMetadata.mode & 0o077) !== 0) throw new Error("Runtime root must be a private directory.");
      const temporary = await mkdtemp(join(root, ".download-"));
      try {
        const metadataResponse = await request(`${registryOrigin}/borgmcp-server/latest`, {
          headers: { accept: "application/json" },
          redirect: "error",
          signal,
        });
        if (!metadataResponse.ok || metadataResponse.url !== `${registryOrigin}/borgmcp-server/latest`) {
          throw new Error("Server artifact metadata verification failed.");
        }
        const metadataBytes = await readBounded(metadataResponse, 64 * 1024);
        const metadata = JSON.parse(metadataBytes.toString("utf8")) as {
          name?: unknown;
          version?: unknown;
          gitHead?: unknown;
          dist?: { integrity?: unknown; tarball?: unknown };
        };
        if (metadata.name !== "borgmcp-server" || typeof metadata.version !== "string" ||
            !exactVersion.test(metadata.version) || typeof metadata.dist?.integrity !== "string" ||
            !integrityPattern.test(metadata.dist.integrity)) {
          throw new Error("Server artifact metadata verification failed.");
        }
        const canonicalTarball = `${registryOrigin}/borgmcp-server/-/borgmcp-server-${metadata.version}.tgz`;
        if (metadata.dist.tarball !== canonicalTarball ||
            (metadata.gitHead !== undefined &&
              (typeof metadata.gitHead !== "string" || !sourceShaPattern.test(metadata.gitHead)))) {
          throw new Error("Server artifact metadata verification failed.");
        }
        const artifactResponse = await request(canonicalTarball, { redirect: "error", signal });
        if (!artifactResponse.ok || artifactResponse.url !== canonicalTarball) {
          throw new Error("Server artifact download failed.");
        }
        const artifact = await readBounded(artifactResponse, 2 * 1024 * 1024);
        const tarballPath = join(temporary, `borgmcp-server-${metadata.version}.tgz`);
        await writeFile(tarballPath, artifact, { flag: "wx", mode: 0o600 });
        return Object.freeze({
          tarballPath,
          version: metadata.version,
          integrity: metadata.dist.integrity,
          sourceSha: typeof metadata.gitHead === "string" ? metadata.gitHead : null,
          cleanup: () => rm(temporary, { recursive: true, force: true }),
        });
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    },
  };
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > limit)) {
    throw new Error("Server artifact response exceeded its bound.");
  }
  if (response.body === null) throw new Error("Server artifact response is empty.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new Error("Server artifact response exceeded its bound.");
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}
