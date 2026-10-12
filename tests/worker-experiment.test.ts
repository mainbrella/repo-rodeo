import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { makeWorkerLedger, verifyWorker } from '../src/worker-verifier.ts';
import type { WorkerProbe, WorkerResponse } from '../src/worker-verifier.ts';
import { workerRequest } from '../src/worker-experiment.ts';

const fixture = fileURLToPath(new URL('../fixtures/memory-worker', import.meta.url));
async function start(directory: string) {
  const child = spawn(process.execPath, [join(fixture, 'server.mjs')], {
    cwd: directory, env: { ...process.env, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.on('data', value => {
      stdout += value;
      if (stdout.includes('\n')) resolve(JSON.parse(stdout.trim()).port);
    });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Worker exited before readiness: ${code}`)));
  });
  return { child, preview: { url: `http://127.0.0.1:${port}` } };
}
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
}

for (const candidate of ['baseline', 'correct', 'misleading'] as const) {
  test(`local worker ${candidate} control loads a patch without losing its pending reproduction`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'rodeo-worker-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await cp(join(fixture, 'processor.mjs'), join(directory, 'processor.mjs'));
    const { child, preview } = await start(directory);
    t.after(() => stop(child));
    const ledger = makeWorkerLedger(12345, 'local-test');
    const before = await workerRequest<WorkerProbe>(preview, '/prepare', { preparationId: ledger.preparationId, jobs: ledger.jobs });
    assert.equal(before.pending, 5);
    assert.equal(before.inputFingerprint, ledger.fingerprint);
    await assert.rejects(workerRequest(preview, '/prepare', { preparationId: ledger.preparationId, jobs: ledger.jobs }), /409/);
    if (candidate !== 'baseline') await cp(join(fixture, `${candidate}.mjs`), join(directory, 'processor.mjs'));
    const after = await workerRequest<WorkerResponse>(preview, '/resume', {});
    const verification = verifyWorker(ledger, before, after);
    assert.equal(after.pid, before.pid);
    assert.equal(after.nonce, before.nonce);
    assert.equal(after.claimedCompleted, true);
    assert.equal(verification.status, candidate === 'correct' ? 'passed' : 'rejected');
    assert.equal(verification.actualCount, candidate === 'correct' ? 5 : candidate === 'baseline' ? 3 : 0);
    await assert.rejects(workerRequest(preview, '/resume', {}), /409/);
  });
}

test('a correct patch after a cold restart is classified as reproduction lost, never fixed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rodeo-worker-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(fixture, 'processor.mjs'), join(directory, 'processor.mjs'));
  const warm = await start(directory);
  t.after(() => stop(warm.child));
  const ledger = makeWorkerLedger(12346, 'volatile-inputs');
  const prepared = await workerRequest<WorkerProbe>(warm.preview, '/prepare', { preparationId: ledger.preparationId, jobs: ledger.jobs });
  await stop(warm.child);
  await cp(join(fixture, 'correct.mjs'), join(directory, 'processor.mjs'));
  const cold = await start(directory);
  t.after(() => stop(cold.child));
  const before = await workerRequest<WorkerProbe>(cold.preview, '/probe');
  const after = await workerRequest<WorkerResponse>(cold.preview, '/resume', {});
  assert.notEqual(before.nonce, prepared.nonce);
  assert.equal(before.pending, 0);
  assert.equal(before.preparationId, null);
  assert.equal(after.claimedCompleted, true);
  assert.equal(verifyWorker(ledger, before, after).status, 'reproduction-lost');
});

test('outside verifier rejects duplicate, extra and wrong-valued receipts despite a completed claim', () => {
  const ledger = makeWorkerLedger(12347, 'verifier-test');
  const before: WorkerProbe = { nonce: 'nonce', pid: 123, node: '22.22.2', preparationId: ledger.preparationId,
    phase: 'paused', pending: 5, outputCount: 0, marker: null, inputFingerprint: ledger.fingerprint, stateFingerprint: 'fingerprint' };
  const after: WorkerResponse = { ...before, phase: 'completed', pending: 0, claimedCompleted: true, outputCount: 5, outputs: ledger.expected };
  assert.equal(verifyWorker(ledger, before, after).status, 'passed');
  const duplicate = verifyWorker(ledger, before, { ...after, outputs: [...after.outputs, after.outputs[0]] });
  assert.equal(duplicate.status, 'rejected');
  assert.deepEqual(duplicate.duplicateIds, [after.outputs[0].id]);
  const wrong = after.outputs.map((output, index) => ({ ...output, totalCents: output.totalCents + Number(index === 0) }));
  assert.equal(verifyWorker(ledger, before, { ...after, outputs: wrong }).status, 'rejected');
  assert.equal(verifyWorker(ledger, before, { ...after, outputs: [...after.outputs, { id: 'extra', totalCents: 0 }] }).status, 'rejected');
  assert.equal(verifyWorker(ledger, before, { ...after, nonce: 'restarted' }).status, 'reproduction-lost');
});
