import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runProvider } from '../src/provider-runner.ts';
import { MainbrellaAdapter } from '../src/providers/mainbrella.ts';
import { hashFiles, sha256 } from '../src/evidence.ts';
import type { Capabilities, Execution, Inventory, PreparedState, ProviderAdapter, Sandbox } from '../src/providers/interface.ts';

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

async function successfulFixture(t: TestContext, leak?: 'source' | 'marker') {
  const f = await fixture(t);
  const states = new Map<string, { hashes: Record<string, string>; prepared: string; branchMarker: string | null;
    process: { nonce: string | null; pid: number | null; serverReachable: boolean; observedAt: string } }>();
  const baseHashes = await hashFiles(resolve(import.meta.dirname, '../fixtures/editor/app'));
  const completed: Execution = { id: 'job', status: 'succeeded', exitCode: 0, timedOut: false,
    outputTruncated: false, stdout: '', stderr: '', cursor: 0 };
  const receipt = { operationId: 'fixture', requestedAt: '', completedAt: '', rawEvidencePath: '' };
  const source: Sandbox = { id: 'source', generation: 'source-generation' };
  const createState = () => ({ hashes: { ...baseHashes }, prepared: '', branchMarker: null as string | null,
    process: { nonce: null as string | null, pid: null as number | null, serverReachable: false, observedAt: '' } });
  let cleaned = false;
  let captured = false;
  let reconnectClients = 0;
  f.adapter.inventory = async () => structuredClone(f.inventory);
  f.adapter.create = async () => { f.calls.push('create'); states.set(source.id, createState()); return { sandbox: source, receipt }; };
  f.adapter.execute = async (sandbox, request) => {
    f.calls.push(request.name);
    const state = states.get(sandbox.id)!;
    if (request.name === 'guest-tools') return { ...completed, stdout: JSON.stringify({ node: '24.21.0', npm: '11.19.0' }) };
    if (request.name === 'source-markers') state.prepared = request.argv.at(-1)!;
    if (request.name.endsWith('-write-marker')) state.branchMarker = request.argv.at(-1)!;
    if (request.name.endsWith('-patch')) {
      state.hashes = await hashFiles(join(f.options.output, 'private', `source-${sandbox.id}`));
      if (sandbox.id === 'misleading' && leak === 'source') states.get('correct')!.hashes = { ...state.hashes };
      if (sandbox.id === 'misleading' && leak === 'marker') states.get('correct')!.branchMarker = 'misleading';
    }
    if (request.name.endsWith('-launch')) state.process = {
      nonce: `process-${sandbox.id}`, pid: 10 + states.size, serverReachable: true, observedAt: '',
    };
    return { ...completed, stdout: JSON.stringify({ ...state, dependencyHash: null, mode: 493, link: '/workspace/rodeo-prepared' }) };
  };
  f.adapter.capture = async () => {
    f.calls.push('capture');
    if (!captured) {
      captured = true;
      f.inventory.workspaces = [{ id: 'prepared' }];
      f.inventory.workspaceUsage = { saved: 1, reservedBytes: 8e9, savesThisMonth: 1,
        captureBytesThisMonth: 8e9, retainedCaptureBytes: 8e9 };
    }
    return { id: 'prepared', mode: 'saved-workspace', preservation: 'filesystem', source, bytes: 100, receipt };
  };
  f.adapter.spawn = async (_prepared, request) => {
    const id = request.name.replace('-restore', '');
    f.calls.push(`spawn-${id}`);
    states.set(id, { ...createState(), prepared: states.get('source')!.prepared });
    return { sandbox: { id, generation: `${id}-generation` }, receipt };
  };
  f.adapter.preview = async sandbox => ({ id: `preview-${sandbox.id}`, url: `https://secret-preview.example.test/${sandbox.id}`, expiresAt: null });
  f.adapter.startJob = async () => { f.calls.push('reattach-job'); return { ...completed, status: 'running', exitCode: null }; };
  f.adapter.getJob = async () => ({ ...completed, stdout: 'rodeo-reconnect-start\nrodeo-reconnect-done' });
  f.adapter.readEvents = async (_sandbox, _job, cursor) => cursor === 0
    ? { text: 'rodeo-reconnect-start', cursor: 1 } : { text: 'rodeo-reconnect-done', cursor: 2 };
  f.adapter.cleanup = async () => {
    f.calls.push('cleanup'); cleaned = true;
    f.inventory.workspaces = [];
    f.inventory.workspaceUsage = { ...f.inventory.workspaceUsage, saved: 0, reservedBytes: 0 };
    return { confirmed: true, sandboxes: [...states.keys()].map(id => ({ sandbox: {
      id, generation: `${id}-generation`,
    }, absent: true })), workspaces: [{ id: 'prepared', absent: true }], physicalStorage: 'not-measured', errors: [] };
  };
  const services = { adapter: () => { reconnectClients++; return f.adapter; },
    previewStatus: async () => cleaned ? 404 : 200,
    verify: async ({ url }: { url: string }) => {
      f.calls.push(`verify-${new URL(url).pathname.slice(1)}`);
      return { status: url.endsWith('/correct') ? 'passed' as const : 'reproduced' as const,
        verifiedExpectedFailure: !url.endsWith('/correct'), reason: 'Fixture verifier result', tests: [], browserVersion: 'fixture' };
    },
  };
  return { ...f, services, reconnectClients: () => reconnectClients };
}

