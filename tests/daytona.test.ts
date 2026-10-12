import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { type Daytona } from '@daytona/sdk';
import { DaytonaAdapter } from '../src/providers/daytona.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rodeo-daytona-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const machines = new Map<string, any>();
  const snapshots = new Map<string, any>();
  const commands = new Map<string, { stdout: string; stderr: string; exitCode?: number }>();
  const calls: { method: string; options?: any }[] = [];
  let counter = 0;
  let ambiguousCreate = false;
  let timeoutStatus = false;
  let disabledSnapshot = false;
  let ambiguousSnapshot = false;
  let delayedSnapshot = true;
  let permissions: unknown = ['write:sandboxes', 'delete:sandboxes', 'write:snapshots', 'delete:snapshots'];
  let metadataStatus = 200;
  let retainDeleted = false;
  let staleDeleted: any;
  let staleReads = 0;
  const client = (id: string, name: string, labels: Record<string, string> = {}): any => ({
    id, name, labels, state: 'started', public: false, sandboxClass: 'container', cpu: 1, memory: 1, disk: 3,
    refreshData: async () => {}, setTtl: async (minutes: number) => { calls.push({ method: 'ttl', options: { id, minutes } }); },
    stop: async (timeout: number) => { calls.push({ method: 'stop', options: { id, timeout } }); machines.get(id).state = 'stopped'; },
    getPreviewLink: async (port: number) => ({ url: `https://${port}-${id}.proxy.daytona.work`, token: `traffic-secret-${id}` }),
    fs: { createFolder: async () => {}, uploadFile: async (file: string, path: string) => {
      calls.push({ method: 'upload', options: { path, bytes: await readFile(file) } });
    } },
    process: {
      executeCommand: async (command: string, cwd: string, env: unknown, timeout: number) => {
        calls.push({ method: 'command', options: { command, cwd, env, timeout } }); return { exitCode: 0, result: 'ok' };
      },
      createSession: async (session: string) => { calls.push({ method: 'session', options: session }); },
      executeSessionCommand: async (session: string, request: unknown) => {
        calls.push({ method: 'job', options: request }); commands.set(session, { stdout: 'start-🐎\n', stderr: '' }); return { cmdId: 'command-1' };
      },
      getSessionCommand: async (session: string) => ({ id: 'command-1', exitCode: commands.get(session)!.exitCode }),
      getSessionCommandLogs: async (session: string) => commands.get(session),
    },
    createSnapshot: async (name: string) => {
      calls.push({ method: 'snapshot', options: { id, name } });
      if (disabledSnapshot) throw Object.assign(new Error('snapshot disabled'), { statusCode: 403 });
      snapshots.set('snapshot-1', { id: 'snapshot-1', name, state: ambiguousSnapshot && delayedSnapshot ? 'snapshotting' : 'active' });
      if (ambiguousSnapshot) throw new Error('snapshot response lost');
    },
  });
  machines.set('unrelated', client('unrelated', 'user-sandbox'));
  snapshots.set('unrelated-snapshot', { id: 'unrelated-snapshot', name: 'user-snapshot' });
  const sdk = {
    list: async function* () { yield* machines.values(); if (staleDeleted && staleReads++ < 1) yield staleDeleted; },
    create: async (options: any, timeout: any) => {
      calls.push({ method: 'create', options: { ...options, ...timeout } });
      const id = `owned-${++counter}`;
      const sandbox = client(id, options.name, options.labels); machines.set(id, sandbox);
      if (ambiguousCreate) throw Object.assign(new Error('lost response'), timeoutStatus ? { statusCode: 408 } : {});
      return sandbox;
    },
    get: async (id: string) => machines.get(id),
    stop: async (sandbox: any) => { calls.push({ method: 'stop', options: sandbox.id }); sandbox.state = 'stopped'; },
    start: async (sandbox: any) => { calls.push({ method: 'start', options: sandbox.id }); sandbox.state = 'started'; },
    delete: async (sandbox: any) => {
      calls.push({ method: 'delete', options: sandbox.id });
      if (retainDeleted) staleDeleted = sandbox;
      machines.delete(sandbox.id);
    },
    snapshot: {
      list: async ({ page }: { page: number }) => ({ items: [...snapshots.values()].slice(page - 1, page), totalPages: snapshots.size }),
      get: async (name: string) => {
        calls.push({ method: 'getSnapshot', options: name });
        const snapshot = [...snapshots.values()].find(s => s.name === name);
        if (!snapshot) throw Object.assign(new Error('not found'), { statusCode: 404 });
        return snapshot;
      },
      delete: async (id: string) => { calls.push({ method: 'deleteSnapshot', options: id }); snapshots.delete(id); },
    },
  } as unknown as Daytona;
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/api-keys/current') {
      calls.push({ method: 'permissions' });
      return Response.json({ permissions, value: 'metadata-secret-must-not-be-recorded' }, { status: metadataStatus });
    }
    if (path.startsWith('/api/snapshots/')) {
      try { return Response.json(await sdk.snapshot.get(decodeURIComponent(path.slice('/api/snapshots/'.length)))); }
      catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status) return Response.json({}, { status });
        throw error;
      }
    }
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const id = decodeURIComponent(path.split('/')[3]);
    const { name } = JSON.parse(String(init?.body));
    try { await machines.get(id).createSnapshot(name); }
    catch (error) {
      if ((error as { statusCode?: number }).statusCode) return Response.json({}, { status: (error as { statusCode: number }).statusCode });
      throw error;
    }
    return Response.json({});
  };
  const options = { apiUrl: 'https://app.daytona.io/api', apiKey: 'daytona-test-private-key', directory, sdk, fetch: request };
  const adapter = new DaytonaAdapter(options);
  return { directory, options, adapter, calls, machines, snapshots, commands,
    ambiguousCreate: (http408 = false) => { ambiguousCreate = true; timeoutStatus = http408; },
    ambiguousSnapshot: (delayed = true) => { ambiguousSnapshot = true; delayedSnapshot = delayed; },
    permissions: (value: unknown) => { permissions = value; },
    metadataStatus: (value: number) => { metadataStatus = value; },
    staleDeletion: () => { retainDeleted = true; },
    disabledSnapshot: () => { disabledSnapshot = true; } };
}
const create = { name: 'source-create', timeoutMs: 5000, image: 'default', size: 'default' };

