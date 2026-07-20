import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org';
const PACKAGE_NAME = 'borgmcp-server';
const EXPECTED_OWNER = 'byteventures';
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const PROPAGATION_ATTEMPTS = 18;
const PROPAGATION_MAX_DELAY_MS = 15_000;

async function requestRegistry(path) {
  return fetch(`${REGISTRY}/${path}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
}

async function responseJson(response, description) {
  if (!response.ok) throw new Error(`${description} returned HTTP ${response.status}.`);
  return response.json();
}

export function verifyArtifactReport(report, expectedVersion) {
  if (report?.name !== PACKAGE_NAME) {
    throw new Error(`Release artifact package must be ${PACKAGE_NAME}.`);
  }
  if (typeof expectedVersion !== 'string' || report.version !== expectedVersion) {
    throw new Error(`Release artifact version must be exactly ${expectedVersion}.`);
  }
  if (!INTEGRITY_RE.test(report.integrity ?? '') ||
      Buffer.from(report.integrity.slice('sha512-'.length), 'base64').byteLength !== 64) {
    throw new Error('Release artifact must have a full SHA-512 integrity.');
  }
  return { name: report.name, version: report.version, integrity: report.integrity };
}

export function verifyOwner(packument, expectedOwner) {
  if (expectedOwner !== EXPECTED_OWNER) {
    throw new Error(`NPM_EXPECTED_OWNER must equal the reviewed owner ${EXPECTED_OWNER}.`);
  }
  const maintainers = (packument?.maintainers ?? []).map((entry) => entry.name).sort();
  if (maintainers.length !== 1 || maintainers[0] !== expectedOwner) {
    throw new Error(`Package ownership differs from the reviewed owner; registry maintainers: ${maintainers.join(', ')}`);
  }
}

export async function verifyPrepublish(
  report,
  {
    expectedVersion = report?.version,
    expectedOwner,
    request = requestRegistry,
  } = {},
) {
  const artifact = verifyArtifactReport(report, expectedVersion);
  const versionResponse = await request(
    `${encodeURIComponent(artifact.name)}/${encodeURIComponent(artifact.version)}`,
  );
  if (versionResponse.status !== 404) {
    if (versionResponse.ok) {
      throw new Error(`${artifact.name}@${artifact.version} already exists and is immutable.`);
    }
    throw new Error(`Version availability check returned HTTP ${versionResponse.status}.`);
  }
  const packageResponse = await request(encodeURIComponent(artifact.name));
  if (packageResponse.status === 404) {
    throw new Error(`${artifact.name} is unexpectedly unclaimed; do not bootstrap package ownership from this workflow.`);
  }
  verifyOwner(await responseJson(packageResponse, 'Package ownership check'), expectedOwner);
  return { name: artifact.name, version: artifact.version, registryState: 'owned' };
}

export async function readWithPropagationRetry(
  read,
  description,
  {
    attempts = PROPAGATION_ATTEMPTS,
    maxDelayMs = PROPAGATION_MAX_DELAY_MS,
    wait = delay,
  } = {},
) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 ||
      !Number.isSafeInteger(maxDelayMs) || maxDelayMs < 0) {
    throw new Error('Registry visibility retry bounds are invalid.');
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await read();
    if (response.status !== 404) return response;
    if (attempt === attempts) {
      throw new Error(`${description} remained HTTP 404 after ${attempts} attempts.`);
    }
    await wait(Math.min(1_000 * (2 ** (attempt - 1)), maxDelayMs));
  }
  throw new Error(`${description} retry loop terminated unexpectedly.`);
}

export async function verifyPostpublish(
  report,
  {
    expectedVersion = report?.version,
    request = requestRegistry,
    ...retryOptions
  } = {},
) {
  const artifact = verifyArtifactReport(report, expectedVersion);
  const versionResponse = await readWithPropagationRetry(
    () => request(`${encodeURIComponent(artifact.name)}/${encodeURIComponent(artifact.version)}`),
    'Published version verification',
    retryOptions,
  );
  const published = await responseJson(versionResponse, 'Published version verification');
  if (published.dist?.integrity !== artifact.integrity) {
    throw new Error(
      `Registry integrity mismatch: expected ${artifact.integrity}, received ${published.dist?.integrity}.`,
    );
  }
  return {
    name: artifact.name,
    version: artifact.version,
    integrity: artifact.integrity,
    registryState: 'verified',
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [mode, reportPath] = process.argv.slice(2);
  if (!['prepublish', 'postpublish'].includes(mode) || !reportPath) {
    throw new Error('Usage: node scripts/verify-registry-release.mjs <prepublish|postpublish> <artifact-report.json>');
  }
  const expectedVersion = process.env.EXPECTED_VERSION;
  if (!expectedVersion) throw new Error('EXPECTED_VERSION is required.');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const result = mode === 'prepublish'
    ? await verifyPrepublish(report, {
        expectedVersion,
        expectedOwner: process.env.NPM_EXPECTED_OWNER,
      })
    : await verifyPostpublish(report, { expectedVersion });
  console.log(JSON.stringify(result, null, 2));
}
