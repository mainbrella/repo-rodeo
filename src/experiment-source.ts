import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hashFiles, sha256, writeJson } from './evidence.ts';
import type { Scenario } from './scenario.ts';

export interface SourceBundle {
  kind: 'standalone' | 'web-checkout';
  commit: string;
  archive: Buffer;
  hashes: Record<string, string>;
  patches: Record<string, { bytes: Buffer; hashes: Record<string, string> } | null>;
}
export async function prepareSource(options: {
  repository: string; inputs: string; directory: string; scenario: Scenario; source?: string; sourceRef?: string;
}): Promise<SourceBundle> {
  const { repository, inputs, directory, scenario } = options;
  const app = join(directory, 'source');
  const archivePath = join(directory, 'source.tar.gz');
  const kind = options.source ? 'web-checkout' : 'standalone';
  const checkout = options.source ? resolve(options.source) : repository;
  const commit = execFileSync('git', ['rev-parse', '--verify', `${options.sourceRef || 'HEAD'}^{commit}`], { cwd: checkout, encoding: 'utf8' }).trim();
  await mkdir(app);
  if (options.source) {
    // Archive the pinned Git tree; untracked credentials and host dependencies
    // cannot accidentally enter the upload. Reject tracked environment files too.
    const names = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', commit], { cwd: checkout, encoding: 'utf8' }).split('\0');
    if (names.some(name => /(^|\/)\.env($|\.)/.test(name) && !/\.(example|sample|template)$/.test(name))) {
      throw new Error('The source commit contains an environment file; remove credentials before archiving');
    }
    execFileSync('git', ['archive', '--format=tar.gz', `--output=${archivePath}`, commit], { cwd: checkout });
    execFileSync('tar', ['-xzf', archivePath, '-C', app]);
    await readFile(join(app, 'src/repo-rodeo-bug.ts'));
    await readFile(join(app, 'package-lock.json'));
  } else {
    await cp(join(inputs, scenario.app), app, { recursive: true });
    execFileSync('tar', ['-czf', archivePath, '-C', app, '.']);
  }
  const hashes = await hashFiles(app);
  const patches: SourceBundle['patches'] = {};
  for (const control of scenario.controls) {
    if (!control.patch) { patches[control.id] = null; continue; }
    const patchPath = options.source
      ? join(inputs, 'notes/patches', `web-${control.id}.patch`)
      : join(inputs, control.patch);
    const bytes = await readFile(patchPath);
    const candidate = join(directory, `source-${control.id}`);
    await cp(app, candidate, { recursive: true });
    execFileSync('git', ['apply', '--no-index', '--check', patchPath], { cwd: candidate, stdio: 'pipe' });
    execFileSync('git', ['apply', '--no-index', patchPath], { cwd: candidate, stdio: 'pipe' });
    patches[control.id] = { bytes, hashes: await hashFiles(candidate) };
  }
  const archive = await readFile(archivePath);
  await writeJson(join(directory, 'source.json'), { kind, commit, archiveSha256: sha256(archive), hashes,
    patches: Object.fromEntries(Object.entries(patches).map(([name, patch]) => [name, patch && { sha256: sha256(patch.bytes), hashes: patch.hashes }])) });
  await writeFile(join(directory, 'guest-files.json'), JSON.stringify(Object.keys(hashes)), { flag: 'wx' });
  return { kind, commit, archive, hashes, patches };
}
