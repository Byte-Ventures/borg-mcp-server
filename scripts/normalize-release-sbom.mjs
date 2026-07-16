import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function normalizeReleaseSbom(inputPath, outputPath, rootDirectory = process.cwd()) {
  if (!inputPath || !outputPath) {
    throw new Error('Usage: normalize-release-sbom.mjs <raw-cyclonedx-json> <output-json>');
  }
  const manifest = JSON.parse(await readFile(join(rootDirectory, 'package.json'), 'utf8'));
  const sbom = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  const root = sbom.metadata?.component;
  const expectedRef = `${manifest.name}@${manifest.version}`;
  if (root?.['bom-ref'] !== expectedRef || root.version !== manifest.version ||
      root.purl !== `pkg:npm/${manifest.name}@${manifest.version}`) {
    throw new Error('Raw CycloneDX root identity does not match package.json.');
  }
  root.name = manifest.name;
  await writeFile(resolve(outputPath), `${JSON.stringify(sbom, null, 2)}\n`, { flag: 'wx' });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await normalizeReleaseSbom(process.argv[2], process.argv[3]);
}
