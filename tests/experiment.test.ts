import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { prepareSource } from '../src/experiment-source.ts';
import { readScenario } from '../src/scenario.ts';
import { sha256 } from '../src/evidence.ts';
import { redact } from '../src/experiment-result.ts';
import { exportObservations } from '../src/public-evidence.ts';
import { checkCapacity } from '../src/provider-runner.ts';
import type { Inventory, WorkspaceUsage } from '../src/providers/interface.ts';

const repository = resolve(import.meta.dirname, '..');
async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rodeo-provider-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test('bundled source archive and retained patches match the expected candidate source', async t => {
  const directory = await temporary(t);
  const scenario = await readScenario(join(repository, 'fixtures/editor/scenario.json'));
  const source = await prepareSource({ repository, inputs: repository, directory, scenario });
  assert.equal(source.kind, 'standalone');
  assert.equal(source.hashes['editor.js'], sha256(await readFile(join(repository, 'fixtures/editor/app/editor.js'))));
  assert.notEqual(source.patches.correct?.hashes['editor.js'], source.hashes['editor.js']);
  assert.notEqual(source.patches.misleading?.hashes['editor.js'], source.hashes['editor.js']);
  assert.equal(source.patches.baseline, null);
  assert.deepEqual(Object.keys(source.hashes), ['editor.css', 'editor.js', 'index.html', 'server.mjs']);
});

test('web source uses a pinned tree, excludes untracked secrets, and rejects tracked env files', async t => {
  const directory = await temporary(t);
  const checkout = join(directory, 'web');
  await mkdir(join(checkout, 'src'), { recursive: true });
  // Valid patch context, independent of the sibling MainBrella checkout.
  const baseline = `function save() {
  // Intentional fixture bug: position 0 is false, so the first positioned block is discarded.
  const serialized: SavedBlock[] = blocks.map((block, position) => ({ ...block, position }))
    .filter(block => block.position);
  try {
    localStorage.setItem(storageKey, JSON.stringify(serialized));
    setStatus('Saved');
  } catch {
    setStatus('Could not save in this browser. Check storage settings.', true);
  }
}
`;
  await writeFile(join(checkout, 'src/repo-rodeo-bug.ts'), `}\n\n${baseline}`);
  await writeFile(join(checkout, 'package-lock.json'), '{}');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  await writeFile(join(checkout, '.env'), 'TOKEN=untracked-secret');
  await writeFile(join(checkout, 'src/repo-rodeo-bug.ts'), 'dirty user changes');
  const output = join(directory, 'run'); await mkdir(output);
  const scenario = await readScenario(join(repository, 'fixtures/editor/scenario.json'));
  const source = await prepareSource({ repository, inputs: repository, directory: output, scenario, source: checkout, sourceRef: commit });
  assert.equal(source.commit, commit);
  assert.equal(source.hashes['.env'], undefined);
  assert.equal(await readFile(join(output, 'source/src/repo-rodeo-bug.ts'), 'utf8'), `}\n\n${baseline}`);
  assert.equal(await readFile(join(checkout, 'src/repo-rodeo-bug.ts'), 'utf8'), 'dirty user changes');
  git('add', '-f', '.env'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'unsafe fixture');
  const next = join(directory, 'next'); await mkdir(next);
  await assert.rejects(prepareSource({ repository, inputs: repository, directory: next, scenario, source: checkout }), /environment file/);
});

