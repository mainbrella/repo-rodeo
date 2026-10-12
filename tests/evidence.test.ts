import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { hashFiles, sha256, writeJson } from '../src/evidence.ts';

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'repo-rodeo-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('hashFiles is deterministic and tracks changed file contents', async t => {
  const directory = await temporaryDirectory(t);
  await mkdir(join(directory, 'nested'));
  await writeFile(join(directory, 'a.txt'), 'alpha');
  await writeFile(join(directory, 'nested', 'b.txt'), 'bravo');

  const first = await hashFiles(directory);
  assert.deepEqual(first, {
    'a.txt': sha256('alpha'),
    'nested/b.txt': sha256('bravo'),
  });
  assert.deepEqual(await hashFiles(directory), first);

  await writeFile(join(directory, 'nested', 'b.txt'), 'changed');
  const changed = await hashFiles(directory);
  assert.equal(changed['a.txt'], first['a.txt']);
  assert.notEqual(changed['nested/b.txt'], first['nested/b.txt']);
});

test('hashFiles rejects symbolic links instead of following them', async t => {
  const directory = await temporaryDirectory(t);
  await writeFile(join(directory, 'target.txt'), 'target');
  await symlink('target.txt', join(directory, 'linked.txt'));

  await assert.rejects(hashFiles(directory), /symbolic links/);
});

test('writeJson creates a file once and refuses to overwrite it', async t => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, 'result.json');
  await writeJson(path, { status: 'passed' });
  const original = await readFile(path, 'utf8');
  assert.equal(original, '{\n  "status": "passed"\n}\n');

  await assert.rejects(writeJson(path, { status: 'replaced' }), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), original);
});