test('successful runner prepares, restores and verifies three controls, reconnects and seals cleanup evidence', async t => {
  const f = await successfulFixture(t);
  const result = await runProvider(f.options, f.services);
  assert.equal(result.status, 'complete', result.errors.join('\n'));
  assert.equal(result.schemaVersion, 2);
  assert.deepEqual(result.controls.map(control => [control.id, control.verification?.status]), [
    ['baseline', 'reproduced'], ['correct', 'passed'], ['misleading', 'reproduced'],
  ]);
  assert.ok(Object.values(result.checks).every(check => check.status === 'verified'));
  assert.equal(result.source.integrity, true);
  assert.equal(result.cleanup?.confirmed, true);
  assert.equal(result.cleanup?.sandboxes.length, 4);
  assert.equal(result.storage.afterCleanup?.saved, 0);
  assert.equal(result.storage.afterCleanup?.reservedBytes, 0);
  assert.equal(f.calls.filter(call => call === 'capture').length, 2);
  assert.equal(f.reconnectClients(), 2);
  for (const id of ['baseline', 'correct', 'misleading']) {
    assert.ok(f.calls.includes(`spawn-${id}`));
    assert.ok(f.calls.includes(`${id}-after-tests`));
    assert.ok(f.calls.includes(`${id}-isolation`));
    assert.ok(f.calls.includes(`verify-${id}`));
  }
  const publicResult = await readFile(join(f.options.output, 'result.json'));
  assert.doesNotMatch(publicResult.toString(), /private-key-sentinel|secret-preview/);
  assert.match(await readFile(join(f.options.output, 'result.sha256'), 'utf8'), new RegExp(`^${sha256(publicResult)}  result.json`));
  for (const [file, digest] of Object.entries(result.evidence.files)) {
    assert.equal(sha256(await readFile(join(f.options.output, 'private', file))), digest, file);
  }
});

