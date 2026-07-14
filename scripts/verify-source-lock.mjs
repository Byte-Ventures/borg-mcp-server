import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyLockfile } from './verify-lock-registry.mjs';

export async function verifySourceLocks(root = '.') {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const lockNames = ['package-lock.json', 'npm-shrinkwrap.json'];
  let verified = 0;
  for (const lockName of lockNames) {
    try {
      const lockfile = JSON.parse(await readFile(resolve(root, lockName), 'utf8'));
      await verifyLockfile(manifest, lockfile, {
        lockName,
        rootFields: [
          'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'devDependencies',
        ],
        dependencyFields: ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'],
      });
      verified += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (verified === 0) throw new Error('Release source requires package-lock.json or npm-shrinkwrap.json.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifySourceLocks();
}
