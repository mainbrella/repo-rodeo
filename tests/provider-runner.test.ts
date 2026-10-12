import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runProvider } from '../src/provider-runner.ts';
import { hashFiles } from '../src/evidence.ts';
import type { Capabilities, Execution, Inventory, ProviderAdapter } from '../src/providers/interface.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rodeo-runner-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: string[] = [];
  const hashes = await hashFiles(resolve(import.meta.dirname, '../fixtures/editor/app'));
  const caps: Capabilities = { apiVersion: 'fixture', resources: [{ id: 'small', diskGB: 8, cpuVcpu: 0.5, memoryMiB: 4096 }],
    previews: true, managedJobs: true, jobReattachment: true,
    modes: {
      'saved-workspace': { status: 'supported', reason: 'fixture' },
      'filesystem-fork': { status: 'unsupported', reason: 'fixture' }, 'memory-fork': { status: 'unsupported', reason: 'fixture' },
      volume: { status: 'unsupported', reason: 'fixture' }, 'warm-pool': { status: 'unsupported', reason: 'fixture' },
    } };
  const inventory: Inventory = { activeContainers: 0, sandboxes: [], containerLimits: { maxContainers: 4 }, workspaces: [],
    workspaceLimits: { maxSaved: 20, maxReservedBytes: 160e9, maxSavesPerMonth: 100, maxCaptureBytesPerMonth: 400e9, maxRetainedCaptureBytes: 400e9 },
    workspaceUsage: { saved: 0, reservedBytes: 0, savesThisMonth: 0, captureBytesThisMonth: 0, retainedCaptureBytes: 0 } };
  const completed: Execution = { id: 'job', status: 'succeeded', exitCode: 0, timedOut: false, outputTruncated: false, stdout: '', stderr: '', cursor: 0 };
  let cleaned = false;
  let cleanupConfirmed = true;
  const adapter: ProviderAdapter = {
    name: 'mainbrella', capabilities: async () => caps, inventory: async () => inventory,
    create: async () => { calls.push('create'); return { sandbox: { id: 'owned', generation: 'generation' },
      receipt: { operationId: 'create', requestedAt: '', completedAt: '', rawEvidencePath: '' } }; },
    upload: async () => { calls.push('upload'); },
    execute: async (_sandbox, request) => {
      calls.push(request.name);
      let stdout = '';
      if (request.name === 'guest-tools') stdout = JSON.stringify({ node: '24.21.0', npm: '11.19.0' });
      if (request.name.includes('-ready-')) stdout = JSON.stringify({ hashes, dependencyHash: null, prepared: 'fixture', mode: 493, link: '/workspace/rodeo-prepared', branchMarker: null,
        process: { nonce: 'source-process', pid: 10, serverReachable: true, observedAt: '' } });
      return { ...completed, stdout };
    },
    startJob: async () => { throw new Error('unexpected job'); }, getJob: async () => { throw new Error('unexpected poll'); },
    readEvents: async () => { throw new Error('unexpected event stream'); },
    capture: async () => { calls.push('capture'); throw new Error('unexpected capture'); },
    spawn: async () => { calls.push('spawn'); throw new Error('unexpected spawn'); },
    preview: async () => ({ id: 'preview', url: 'https://secret-preview.example.test', expiresAt: null }),
    revokePreview: async () => { calls.push('revoke'); },
    cleanup: async () => { calls.push('cleanup'); cleaned = true; return { confirmed: cleanupConfirmed, sandboxes: [], workspaces: [], physicalStorage: 'not-measured', errors: [] }; },
  };
  const services = { adapter: () => adapter,
    previewStatus: async () => cleaned ? 404 : 200,
    verify: async () => ({ status: 'unverified' as const, verifiedExpectedFailure: false, reason: 'Browser unavailable', tests: [], browserVersion: null }),
  };
  const options = { provider: 'mainbrella' as const, mode: 'saved-workspace' as const, seed: 12345,
    output: join(directory, 'run'), apiUrl: 'http://localhost:8787', apiKey: 'private-key-sentinel', size: 'small', checkIdempotency: true };
  return { directory, calls, caps, inventory, adapter, services, options, failCleanup: () => { cleanupConfirmed = false; } };
}

test('unverified prepared baseline stops capture and candidate work but cleans up previews and source', async t => {
  const f = await fixture(t);
  const result = await runProvider(f.options, f.services);
  assert.equal(result.status, 'failed');
  assert.ok(f.calls.includes('create'));
  assert.ok(f.calls.includes('revoke'));
  assert.ok(f.calls.includes('cleanup'));
  assert.ok(!f.calls.includes('capture') && !f.calls.includes('spawn'));
  assert.equal(result.checks.captureIdempotency.status, 'not-exercised');
  assert.equal(result.checks.previewRevocation.status, 'verified');
  assert.equal(result.cleanup?.confirmed, true);
  assert.match(result.errors.join(' '), /Prepared baseline was not verified/);
  const publicResult = await readFile(join(f.options.output, 'result.json'), 'utf8');
  assert.doesNotMatch(publicResult, /private-key-sentinel|secret-preview/);
});

test('quota exhaustion writes a failed result without provisioning or deleting account resources', async t => {
  const f = await fixture(t);
  f.inventory.workspaceUsage.saved = 100;
  const result = await runProvider(f.options, f.services);
  assert.equal(result.status, 'failed');
  assert.deepEqual(f.calls, ['cleanup']);
  assert.match(result.errors.join(' '), /quota preflight/);
  assert.equal(result.storage.before?.saved, 100);
  assert.equal(result.storage.afterCleanup?.saved, 100);
});

test('missing deployed mode is unsupported; incomplete cleanup still prevents success', async t => {
  const f = await fixture(t);
  f.caps.modes['saved-workspace'] = { status: 'unsupported', reason: 'disabled by this deployment' };
  const result = await runProvider(f.options, f.services);
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(f.calls, ['cleanup']);
  assert.deepEqual(result.controls, []);
  f.options.output = join(f.directory, 'second');
  f.failCleanup();
  const failed = await runProvider(f.options, f.services);
  assert.equal(failed.status, 'failed');
});