for (const leak of ['source', 'marker'] as const) {
  test(`final isolation rejects a later branch changing an earlier branch's ${leak}`, async t => {
    const f = await successfulFixture(t, leak);
    const result = await runProvider(f.options, f.services);
    assert.equal(result.status, 'failed');
    assert.equal(result.checks.isolation.status, 'failed');
    assert.equal(result.controls.length, 3);
    assert.equal(result.cleanup?.confirmed, true);
    assert.match(result.errors.join(' '), leak === 'source' ? /Later branch writes changed correct's source/ : /Branch marker leaked/);
  });
}

test('tracked Mainbrella adapter completes the runner through an API fixture with capture response loss and recovery', async t => {
  const f = await successfulFixture(t);
  const executions = new Map<string, Execution>();
  const previewUrls = new Map<string, string>();
  const revoked = new Set<string>();
  let prepared: PreparedState | undefined;
  const calls: string[] = [];
  const reply = (data: unknown, status = 200) => Response.json(data, { status });
  const sandboxFor = (url: URL): Sandbox => ({ id: url.searchParams.get('id')!, generation: url.searchParams.get('createdAt')! });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    calls.push(`${method} ${path}`);
    if (path === '/api-keys/me') return reply({ accountId: 'fixture-account' });
    if (path === '/capabilities') return reply({ apiVersion: 'fixture', resources: f.caps.resources,
      persistence: { snapshots: true, workspaces: true }, previews: { supported: true }, execution: { background: true, reconnect: true } });
    if (method === 'GET' && path === '/containers') return reply({ containers: f.inventory.sandboxes.map(sandbox => ({
      id: sandbox.id, createdAt: sandbox.generation, status: 'running',
    })), limits: f.inventory.containerLimits });
    if (method === 'GET' && path === '/workspaces') return reply({
      workspaces: f.inventory.workspaces, usage: f.inventory.workspaceUsage, limits: f.inventory.workspaceLimits,
    });
    const ops = join(f.options.output, 'private', 'operations');
    const records = await Promise.all((await readdir(ops)).filter(file => file.endsWith('.json'))
      .map(async file => JSON.parse(await readFile(join(ops, file), 'utf8'))));
    const key = new Headers(init?.headers).get('Idempotency-Key');
    const saved = records.find(record => record.method === method && record.path === `${path}${url.search}` && (!key || record.key === key));
    assert.ok(saved, 'The adapter must persist every request before submission');
    const op = { name: saved.name, timeoutMs: 60000 };
    const body = init?.body && method === 'POST' ? JSON.parse(String(init.body)) : {};
    if (method === 'POST' && path === '/containers') {
      if (body.workspaceId) assert.equal(body.workspaceId, prepared?.id);
      const created = body.workspaceId
        ? await f.adapter.spawn(prepared!, op)
        : await f.adapter.create({ ...op, image: body.catalogId, size: body.size });
      f.inventory.sandboxes.push(created.sandbox);
      const container = { id: created.sandbox.id, createdAt: created.sandbox.generation, status: 'running' };
      return reply({ creation: { containerId: container.id, createdAt: container.createdAt, status: container.status }, containers: [container] });
    }
    if (method === 'PUT' && path === '/containers/files/transfer') {
      const recordBytes = await readFile(saved.upload.file);
      assert.deepEqual(recordBytes, Buffer.from(init!.body as Uint8Array));
      return reply({});
    }
    if (method === 'POST' && path === '/workspaces') {
      prepared = await f.adapter.capture({ id: body.id, generation: body.createdAt }, { ...op, mode: 'saved-workspace' });
      return reply({ workspace: { id: prepared.id, bytes: prepared.bytes } }, 201);
    }
    if (method === 'POST' && path === '/containers/executions') {
      const id = `job-${executions.size + 1}`;
      const result = op.name === 'reattach-job' ? await f.adapter.getJob(sandboxFor(url), id)
        : await f.adapter.execute(sandboxFor(url), { ...op, ...body });
      executions.set(id, { ...result, id });
      return reply({ id, status: 'queued' }, 202);
    }
    if (method === 'GET' && /\/executions\/[^/]+$/.test(path)) return reply(executions.get(path.split('/').at(-1)!));
    if (method === 'GET' && path.endsWith('/events')) {
      const event = await f.adapter.readEvents(sandboxFor(url), path.split('/').at(-2)!, Number(url.searchParams.get('cursor')));
      return new Response(`id: ${event.cursor}\nevent: stdout\ndata: ${JSON.stringify({ data: event.text })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (method === 'POST' && path === '/containers/previews') {
      const preview = await f.adapter.preview(sandboxFor(url), { ...op, port: body.port });
      previewUrls.set(preview.id, preview.url);
      return reply(preview);
    }
    if (method === 'DELETE' && path === '/containers/previews') { revoked.add(previewUrls.get(url.searchParams.get('previewId')!)!); return reply({}); }
    if (method === 'DELETE' && path.startsWith('/workspaces/')) {
      f.inventory.workspaces = [];
      f.inventory.workspaceUsage = { ...f.inventory.workspaceUsage, saved: 0, reservedBytes: 0 };
      return reply({});
    }
    if (method === 'DELETE' && path === '/containers') {
      f.inventory.sandboxes = f.inventory.sandboxes.filter(sandbox => sandbox.id !== url.searchParams.get('id') || sandbox.generation !== url.searchParams.get('createdAt'));
      return reply({});
    }
    throw new Error(`Unexpected fixture request ${method} ${path}`);
  };
  const result = await runProvider(f.options, { ...f.services,
    adapter: options => new MainbrellaAdapter({ ...options, fetch: fetcher, pollIntervalMs: 0 }),
    previewStatus: async url => revoked.has(url) ? 404 : 200,
  });
  assert.equal(result.status, 'complete', result.errors.join('\n'));
  assert.ok(Object.values(result.checks).every(check => check.status === 'verified'));
  assert.equal(result.cleanup?.sandboxes.length, 4);
  assert.equal(result.cleanup?.confirmed, true);
  assert.deepEqual(f.inventory.sandboxes, []);
  assert.deepEqual(f.inventory.workspaces, []);
  assert.equal(calls.filter(call => call === 'POST /workspaces').length, 3);
  assert.ok(calls.filter(call => call === 'GET /api-keys/me').length >= 3);
  const ops = join(f.options.output, 'private', 'operations');
  const records = await Promise.all((await readdir(ops)).filter(file => file.endsWith('.json'))
    .map(async file => JSON.parse(await readFile(join(ops, file), 'utf8'))));
  const capture = records.find(record => record.name === 'prepared-capture');
  assert.equal(capture.responseLostAfterHeaders, true);
  assert.equal(capture.attempts, 3);
});
