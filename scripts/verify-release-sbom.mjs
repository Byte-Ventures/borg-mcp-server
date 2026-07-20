import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_SBOM_BYTES = 10 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function packageNameFromLockPath(path) {
  const match = /(?:^|\/)node_modules\/(@[^/]+\/[^/]+|[^/]+)$/u.exec(path);
  if (!match) fail(`Cannot identify locked package: ${path}`);
  return match[1];
}

function dependencyGraph(node, name, graph = new Map()) {
  if (!node || typeof node.version !== 'string') return graph;
  const ref = `${name}@${node.version}`;
  const installed = Object.entries(node.dependencies ?? {})
    .filter(([, dependency]) => typeof dependency.version === 'string');
  const existing = graph.get(ref) ?? [];
  graph.set(ref, [...new Set([
    ...existing,
    ...installed.map(([dependencyName, dependency]) => `${dependencyName}@${dependency.version}`),
  ])].sort());
  for (const [dependencyName, dependency] of installed) {
    dependencyGraph(dependency, dependencyName, graph);
  }
  return graph;
}

function sameStrings(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function expectedPurl(name, version) {
  const encodedName = encodeURIComponent(name).replaceAll('%2F', '/');
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function expectedTarballUrl(name, version) {
  const unscopedName = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${unscopedName}-${version}.tgz`;
}

function requireCanonicalTarballUrl(value, name, version, description) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${description} is not a valid URL.`);
  }
  const expected = expectedTarballUrl(name, version);
  if (value !== expected || parsed.protocol !== 'https:' ||
      parsed.hostname !== 'registry.npmjs.org' || parsed.port !== '' ||
      parsed.username !== '' || parsed.password !== '' ||
      parsed.search !== '' || parsed.hash !== '') {
    fail(`${description} is not the exact canonical npm registry tarball URL: ${name}@${version}`);
  }
  return expected;
}

