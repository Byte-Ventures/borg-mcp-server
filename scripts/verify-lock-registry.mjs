import { isDeepStrictEqual } from 'node:util';

export function isExactVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value);
}

function packageNameFromLockPath(path, lockName) {
  if (path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/u.test(path)) {
    throw new Error(`Invalid ${lockName} package path: ${path}`);
  }
  const segments = path.split('/');
  let packageName = '';
  for (let index = 0; index < segments.length;) {
    if (segments[index] !== 'node_modules') throw new Error(`Invalid ${lockName} package path: ${path}`);
    const first = segments[index + 1];
    if (!first) throw new Error(`Invalid ${lockName} package path: ${path}`);
    if (first.startsWith('@')) {
      const second = segments[index + 2];
      if (!isCanonicalNameComponent(first.slice(1), 'scope') ||
          !isCanonicalNameComponent(second, 'scoped-package')) {
        throw new Error(`Invalid ${lockName} package path: ${path}`);
      }
      packageName = `${first}/${second}`;
      index += 3;
    } else {
      if (!isCanonicalNameComponent(first, 'unscoped-package')) {
        throw new Error(`Invalid ${lockName} package path: ${path}`);
      }
      packageName = first;
      index += 2;
    }
    if (packageName.length > 214) throw new Error(`Invalid ${lockName} package path: ${path}`);
  }
  return packageName;
}

function isCanonicalNameComponent(value, kind) {
  return typeof value === 'string' && value !== '.' && value !== '..' &&
    /^[a-z0-9._~-]+$/u.test(value) &&
    (kind === 'scope' || (kind === 'scoped-package' ? !value.startsWith('.') : !/^[._]/u.test(value)));
}

function canonicalRegistryTarball(name, version) {
  const basename = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`;
}

function isSha512Integrity(value) {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value)) return false;
  const encoded = value.slice('sha512-'.length);
  const digest = Buffer.from(encoded, 'base64');
  return digest.byteLength === 64 && digest.toString('base64') === encoded;
}

export async function verifyLockfile(manifest, lockfile, options = {}) {
  const lockName = options.lockName ?? 'lockfile';
  const rootFields = options.rootFields ?? [
    'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
  ];
  const dependencyFields = options.dependencyFields ?? [
    'dependencies', 'optionalDependencies', 'peerDependencies',
  ];
  const fetchImpl = options.fetchImpl ?? fetch;

  for (const field of dependencyFields) {
    const dependencies = manifest[field] ?? {};
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      throw new Error(`Invalid package.json ${field}.`);
    }
    for (const [name, version] of Object.entries(dependencies)) {
      if (!isExactVersion(version)) throw new Error(`Dependency must be an exact registry version: ${name}@${version}`);
    }
  }

  if (lockfile.name !== manifest.name || lockfile.version !== manifest.version ||
      lockfile.lockfileVersion !== 3 || lockfile.packages === null ||
      typeof lockfile.packages !== 'object' || Array.isArray(lockfile.packages)) {
    throw new Error(`${lockName} does not bind the exact package identity and lock format.`);
  }
  const rootPackage = lockfile.packages[''];
  if (rootPackage === null || typeof rootPackage !== 'object' || Array.isArray(rootPackage) ||
      rootPackage.name !== manifest.name || rootPackage.version !== manifest.version) {
    throw new Error(`${lockName} is missing its exact root package entry.`);
  }
  for (const field of rootFields) {
    if (!isDeepStrictEqual(rootPackage[field] ?? {}, manifest[field] ?? {})) {
      throw new Error(`${lockName} root ${field} do not match package.json.`);
    }
  }

  const unique = new Map();
  for (const [path, dependency] of Object.entries(lockfile.packages)) {
    if (path === '') continue;
    if (dependency === null || typeof dependency !== 'object' || Array.isArray(dependency)) {
      throw new Error(`${lockName} contains an untrusted dependency entry: ${path}`);
    }
    const name = packageNameFromLockPath(path, lockName);
    const expectedTarball = canonicalRegistryTarball(name, dependency.version);
    const rejectInstallScript = options.rejectInstallScripts === true ||
      (options.rejectInstallScripts === 'production' && dependency.dev !== true);
    if (dependency.link === true || (rejectInstallScript && dependency.hasInstallScript === true) ||
        !isExactVersion(dependency.version) ||
        (dependency.name !== undefined && dependency.name !== name) ||
        dependency.resolved !== expectedTarball || !isSha512Integrity(dependency.integrity)) {
      throw new Error(`${lockName} contains an untrusted dependency entry: ${path}`);
    }
    const key = `${name}@${dependency.version}`;
    const entry = { name, version: dependency.version, resolved: dependency.resolved, integrity: dependency.integrity };
    const previous = unique.get(key);
    if (previous && (previous.resolved !== entry.resolved || previous.integrity !== entry.integrity)) {
      throw new Error(`${lockName} contains divergent duplicate metadata: ${key}`);
    }
    unique.set(key, entry);
  }

  const entries = [...unique.values()];
  for (let index = 0; index < entries.length; index += 8) {
    await Promise.all(entries.slice(index, index + 8).map(async (entry) => {
      const endpoint = `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`;
      const response = await fetchImpl(endpoint, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Official registry metadata lookup failed: ${entry.name}@${entry.version}`);
      const metadata = await response.json();
      if (metadata?.dist?.tarball !== entry.resolved || metadata?.dist?.integrity !== entry.integrity) {
        throw new Error(`${lockName} metadata differs from the official registry: ${entry.name}@${entry.version}`);
      }
    }));
  }
}
