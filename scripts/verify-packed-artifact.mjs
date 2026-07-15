import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, lstat, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { isExactVersion, verifyLockfile } from './verify-lock-registry.mjs';

const MAX_PACKED_BYTES = 2 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 512;
const MAX_FILE_BYTES = 1024 * 1024;
const REQUIRED_FILES = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'npm-shrinkwrap.json',
  'package.json',
];
const ALLOWED_ROOTS = new Set([
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'dist',
  'npm-shrinkwrap.json',
  'package.json',
  'src',
]);
const EXPECTED_MANIFEST_FILES = [
  'dist',
  'src',
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'npm-shrinkwrap.json',
];
const FORBIDDEN_HOOKS = [
  'preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare',
  'postprepare', 'prepack', 'postpack', 'prepublishOnly', 'publish', 'postpublish',
  'dependencies',
];
const FORBIDDEN_CONTENT = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u, description: 'private key material' },
  { pattern: /\b(?:npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/u, description: 'credential-shaped token' },
  { pattern: /\bpostgres(?:ql)?:\/\//iu, description: 'database connection URL' },
  { pattern: /\b(?:api|test-api)\.borgmcp\.ai\b/iu, description: 'hosted backend URL' },
  { pattern: /\b[a-z0-9-]+\.workers\.dev\b/iu, description: 'Worker service URL' },
  { pattern: /(?:^|[^A-Za-z])(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/mu, description: 'local absolute path' },
];

async function walk(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`Packed artifact contains symlink: ${relative(root, absolute)}`);
    if (entry.isDirectory()) files.push(...await walk(root, absolute));
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`Packed artifact contains unsupported entry: ${relative(root, absolute)}`);
  }
  return files;
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function lockedPackageName(path) {
  const match = /(?:^|\/)node_modules\/(@[^/]+\/[^/]+|[^/]+)$/u.exec(path);
  if (!match) throw new Error(`Cannot identify disclosed dependency: ${path}`);
  return match[1];
}

