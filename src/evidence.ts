import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

export async function hashFiles(directory: string, prefix = ''): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Evidence cannot contain symbolic links: ${name}`);
    if (entry.isDirectory()) Object.assign(hashes, await hashFiles(join(directory, entry.name), name));
    else if (entry.isFile()) hashes[name] = sha256(await readFile(join(directory, entry.name)));
  }
  return hashes;
}

export async function snapshotInputs(repository: string, destination: string): Promise<Record<string, string>> {
  await mkdir(destination);
  for (const file of ['fixtures/editor', 'notes/patches', 'src', 'tests', 'playwright.config.js', 'package.json', 'package-lock.json', 'tsconfig.json', '.nvmrc', '.node-version']) {
    // All source that affects the experiment, including uncommitted fixture and
    // verifier changes, is retained. A Git SHA alone cannot identify a dirty tree.
    await cp(join(repository, file), join(destination, file), { recursive: true, errorOnExist: true, force: false });
  }
  return hashFiles(destination);
}

export async function sealProviderEvidence(directory: string): Promise<Record<string, string>> {
  // Recovery extends the live API journal. Preserve its original bytes under a
  // separate path before hashing, so cleanup cannot invalidate the run record.
  const mutable = ['operations', 'owned', 'receipts'];
  const destination = join(directory, 'journal-snapshot');
  await mkdir(destination);
  for (const name of mutable) {
    try { await cp(join(directory, name), join(destination, name), { recursive: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return Object.fromEntries(Object.entries(await hashFiles(directory)).filter(([path]) =>
    !mutable.some(name => path.startsWith(`${name}/`))));
}
