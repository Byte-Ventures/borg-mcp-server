import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function exercisePackedArtifact(tarballPath, options = {}) {
  if (!tarballPath) throw new Error('Usage: node scripts/exercise-packed-artifact.mjs <package.tgz>');
  const tarball = pathToFileURL(resolve(tarballPath)).href;
  const temporary = await mkdtemp(join(tmpdir(), 'borgmcp-server-consumer-'));
  const localPrefix = join(temporary, 'local');
  const globalPrefix = join(temporary, 'global');
  try {
    const npmVersion = (await execute('npm', ['--version'])).stdout.trim();
    const expectedNpmVersion = options.expectedNpmVersion ?? '11.18.0';
    if (npmVersion !== expectedNpmVersion) {
      throw new Error(`Consumer probe requires npm ${expectedNpmVersion}, received ${npmVersion}.`);
    }
    await mkdir(localPrefix);
    await writeFile(join(localPrefix, 'package.json'), `${JSON.stringify({
      private: true,
      dependencies: { 'borgmcp-server': tarball },
    })}\n`);
    await execute('npm', [
      'install', '--prefix', localPrefix, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
    ]);
    await writeFile(join(localPrefix, 'probe.mjs'), 'await import("borgmcp-server");\n');
    await execute('node', ['probe.mjs'], { cwd: localPrefix });
    const localHelp = await execute(join(localPrefix, 'node_modules', '.bin', 'borg-mcp-server'), ['--help']);
    if (!localHelp.stdout.includes('Usage: borg-mcp-server')) throw new Error('Packaged local bin did not return help.');
    const installedManifest = JSON.parse(await readFile(
      join(localPrefix, 'node_modules', 'borgmcp-server', 'package.json'),
      'utf8',
    ));
    await writeFile(join(localPrefix, 'package.json'), `${JSON.stringify({
      private: true,
      dependencies: { 'borgmcp-server': installedManifest.version },
    })}\n`);
    await execute('npm', ['ls', '--prefix', localPrefix, '--omit=dev', '--all']);

    await execute('npm', [
      'install', '--global', '--prefix', globalPrefix, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tarball,
    ]);
    const globalHelp = await execute(join(globalPrefix, 'bin', 'borg-mcp-server'), ['--help']);
    if (!globalHelp.stdout.includes('Usage: borg-mcp-server')) throw new Error('Packaged global bin did not return help.');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await exercisePackedArtifact(process.argv[2]);
}
