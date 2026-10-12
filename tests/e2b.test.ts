import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Sandbox as CloudSandbox } from 'e2b';
import { E2BAdapter } from '../src/providers/e2b.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rodeo-e2b-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const machines = new Map<string, { sandboxId: string; state: string; metadata: Record<string, string> }>();
  machines.set('unrelated', { sandboxId: 'unrelated', state: 'running', metadata: { owner: 'existing' } });
  const snapshots = new Map<string, { snapshotId: string; names: string[] }>();
  const calls: { method: string; options?: any }[] = [];
  let partialFork = false;
  let ambiguousCreate = false;
  let snapshotDisabled = false;
  let counter = 0;
  const client = (id: string): any => ({
    sandboxId: id, trafficAccessToken: `traffic-secret-${id}`,
    getInfo: async () => ({ sandboxId: id, endAt: new Date(Date.now() + 1800000), network: { allowPublicTraffic: false } }),
    getHost: (port: number) => `${port}-${id}.e2b.app`,
    commands: { run: async (command: string, options: unknown) => { calls.push({ method: 'command', options: { command, options } }); return { exitCode: 0, stdout: 'ok', stderr: '' }; } },
    files: { write: async (path: string, bytes: ArrayBuffer) => { calls.push({ method: 'upload', options: { path, bytes: Buffer.from(bytes) } }); } },
    fork: async (options: unknown) => {
      calls.push({ method: 'fork', options });
      const branches = [];
      for (let n = 0; n < 3; n++) {
        if (partialFork && n === 2) { branches.push(new Error('branch unavailable')); continue; }
        const branch = `branch-${++counter}`;
        machines.set(branch, { sandboxId: branch, state: 'running', metadata: { ...machines.get(id)!.metadata } });
        branches.push(client(branch));
      }
      return branches;
    },
    createSnapshot: async (options: { name: string; mode: string }) => {
      calls.push({ method: 'snapshot', options });
      if (snapshotDisabled) throw Object.assign(new Error('snapshot_filesystem_only_disabled'), { statusCode: 400 });
      const snapshot = { snapshotId: 'snapshot:latest', names: [`project/${options.name}:latest`] };
      snapshots.set(snapshot.snapshotId, snapshot);
      return snapshot;
    },
  });
  const paginator = (items: unknown[]) => {
    let hasNext = true;
    return { get hasNext() { return hasNext; }, nextItems: async () => { hasNext = false; return items; } };
  };
  const sdk = {
    list: () => paginator([...machines.values()]), listSnapshots: () => paginator([...snapshots.values()]),
    create: async (_template: string, options: any) => {
      calls.push({ method: 'create', options });
      const id = `owned-${++counter}`;
      machines.set(id, { sandboxId: id, state: 'running', metadata: options.metadata });
      if (ambiguousCreate) throw new Error('create response lost');
      return client(id);
    },
    connect: async (id: string) => client(id),
    kill: async (id: string) => { calls.push({ method: 'kill', options: { id } }); return machines.delete(id); },
    deleteSnapshot: async (id: string) => { calls.push({ method: 'deleteSnapshot', options: { id } }); return snapshots.delete(id); },
  } as unknown as typeof CloudSandbox;
  const options = { apiUrl: 'https://api.e2b.dev', apiKey: 'e2b-test-private-key', directory, sdk };
  const adapter = new E2BAdapter(options);
  return { directory, adapter, options, calls, machines, snapshots,
    partialFork: () => { partialFork = true; }, ambiguousCreate: () => { ambiguousCreate = true; }, snapshotDisabled: () => { snapshotDisabled = true; } };
}
const create = { name: 'source-create', timeoutMs: 5000, image: 'base', size: 'base' };

test('native E2B capture forks once with explicit lifetime, protects previews and removes only run resources', async t => {
  const f = await fixture(t);
  const { sandbox } = await f.adapter.create(create);
  const op = { name: 'capture', timeoutMs: 5000, mode: 'memory-fork' as const };
  const prepared = await f.adapter.capture(sandbox, op);
  const replay = await f.adapter.capture(sandbox, op);
  assert.equal(replay.id, prepared.id);
  assert.equal(prepared.preservation, 'filesystem+memory');
  assert.equal(f.calls.filter(call => call.method === 'fork').length, 1);
  const fork = f.calls.find(call => call.method === 'fork')!;
  assert.equal(fork.options.count, 3);
  assert.equal(fork.options.timeoutMs, 1800000);
  assert.equal(fork.options.retries, 0);
  const branches = [];
  for (const name of ['baseline', 'correct', 'misleading']) branches.push((await f.adapter.spawn(prepared, { name, timeoutMs: 1000 })).sandbox);
  assert.equal(new Set(branches.map(branch => branch.id)).size, 3);
  const preview = await f.adapter.preview(branches[0], { name: 'preview', timeoutMs: 1000, port: 5173 });
  assert.equal(preview.headers?.['e2b-traffic-access-token'], `traffic-secret-${branches[0].id}`);
  assert.equal((await f.adapter.inventory()).workspaceUsage, null);
  const cleanup = await new E2BAdapter(f.options).cleanup();
  assert.equal(cleanup.confirmed, true);
  assert.equal(cleanup.sandboxes.length, 4);
  assert.deepEqual([...f.machines.keys()], ['unrelated']);
  assert.doesNotMatch(await readFile(join(f.directory, 'e2b-credential.json'), 'utf8'), /e2b-test-private-key/);
});