test('Daytona capabilities keep container snapshots separate from VM forks', async t => {
  const f = await fixture(t);
  const caps = await f.adapter.capabilities();
  assert.equal(caps.modes['saved-workspace'].status, 'supported');
  assert.equal(caps.modes['filesystem-fork'].status, 'unsupported');
  assert.equal(caps.modes['memory-fork'].status, 'not-implemented');
  const { sandbox } = await f.adapter.create(create);
  await assert.rejects(f.adapter.capture(sandbox, { name: 'fork', timeoutMs: 1000, mode: 'filesystem-fork' }), /Unsupported/);
  assert.equal(f.calls.filter(c => c.method === 'fork').length, 0);
  assert.equal((await f.adapter.cleanup()).confirmed, true);
});

for (const http408 of [false, true]) test(`uncertain Daytona creation${http408 ? ' with HTTP 408' : ''} is not replayed or falsely confirmed`, async t => {
  const f = await fixture(t); f.ambiguousCreate(http408);
  await assert.rejects(f.adapter.create(create), /Daytona create failed/);
  await assert.rejects(new DaytonaAdapter(f.options).create(create), /already attempted/);
  assert.equal(f.calls.filter(c => c.method === 'create').length, 1);
  const cleanup = await f.adapter.cleanup();
  assert.equal(cleanup.confirmed, false);
  assert.match(cleanup.errors.join(' '), /remains uncertain/);
  assert.deepEqual([...f.machines.keys()], ['unrelated']);
});

test('Daytona cleanup rejects a different credential before deletion', async t => {
  const f = await fixture(t); await f.adapter.create(create);
  const count = f.calls.length;
  assert.equal((await new DaytonaAdapter({ ...f.options, apiKey: 'other-team' }).cleanup()).confirmed, false);
  assert.equal(f.calls.length, count);
  assert.equal((await f.adapter.cleanup()).confirmed, true);
});

test('Daytona refuses provisioning when either snapshot scope is missing', async t => {
  for (const missing of ['write:snapshots', 'delete:snapshots']) {
    const f = await fixture(t);
    f.permissions(['write:sandboxes', 'delete:sandboxes', ...['write:snapshots', 'delete:snapshots'].filter(p => p !== missing)]);
    await assert.rejects(f.adapter.create(create), new RegExp(missing));
    assert.equal(f.calls.filter(c => c.method === 'create').length, 0);
    assert.deepEqual(await readdir(join(f.directory, 'operations')), []);
    const receipt = (await readdir(join(f.directory, 'receipts'))).find(name => name.startsWith('permissions-'))!;
    assert.doesNotMatch(await readFile(join(f.directory, 'receipts', receipt), 'utf8'), /metadata-secret|daytona-test-private-key/);
    // Cleanup remains usable with restricted scopes; it never runs provisioning preflight.
    assert.equal((await f.adapter.cleanup()).confirmed, true);
  }
});