function verifyThirdPartyNotices(content, shrinkwrap) {
  const expected = new Map();
  for (const [path, dependency] of Object.entries(shrinkwrap.packages)) {
    if (path === '' || dependency.dev === true) continue;
    if (typeof dependency.license !== 'string' || dependency.license.length === 0) {
      throw new Error(`Locked production dependency has no license identifier: ${path}`);
    }
    const name = lockedPackageName(path);
    const entry = expected.get(name) ?? { licenses: new Set(), versions: new Set() };
    entry.licenses.add(dependency.license);
    entry.versions.add(dependency.version);
    expected.set(name, entry);
  }
  const expectedRows = [...expected.entries()].map(([name, entry]) => ({
    name,
    versions: [...entry.versions].sort(),
    licenses: [...entry.licenses].sort(),
  })).sort((left, right) => left.name.localeCompare(right.name));
  const actualRows = [...content.matchAll(/^\| `([^`]+)` \| ([^|]+?) \| ([^|]+?) \|$/gmu)].map((match) => ({
    name: match[1],
    versions: match[2].split(', '),
    licenses: match[3].split(', '),
  })).sort((left, right) => left.name.localeCompare(right.name));
  if (!isDeepStrictEqual(actualRows, expectedRows)) {
    throw new Error('THIRD_PARTY_NOTICES.md does not match the locked production dependency tree.');
  }
}

export async function verifyPackedArtifact(tarballPath) {
  if (!tarballPath) throw new Error('Usage: node scripts/verify-packed-artifact.mjs <package.tgz>');
  try {
    await access(resolve('.npmrc'));
    throw new Error('Repository-local .npmrc is forbidden for release builds.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const tarball = resolve(tarballPath);
  const packed = await readFile(tarball);
  if (packed.byteLength > MAX_PACKED_BYTES) {
    throw new Error(`Packed artifact exceeds ${MAX_PACKED_BYTES} bytes.`);
  }
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  const verboseEntries = execFileSync('tar', ['-tvzf', tarball], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  if (verboseEntries.length !== entries.length ||
      verboseEntries.some((entry) => entry[0] !== '-' && entry[0] !== 'd')) {
    throw new Error('Tar contains links or unsupported entry types.');
  }
  if (entries.length > MAX_FILES + 32 || new Set(entries).size !== entries.length) {
    throw new Error('Tar entry count exceeds policy or contains duplicate paths.');
  }
  for (const entry of entries) {
    const segments = entry.split('/');
    if (!entry.startsWith('package/') || entry.startsWith('/') || entry.includes('\\') ||
        entry.length > 512 || segments.includes('..') || segments.includes('.')) {
      throw new Error(`Unsafe tar entry: ${entry}`);
    }
  }

  const temporary = await mkdtemp(join(tmpdir(), 'borgmcp-server-pack-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', temporary], { stdio: 'pipe' });
    const root = join(temporary, 'package');
    const files = await walk(root);
    if (files.length > MAX_FILES) throw new Error('Packed artifact contains too many files.');
    let unpackedBytes = 0;
    const relativeFiles = new Set();
    for (const file of files) {
      const path = relative(root, file).split(sep).join('/');
      const rootEntry = path.split('/')[0];
      if (!ALLOWED_ROOTS.has(rootEntry)) throw new Error(`Unexpected packed path: ${path}`);
      if (rootEntry === 'dist' && !/\.(?:js|d\.ts)(?:\.map)?$/u.test(path)) {
        throw new Error(`Unexpected dist artifact: ${path}`);
      }
      if (rootEntry === 'src' && !/\.ts$/u.test(path)) {
        throw new Error(`Unexpected source artifact: ${path}`);
      }
      if (/(^|\/)(\.env(?:\.|$)|\.npmrc$|node_modules|[^/]+\.(?:pem|key|p12|pfx))/.test(path)) {
        throw new Error(`Forbidden packed path: ${path}`);
      }
      const size = (await stat(file)).size;
      if (size > MAX_FILE_BYTES) throw new Error(`Packed file exceeds policy: ${path}`);
      const content = await readFile(file, 'utf8');
      for (const forbidden of FORBIDDEN_CONTENT) {
        if (forbidden.pattern.test(content)) {
          throw new Error(`Packed artifact contains ${forbidden.description}: ${path}`);
        }
      }
      unpackedBytes += size;
      relativeFiles.add(path);
    }
    if (unpackedBytes > MAX_UNPACKED_BYTES) throw new Error('Unpacked artifact exceeds policy.');
    for (const required of REQUIRED_FILES) {
      if (!relativeFiles.has(required)) throw new Error(`Packed artifact is missing ${required}.`);
    }

    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (manifest.name !== 'borgmcp-server' || !isExactVersion(manifest.version) || manifest.version === '0.0.0') {
      throw new Error(`Unexpected package identity: ${manifest.name}@${manifest.version}`);
    }
    if (manifest.private !== false || manifest.license !== 'SEE LICENSE IN LICENSE') {
      throw new Error('Release package must be public and bind licensing to the reviewed LICENSE file.');
    }
    if (manifest.repository?.url !== 'git+https://github.com/Byte-Ventures/borg-mcp-server.git') {
      throw new Error('package.json repository must match the provenance repository exactly.');
    }
    if (JSON.stringify(manifest.publishConfig) !== JSON.stringify({ access: 'public' })) {
      throw new Error('publishConfig must contain only access=public; registry redirects are forbidden.');
    }
    if (!isDeepStrictEqual(manifest.files, EXPECTED_MANIFEST_FILES)) {
      throw new Error('Package files must match the reviewed public artifact boundary.');
    }
    if (!isDeepStrictEqual(manifest.bin, { 'borg-mcp-server': './dist/main.js' }) ||
        !isDeepStrictEqual(manifest.exports, {
          '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        })) {
      throw new Error('Package bin and exports must match the reviewed public entrypoints.');
    }
    for (const entrypoint of ['dist/main.js', 'dist/index.js', 'dist/index.d.ts']) {
      if (!relativeFiles.has(entrypoint)) throw new Error(`Package entrypoint is not shipped: ${entrypoint}`);
    }
    for (const hook of FORBIDDEN_HOOKS) {
      if (manifest.scripts?.[hook]) throw new Error(`Forbidden consumer lifecycle hook: ${hook}`);
    }
    for (const field of ['bundleDependencies', 'bundledDependencies']) {
      if (Object.hasOwn(manifest, field)) throw new Error(`Bundled dependencies are forbidden: ${field}.`);
    }

    const shrinkwrap = JSON.parse(await readFile(join(root, 'npm-shrinkwrap.json'), 'utf8'));
    await verifyLockfile(manifest, shrinkwrap, {
      lockName: 'npm-shrinkwrap.json',
      dependencyFields: ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'],
      rejectInstallScripts: 'production',
    });
    verifyThirdPartyNotices(
      await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
      shrinkwrap,
    );

    for (const path of relativeFiles) {
      if (!path.endsWith('.map')) continue;
      const mapPath = join(root, ...path.split('/'));
      const sourceMap = JSON.parse(await readFile(mapPath, 'utf8'));
      if (sourceMap === null || typeof sourceMap !== 'object' || Array.isArray(sourceMap) || sourceMap.version !== 3) {
        throw new Error(`Invalid source map v3 shape: ${path}`);
      }
      if (Object.hasOwn(sourceMap, 'sections')) throw new Error(`Indexed source maps are forbidden: ${path}`);
      if (Object.hasOwn(sourceMap, 'sourcesContent')) throw new Error(`Source map embeds sourcesContent: ${path}`);
      if (!Array.isArray(sourceMap.sources) || sourceMap.sources.some((source) => typeof source !== 'string') ||
          (sourceMap.sourceRoot !== undefined && typeof sourceMap.sourceRoot !== 'string')) {
        throw new Error(`Invalid source map sources: ${path}`);
      }
      for (const source of sourceMap.sources) {
        const target = resolve(dirname(mapPath), sourceMap.sourceRoot ?? '', source);
        if (!isInside(root, target) || !relativeFiles.has(relative(root, target).split(sep).join('/'))) {
          throw new Error(`Source map target is not shipped: ${path} -> ${source}`);
        }
      }
    }
    return {
      name: manifest.name,
      version: manifest.version,
      fileCount: files.length,
      packedBytes: packed.byteLength,
      unpackedBytes,
      integrity: `sha512-${createHash('sha512').update(packed).digest('base64')}`,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyPackedArtifact(process.argv[2]), null, 2));
}