test('budget preflight checks full disk reservations and preserves exhausted accounts', () => {
  const inventory: Inventory & { workspaceUsage: WorkspaceUsage } = {
    sandboxes: [], activeContainers: 0, containerLimits: { maxContainers: 4 }, workspaces: [],
    workspaceUsage: { saved: 0, reservedBytes: 0, savesThisMonth: 2, captureBytesThisMonth: 16e9, retainedCaptureBytes: 16e9 },
    workspaceLimits: { maxSaved: 20, maxReservedBytes: 160e9, maxSavesPerMonth: 100, maxCaptureBytesPerMonth: 24e9, maxRetainedCaptureBytes: 24e9 },
  };
  checkCapacity(inventory, 8e9);
  inventory.workspaceUsage.retainedCaptureBytes++;
  assert.throws(() => checkCapacity(inventory, 8e9), /quota preflight/);
  inventory.workspaceUsage.retainedCaptureBytes--;
  inventory.workspaceUsage.saved = 100;
  assert.throws(() => checkCapacity(inventory, 8e9), /quota preflight/);
  inventory.workspaceUsage.saved = 0;
  inventory.containerLimits = { maxContainers: 3 };
  assert.throws(() => checkCapacity(inventory, 8e9), /four additional/);
  inventory.workspaceLimits!.maxRetainedCaptureBytes = Number.NaN;
  assert.throws(() => checkCapacity(inventory, 8e9), /incomplete or invalid/);
  assert.throws(() => checkCapacity(inventory, Number.NaN), /incomplete or invalid/);
});

test('public export allowlists observations and strips URLs, credentials and unknown fields', async t => {
  const directory = await temporary(t);
  const privateDirectory = join(directory, 'private');
  await mkdir(join(privateDirectory, 'baseline'), { recursive: true });
  const input = { schemaVersion: 1, caseId: 'holdout', seed: 12345, browserVersion: '1.2.3', runtimeErrors: [],
    secret: 'never-copy-this', preview: 'https://bearer.example.test', observations: [{
      expected: [{ id: 'button', text: 'token=secret-sentinel https://bearer.example.test' }], beforeSave: [], afterSave: [], actual: [], reload: 'refresh',
      accessToken: 'also-never-copy',
    }] };
  await writeFile(join(privateDirectory, 'baseline/document.json'), JSON.stringify(input));
  const files = await exportObservations(privateDirectory, join(directory, 'observations'), [{ id: 'baseline', expected: 'reproduced',
    sourceHashes: {}, patchSha256: null, verification: { status: 'reproduced', reason: 'fixture', browserVersion: '1.2.3', verifiedExpectedFailure: true,
      tests: [{ id: 'holdout', status: 'failed', observations: 1, evidence: 'document.json' }] } }], ['secret-sentinel']);
  const exported = await readFile(join(directory, 'observations/baseline/holdout.json'), 'utf8');
  assert.equal(files['baseline/holdout.json'], sha256(exported));
  assert.doesNotMatch(exported, /never-copy|secret-sentinel|https:|accessToken/);
  assert.match(exported, /redacted/);
  assert.equal(redact('mb_secret Bearer abc https://private.test/foo'), '[redacted-key] Bearer [redacted] [redacted-url]');
});

for (const provider of ['e2b', 'daytona'] as const) test(`${provider} CLI requires its own host credential and selects its provider defaults`, async t => {
  const directory = join(await temporary(t), `${provider}-run`);
  const env = { ...process.env, MAINBRELLA_API_KEY: 'mb_do-not-use', E2B_API_KEY: '', DAYTONA_API_KEY: '' };
  const proc = spawnSync(process.execPath, ['src/experiment.ts', '--provider', provider, '--output', directory, '--seed', '12345'], {
    cwd: repository, env, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(proc.status, 1);
  const text = await readFile(join(directory, 'result.json'), 'utf8');
  const result = JSON.parse(text);
  assert.equal(result.provider, provider);
  assert.equal(result.mode, provider === 'e2b' ? 'memory-fork' : 'saved-workspace');
  assert.equal(result.status, 'failed');
  assert.equal(result.scope, 'not-run');
  assert.match(result.errors.join(' '), new RegExp(`Set ${provider === 'e2b' ? 'E2B' : 'DAYTONA'}_API_KEY`));
  assert.equal(result.environment.requested.size, provider === 'e2b' ? 'base' : 'default');
  assert.doesNotMatch(text, /mb_do-not-use/);
  const retry = spawnSync(process.execPath, ['src/experiment.ts', '--provider', provider, '--output', directory], { cwd: repository, env, encoding: 'utf8' });
  assert.equal(retry.status, 1);
  assert.equal(await readFile(join(directory, 'result.json'), 'utf8'), text);
});