test('Daytona permission preflight fails closed on unavailable or malformed metadata', async t => {
  for (const failure of ['unavailable', 'malformed']) {
    const f = await fixture(t);
    if (failure === 'unavailable') f.metadataStatus(403); else f.permissions(null);
    await assert.rejects(f.adapter.create(create), /permission preflight/);
    assert.equal(f.calls.some(c => c.method === 'create'), false);
  }
});

test('Daytona saved workspace uses one persistent snapshot, paginates inventory and deletes only its checkpoint', async t => {
  const f = await fixture(t); const { sandbox } = await f.adapter.create(create);
  const op = { name: 'capture', timeoutMs: 1000, mode: 'saved-workspace' as const };
  const prepared = await f.adapter.capture(sandbox, op);
  assert.equal((await f.adapter.capture(sandbox, op)).id, prepared.id);
  assert.equal(prepared.preservation, 'filesystem'); assert.equal(prepared.id, 'snapshot-1');
  assert.equal(f.calls.filter(c => c.method === 'snapshot').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'start').length, 1);
  const branch = await f.adapter.spawn(prepared, { name: 'restore', timeoutMs: 1000 });
  const preview = await f.adapter.preview(branch.sandbox, { name: 'preview', timeoutMs: 1000, port: 5173 });
  assert.equal(preview.headers?.['x-daytona-preview-token'], `traffic-secret-${branch.sandbox.id}`);
  f.machines.get(branch.sandbox.id).public = true;
  await assert.rejects(f.adapter.preview(branch.sandbox, { name: 'public', timeoutMs: 1000, port: 5173 }), /not protected/);
  const source = f.calls.find(c => c.method === 'create')!.options;
  assert.equal(source.ttlMinutes, 30); assert.equal(source.public, false);
  assert.equal(f.calls.filter(c => c.method === 'create').at(-1)!.options.snapshot, prepared.id);
  assert.equal((await f.adapter.inventory()).workspaces.length, 2);
  const cleanup = await f.adapter.cleanup();
  assert.equal(cleanup.confirmed, true);
  assert.deepEqual(cleanup.workspaces, [{ id: 'snapshot-1', absent: true }]);
  assert.deepEqual([...f.snapshots.keys()], ['unrelated-snapshot']);
});

test('disabled Daytona snapshots fail explicitly without a substituted fork', async t => {
  const f = await fixture(t); const { sandbox } = await f.adapter.create(create); f.disabledSnapshot();
  await assert.rejects(f.adapter.capture(sandbox, { name: 'capture', timeoutMs: 1000, mode: 'saved-workspace' }), /HTTP 403/);
  assert.equal(f.calls.filter(c => c.method === 'fork').length, 0);
  assert.equal((await f.adapter.cleanup()).confirmed, true);
});