test('partial E2B fork failure retains all successful identities for confirmed cleanup', async t => {
  const f = await fixture(t);
  const { sandbox } = await f.adapter.create(create);
  f.partialFork();
  await assert.rejects(f.adapter.capture(sandbox, { name: 'capture', timeoutMs: 1000, mode: 'memory-fork' }), /2 of three/);
  const cleanup = await f.adapter.cleanup();
  assert.equal(cleanup.confirmed, true);
  assert.equal(cleanup.sandboxes.length, 3);
  assert.deepEqual([...f.machines.keys()], ['unrelated']);
});

test('ambiguous E2B creation is never reissued and discovered run resources are cleaned without a false confirmation', async t => {
  const f = await fixture(t);
  f.ambiguousCreate();
  await assert.rejects(f.adapter.create(create), /E2B create failed/);
  await assert.rejects(new E2BAdapter(f.options).create(create), /already attempted/);
  assert.equal(f.calls.filter(call => call.method === 'create').length, 1);
  const cleanup = await f.adapter.cleanup();
  assert.equal(cleanup.confirmed, false);
  assert.match(cleanup.errors.join(' '), /remains uncertain/);
  assert.deepEqual([...f.machines.keys()], ['unrelated']);
});

test('E2B recovery rejects changed credentials before any deletion or empty-inventory confirmation', async t => {
  const f = await fixture(t);
  await f.adapter.create(create);
  const count = f.calls.length;
  const other = new E2BAdapter({ ...f.options, apiKey: 'other-team-key' });
  assert.equal((await other.cleanup()).confirmed, false);
  assert.equal(f.calls.length, count);
  assert.equal((await f.adapter.cleanup()).confirmed, true);
});

test('guest commands pin PATH after the SDK login shell and quote argv without evaluating it', async t => {
  const f = await fixture(t);
  const { sandbox } = await f.adapter.create(create);
  await f.adapter.execute(sandbox, { name: 'argv-probe', timeoutMs: 1000, argv: ['node', '-e', "console.log(\"it's $(private)\")"] });
  const command = f.calls.find(call => call.method === 'command')!;
  assert.match(command.options.command, /^'\/usr\/bin\/env' 'PATH=\/opt\/rodeo-node\/bin:/);
  assert.ok(command.options.command.includes("'\\''"));
  assert.ok(command.options.command.includes('$(private)'));
  assert.doesNotMatch(command.options.command, /e2b-test-private-key/);
  assert.equal((await f.adapter.cleanup()).confirmed, true);
});

test('filesystem snapshot uses the requested mechanism and deletes its persistent checkpoint', async t => {
  const f = await fixture(t);
  const { sandbox } = await f.adapter.create(create);
  const prepared = await f.adapter.capture(sandbox, { name: 'capture', timeoutMs: 1000, mode: 'saved-workspace' });
  assert.equal(prepared.preservation, 'filesystem');
  assert.equal(f.calls.find(call => call.method === 'snapshot')?.options.mode, 'filesystem');
  await f.adapter.spawn(prepared, { name: 'restore', timeoutMs: 1000 });
  const cleanup = await f.adapter.cleanup();
  assert.equal(cleanup.confirmed, true);
  assert.deepEqual(cleanup.workspaces, [{ id: 'snapshot:latest', absent: true }]);
  assert.equal(f.snapshots.size, 0);
});

test('disabled filesystem-only capture fails explicitly without substituting a memory snapshot', async t => {
  const f = await fixture(t);
  const { sandbox } = await f.adapter.create(create);
  f.snapshotDisabled();
  await assert.rejects(f.adapter.capture(sandbox, { name: 'capture', timeoutMs: 1000, mode: 'saved-workspace' }), /filesystem-only snapshots are disabled/);
  assert.equal(f.calls.filter(call => call.method === 'snapshot').length, 1);
  assert.equal(f.snapshots.size, 0);
  assert.equal((await f.adapter.cleanup()).confirmed, true);
});