export async function verifyReleaseSbom(sbomPath, rootDirectory = process.cwd()) {
  if (!sbomPath) fail('Usage: verify-release-sbom.mjs <cyclonedx-json>');
  const raw = await readFile(resolve(sbomPath));
  if (raw.byteLength === 0 || raw.byteLength > MAX_SBOM_BYTES) {
    fail(`SBOM size must be between 1 and ${MAX_SBOM_BYTES} bytes.`);
  }

  const sbom = JSON.parse(raw.toString('utf8'));
  const manifest = JSON.parse(await readFile(join(rootDirectory, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(rootDirectory, 'npm-shrinkwrap.json'), 'utf8'));
  const rootRef = `${manifest.name}@${manifest.version}`;
  if (manifest.name !== 'borgmcp-server' || manifest.version !== '0.1.7') {
    fail(`Unexpected package identity: ${rootRef}`);
  }
  if (lock.name !== manifest.name || lock.version !== manifest.version ||
      lock.packages?.['']?.name !== manifest.name ||
      lock.packages?.['']?.version !== manifest.version) {
    fail('Root shrinkwrap identity does not match package.json.');
  }

  for (const [path, locked] of Object.entries(lock.packages).filter(([path]) => path !== '')) {
    const name = packageNameFromLockPath(path);
    if (typeof locked.resolved !== 'string') {
      fail(`Lock component has no canonical npm registry tarball URL: ${path}`);
    }
    requireCanonicalTarballUrl(locked.resolved, name, locked.version, `Lock component ${path}`);
    if (typeof locked.integrity !== 'string' ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(locked.integrity)) {
      fail(`Lock component has no canonical SHA-512 integrity: ${path}`);
    }
    const encodedIntegrity = locked.integrity.slice('sha512-'.length);
    const decodedIntegrity = Buffer.from(encodedIntegrity, 'base64');
    if (decodedIntegrity.byteLength !== 64 || decodedIntegrity.toString('base64') !== encodedIntegrity) {
      fail(`Lock component has invalid SHA-512 integrity: ${path}`);
    }
  }

  if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.5' ||
      sbom.metadata?.component?.['bom-ref'] !== rootRef ||
      sbom.metadata.component.name !== manifest.name ||
      sbom.metadata.component.version !== manifest.version ||
      sbom.metadata.component.purl !== `pkg:npm/${manifest.name}@${manifest.version}`) {
    fail(`CycloneDX root component is not bound to ${rootRef}.`);
  }
  if (!Array.isArray(sbom.components) || !Array.isArray(sbom.dependencies)) {
    fail('CycloneDX components and dependencies must be arrays.');
  }

  const lockByRef = new Map();
  for (const [path, locked] of Object.entries(lock.packages).filter(([path]) => path !== '')) {
    const ref = `${packageNameFromLockPath(path)}@${locked.version}`;
    if (lockByRef.has(ref)) fail(`Shrinkwrap identity is ambiguous: ${ref}`);
    lockByRef.set(ref, { path, locked });
  }
  const componentRefs = new Set();
  for (const component of sbom.components) {
    const lockMatch = lockByRef.get(component['bom-ref']);
    if (!lockMatch) fail(`SBOM component is absent from npm-shrinkwrap.json: ${component['bom-ref']}`);
    const { path, locked } = lockMatch;
    const name = packageNameFromLockPath(path);
    const expectedRef = `${name}@${locked.version}`;
    if (component['bom-ref'] !== expectedRef || component.name !== name ||
        component.version !== locked.version || component.purl !== expectedPurl(name, locked.version)) {
      fail(`SBOM component identity does not match its lock entry: ${path}`);
    }
    if (componentRefs.has(expectedRef)) fail(`Duplicate SBOM component: ${expectedRef}`);
    componentRefs.add(expectedRef);

    const distributionReferences = component.externalReferences?.filter(
      (reference) => reference?.type === 'distribution',
    ) ?? [];
    if (distributionReferences.length !== 1 || typeof distributionReferences[0].url !== 'string') {
      fail(`SBOM component must have exactly one distribution reference: ${expectedRef}`);
    }
    const distributionUrl = requireCanonicalTarballUrl(
      distributionReferences[0].url, name, locked.version,
      `SBOM distribution reference ${expectedRef}`,
    );
    if (distributionUrl !== locked.resolved) {
      fail(`SBOM distribution reference does not match npm-shrinkwrap.json: ${expectedRef}`);
    }
    const expectedHash = Buffer.from(locked.integrity.slice('sha512-'.length), 'base64').toString('hex');
    if (!(component.hashes ?? []).some(
      (hash) => hash?.alg === 'SHA-512' && hash.content === expectedHash,
    )) fail(`SBOM component SHA-512 does not match npm-shrinkwrap.json: ${expectedRef}`);
  }

  const installedTree = JSON.parse(execFileSync('npm', ['ls', '--json', '--all'], {
    cwd: rootDirectory,
    encoding: 'utf8',
    maxBuffer: MAX_SBOM_BYTES,
  }));
  const expectedGraph = dependencyGraph(installedTree, manifest.name);
  const expectedComponents = new Set(expectedGraph.keys());
  expectedComponents.delete(rootRef);
  if (!sameStrings(componentRefs, expectedComponents)) {
    fail('CycloneDX components do not match the installed locked release tree.');
  }

  const actualGraph = new Map();
  for (const dependency of sbom.dependencies) {
    if (typeof dependency?.ref !== 'string' || !Array.isArray(dependency.dependsOn) ||
        dependency.dependsOn.some((ref) => typeof ref !== 'string')) {
      fail('CycloneDX dependency graph contains an invalid entry.');
    }
    if (actualGraph.has(dependency.ref)) fail(`Duplicate SBOM dependency node: ${dependency.ref}`);
    actualGraph.set(dependency.ref, [...dependency.dependsOn].sort());
  }
  if (!sameStrings(actualGraph.keys(), expectedGraph.keys())) {
    fail('CycloneDX dependency nodes do not match the installed locked release tree.');
  }
  for (const [ref, expectedDependencies] of expectedGraph) {
    if (!sameStrings(actualGraph.get(ref) ?? [], expectedDependencies)) {
      fail(`CycloneDX dependency edges do not match the installed locked release tree: ${ref}`);
    }
  }

  return {
    name: manifest.name,
    version: manifest.version,
    format: `${sbom.bomFormat}-${sbom.specVersion}`,
    components: componentRefs.size,
    dependencyNodes: actualGraph.size,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyReleaseSbom(process.argv[2]), null, 2));
}