test('Daytona argv is quoted, PATH is pinned, and a fresh client recovers a session with a byte cursor', async t => {
  const f = await fixture(t); const { sandbox } = await f.adapter.create(create);
  await f.adapter.execute(sandbox, { name: 'quote', timeoutMs: 1000, argv: ['node', '-e', "console.log(\"it's $(private)\")"] });
  const command = f.calls.find(c => c.method === 'command')!.options;
  assert.match(command.command, /^'sudo' '-n' '\/usr\/bin\/env' 'PATH=\/opt\/rodeo-node\/bin:/);
  assert.ok(command.command.includes("'\\''")); assert.ok(command.command.includes('$(private)'));
  assert.equal(command.timeout, 1);
  const job = await f.adapter.startJob(sandbox, { name: 'job', timeoutMs: 1000, cwd: '/workspace/path with spaces', argv: ['node', '-e', 'script'], env: { EXAMPLE: 'a b' } });
  const first = await f.adapter.readEvents(sandbox, job.id, 0, 'start');
  assert.equal(first.cursor, Buffer.byteLength('start-🐎\n'));
  const session = [...f.commands.values()][0]; session.stdout += 'done\n'; session.exitCode = 0;
  const next = new DaytonaAdapter(f.options);
  const done = await next.getJob(sandbox, job.id);
  assert.equal(done.id, job.id); assert.equal(done.exitCode, 0);
  assert.equal((await next.readEvents(sandbox, job.id, first.cursor)).text, 'done\n');
  await assert.rejects(next.readEvents(sandbox, job.id, -1), /Invalid Daytona/);
  assert.match(f.calls.find(c => c.method === 'job')!.options.command, /^cd '\/workspace\/path with spaces' && /);
  assert.match(f.calls.find(c => c.method === 'job')!.options.command, /'timeout' '--signal=TERM' '--kill-after=5' '1'/);
  session.exitCode = 124;
  assert.equal((await next.getJob(sandbox, job.id)).timedOut, true);
  assert.equal((await next.cleanup()).confirmed, true);
});

test('uncertain Daytona snapshot is discovered by its exact persisted name and never replayed', async t => {
  const f = await fixture(t); const { sandbox } = await f.adapter.create(create); f.ambiguousSnapshot();
  const op = { name: 'capture', timeoutMs: 1000, mode: 'saved-workspace' as const };
  await assert.rejects(f.adapter.capture(sandbox, op), /Daytona snapshot failed/);
  f.snapshots.get('snapshot-1').state = 'active';
  await assert.rejects(new DaytonaAdapter(f.options).capture(sandbox, op), /already attempted/);
  assert.equal(f.calls.filter(c => c.method === 'snapshot').length, 1);
  const cleanup = await f.adapter.cleanup();
  assert.equal(cleanup.confirmed, false); assert.match(cleanup.errors.join(' '), /remains uncertain/);
  assert.equal(cleanup.snapshotObservations?.[0].state, 'active');
  const records = await Promise.all((await readdir(join(f.directory, 'operations'))).map(name => readFile(join(f.directory, 'operations', name), 'utf8').then(JSON.parse)));
  assert.equal(records.find(r => r.kind === 'snapshot').status, 'uncertain');
  assert.equal(f.calls.filter(c => c.method === 'start').length, 0);
  assert.deepEqual(cleanup.workspaces, [{ id: 'snapshot-1', absent: true }]);
  assert.deepEqual([...f.snapshots.keys()], ['unrelated-snapshot']);
});

test('Daytona records acknowledged submission separately from snapshot polling and readiness', async t => {
  const f = await fixture(t); const { sandbox } = await f.adapter.create(create);
  let reads = 0;
  const get = f.options.sdk.snapshot.get.bind(f.options.sdk.snapshot);
  f.options.sdk.snapshot.get = async name => {
    const snapshot = await get(name);
    snapshot.state = ++reads === 1 ? 'snapshotting' : 'active';
    return snapshot;
  };
  await f.adapter.capture(sandbox, { name: 'capture', timeoutMs: 4000, mode: 'saved-workspace' });
  const file = (await readdir(join(f.directory, 'owned'))).find(n => n.startsWith('snapshot-'))!;
  const lifecycle = JSON.parse(await readFile(join(f.directory, 'owned', file), 'utf8'));
  assert.equal(lifecycle.submission, 'acknowledged');
  assert.equal(lifecycle.phase, 'complete');
  assert.equal(lifecycle.observation.state, 'active');
  assert.equal(f.calls.filter(c => c.method === 'snapshot').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'getSnapshot').length, 2);
  assert.equal((await f.adapter.cleanup()).confirmed, true);
});

test('Daytona read failure after snapshot admission stays uncertain rather than rejected', async t => {
  const f = await fixture(t); const { sandbox } = await f.adapter.create(create);
  f.options.sdk.snapshot.get = async () => { throw Object.assign(new Error('access denied'), { statusCode: 403 }); };
  await assert.rejects(f.adapter.capture(sandbox, { name: 'capture', timeoutMs: 1000, mode: 'saved-workspace' }), /Daytona snapshot failed/);
  const records = await Promise.all((await readdir(join(f.directory, 'operations'))).map(name => readFile(join(f.directory, 'operations', name), 'utf8').then(JSON.parse)));
  assert.equal(records.find(r => r.kind === 'snapshot').status, 'uncertain');
  assert.equal(f.calls.some(c => c.method === 'start'), false);
});

test('Daytona can observe an active snapshot after a lost submission response without resubmitting', async t => {
  const f = await fixture(t); const { sandbox } = await f.adapter.create(create); f.ambiguousSnapshot(false);
  const prepared = await f.adapter.capture(sandbox, { name: 'capture', timeoutMs: 1000, mode: 'saved-workspace' });
  assert.equal(prepared.id, 'snapshot-1');
  const file = (await readdir(join(f.directory, 'owned'))).find(n => n.startsWith('snapshot-'))!;
  const lifecycle = JSON.parse(await readFile(join(f.directory, 'owned', file), 'utf8'));
  assert.equal(lifecycle.submission, 'uncertain');
  assert.equal(lifecycle.observation.state, 'active');
  assert.equal(lifecycle.phase, 'complete');
  assert.equal(f.calls.filter(c => c.method === 'snapshot').length, 1);
  assert.equal((await f.adapter.cleanup()).confirmed, true);
});

test('Daytona cleanup waits for deletion to propagate through inventory', async t => {
  const f = await fixture(t); await f.adapter.create(create); f.staleDeletion();
  const cleanup = await f.adapter.cleanup();
  assert.equal(cleanup.confirmed, true);
  assert.equal(cleanup.sandboxes[0].absent, true);
  assert.equal(f.calls.filter(c => c.method === 'delete').length, 1);
  assert.deepEqual([...f.machines.keys()], ['unrelated']);
});
