import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MainbrellaAdapter } from '../src/providers/mainbrella.ts';

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function makeAdapter(options: ConstructorParameters<typeof MainbrellaAdapter>[0]) {
  const fetcher = options.fetch!;
  return new MainbrellaAdapter({ ...options, fetch: async (input, init) => {
    if (new URL(String(input)).pathname === '/api-keys/me') return response({ accountId: 'account-A' });
    return fetcher(input, init);
  } });
}
async function harness(fetch: typeof globalThis.fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'mainbrella-adapter-'));
  return { directory, adapter: makeAdapter({ apiUrl: 'http://local', apiKey: 'mb-secret-test', directory, fetch, pollIntervalMs: 0 }),
    close: () => rm(directory, { recursive: true, force: true }) };
}
const createOp = { name: 'create-once', timeoutMs: 5000, image: 'node', size: 'small' };

test('uncertain create retries the exact saved request with the same key', async () => {
  const seen: { body: string; key: string | null }[] = [];
  const h = await harness(async (_input, init) => {
    seen.push({ body: String(init?.body ?? ''), key: new Headers(init?.headers).get('Idempotency-Key') });
    if (seen.length === 1) throw new Error('connection reset');
    return response({ creation: { containerId: 'c1', createdAt: 'g1', status: 'running' }, containers: [{ id: 'c1', createdAt: 'g1', status: 'running' }] });
  });
  try {
    const result = await h.adapter.create(createOp);
    assert.deepEqual(result.sandbox, { id: 'c1', generation: 'g1' });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1], seen[0]);
    assert.equal(seen[0].body, '{"catalogId":"node","size":"small"}');
    assert.match(seen[0].key ?? '', /^[0-9a-f-]{36}$/);
    assert.equal((await readFile(result.receipt.rawEvidencePath)).length > 0, true);
  } finally { await h.close(); }
});

test('same operation name rejects changed request data before a second call', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; return response({ creation: { containerId: 'c1', createdAt: 'g1', status: 'running' }, containers: [{ id: 'c1', createdAt: 'g1', status: 'running' }] }); });
  try {
    await h.adapter.create(createOp);
    await assert.rejects(h.adapter.create({ ...createOp, size: 'large' }), /different request data/);
    assert.equal(calls, 1);
  } finally { await h.close(); }
});

test('accepted capture response lost after headers retries once with same key and body', async () => {
  const seen: { body: string; key: string | null }[] = [];
  const h = await harness(async (_input, init) => {
    seen.push({ body: String(init?.body ?? ''), key: new Headers(init?.headers).get('Idempotency-Key') });
    return response({ workspace: { id: 'w1', bytes: 100 } }, 201);
  });
  try {
    const source = { id: 'c1', generation: 'g1' };
    const request = {
      name: 'capture-once', timeoutMs: 5000, mode: 'saved-workspace', dropResponseAfterHeaders: true,
    } as const;
    const prepared = await h.adapter.capture(source, request);
    const replayed = await h.adapter.capture(source, { ...request, dropResponseAfterHeaders: false });
    assert.equal(prepared.id, 'w1');
    assert.equal(replayed.id, 'w1');
    assert.equal(seen.length, 3);
    assert.deepEqual(seen[1], seen[0]);
    assert.equal(seen[0].body, '{"id":"c1","createdAt":"g1","name":"capture-once","stop":false}');
    assert.equal(seen[0].key, seen[1].key);
    const records = await readdir(join(h.directory, 'operations'));
    const journal = JSON.parse(await readFile(join(h.directory, 'operations', records[0]), 'utf8'));
    assert.equal(journal.responseLostAfterHeaders, true);
    assert.equal(journal.responseStatus, 201);
    assert.deepEqual(journal.attemptEvidence.slice(0, 2).map((x: any) => x.status), [201, 201]);
    assert.ok(journal.attemptEvidence[0].responseBody === undefined);
  } finally { await h.close(); }
});

test('saved launch recipe survives capture retry and remains filesystem preservation', async () => {
  const seen: { body: string; key: string | null }[] = [];
  const h = await harness(async (_input, init) => {
    seen.push({ body: String(init?.body ?? ''), key: new Headers(init?.headers).get('Idempotency-Key') });
    if (seen.length === 1) throw new Error('connection reset');
    return response({ workspace: { id: 'w-launch', bytes: 100 } }, 201);
  });
  try {
    const source = { id: 'c1', generation: 'g1' };
    const launch = { command: 'node server.mjs', cwd: '/workspace/app',
      readiness: { port: 5173, path: '/probe', timeoutMs: 30000 } };
    const request = { name: 'capture-launch', timeoutMs: 5000, mode: 'saved-workspace', launch } as const;
    const prepared = await h.adapter.capture(source, request);
    assert.equal(prepared.preservation, 'filesystem');
    assert.deepEqual(seen[1], seen[0]);
    assert.deepEqual(JSON.parse(seen[0].body).launch, launch);
    await assert.rejects(h.adapter.capture(source, { ...request, launch: { ...launch, command: 'node changed.mjs' } }), /different request data/);
    assert.equal(seen.length, 2);
  } finally { await h.close(); }
});

test('terminal job failure is returned with its failure status and exit code', async () => {
  const h = await harness(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/containers/executions' && init?.method === 'POST') return response({ id: 'j1', status: 'queued' }, 202);
    if (url.pathname === '/containers/executions/j1') return response({ id: 'j1', status: 'failed', exitCode: 17, stdout: 'out', stderr: 'err' });
    throw new Error('unexpected request');
  });
  try {
    const result = await h.adapter.execute({ id: 'c1', generation: 'g1' }, { name: 'job-failure', timeoutMs: 5000, argv: ['false'] });
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 17);
    assert.equal(result.stderr, 'err');
  } finally { await h.close(); }
});

test('preview issuance is single attempt and never exposes raw server error text', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; throw new Error('private-url https://secret.example/token'); });
  try {
    await assert.rejects(h.adapter.preview({ id: 'c1', generation: 'g1' }, { name: 'preview-once', timeoutMs: 1000, port: 3000 }), /request failed/);
    assert.equal(calls, 1);
  } finally { await h.close(); }
});

test('expired keyed operations are fenced locally', async () => {
  const h = await harness(async () => response({ creation: { containerId: 'c1', createdAt: 'g1', status: 'running' }, containers: [{ id: 'c1', createdAt: 'g1', status: 'running' }] }));
  try {
    await h.adapter.create(createOp);
    const files = await readdir(join(h.directory, 'operations'));
    const file = join(h.directory, 'operations', files[0]);
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await writeFile(file, JSON.stringify(record));
    await assert.rejects(h.adapter.create(createOp), /outside its idempotency retention window/);
  } finally { await h.close(); }
});

test('fresh cleanup recovers an uncertain create and deletes only its exact generation', async () => {
  const h = await harness(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/containers' && init?.method === 'POST') throw new Error('simulate process loss before reply');
    return response({});
  });
  try {
    await assert.rejects(h.adapter.create(createOp));
    const seen: { path: string; method: string; key: string | null; body: string }[] = [];
    const restarted = makeAdapter({ apiUrl: 'http://local', apiKey: 'mb-secret-test', directory: h.directory, pollIntervalMs: 0,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const method = String(init?.method ?? 'GET');
        seen.push({ path: url.pathname + url.search, method, key: new Headers(init?.headers).get('Idempotency-Key'), body: String(init?.body ?? '') });
        if (url.pathname === '/containers' && method === 'POST') return response({ creation: { containerId: 'owned', createdAt: 'generation-A', status: 'running' }, containers: [{ id: 'owned', createdAt: 'generation-A', status: 'running' }] });
        if (url.pathname === '/containers' && method === 'DELETE') return response({});
        if (url.pathname === '/containers' && method === 'GET') return response({ containers: [], limits: { maxContainers: 4 } });
        if (url.pathname === '/workspaces' && method === 'GET') return response({ workspaces: [], usage: { saved: 0, reservedBytes: 0, savesThisMonth: 0, captureBytesThisMonth: 0, retainedCaptureBytes: 0 }, limits: null });
        throw new Error(`unexpected ${method} ${url.pathname}`);
      } });
    const result = await restarted.cleanup();
    assert.equal(result.confirmed, true);
    assert.deepEqual(result.sandboxes, [{ sandbox: { id: 'owned', generation: 'generation-A' }, absent: true }]);
    const replay = seen.find(x => x.method === 'POST');
    const deletion = seen.find(x => x.method === 'DELETE');
    assert.ok(replay?.key);
    assert.equal(replay?.key, deletion?.key ?? replay?.key); // DELETE carries no key.
    assert.match(deletion?.path ?? '', /id=owned&createdAt=generation-A/);
  } finally { await h.close(); }
});

test('starting create is replayed until the matching generation reports running', async () => {
  const seen: string[] = [];
  let post = 0;
  const h = await harness(async (_input, init) => {
    const body = String(init?.body ?? '');
    seen.push(`${new Headers(init?.headers).get('Idempotency-Key')}:${body}`);
    post++;
    if (post === 1) return response({ creation: { containerId: 'c2', createdAt: 'g2', status: 'starting' }, containers: [{ id: 'c2', createdAt: 'g2', status: 'starting' }] }, 202);
    return response({ creation: { containerId: 'c2', createdAt: 'g2', status: 'running' }, containers: [{ id: 'c2', createdAt: 'g2', status: 'running' }] });
  });
  try {
    const created = await h.adapter.create({ ...createOp, name: 'create-starting' });
    assert.deepEqual(created.sandbox, { id: 'c2', generation: 'g2' });
    assert.equal(post, 2);
    assert.equal(seen[0], seen[1]);
  } finally { await h.close(); }
});

test('startJob returns admission without polling the job', async () => {
  let posts = 0;
  let gets = 0;
  const h = await harness(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/containers/executions' && init?.method === 'POST') { posts++; return response({ id: 'j2', status: 'queued' }, 202); }
    if (url.pathname === '/containers/executions/j2') { gets++; return response({ id: 'j2', status: 'running' }); }
    throw new Error('unexpected request');
  });
  try {
    const result = await h.adapter.startJob({ id: 'c1', generation: 'g1' }, { name: 'job-detach', timeoutMs: 5000, argv: ['sleep', '5'] });
    assert.equal(result.id, 'j2');
    assert.equal(result.status, 'queued');
    assert.equal(posts, 1);
    assert.equal(gets, 0);
  } finally { await h.close(); }
});

test('corrupt operation journal never generates a replacement idempotency key', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; return response({ creation: { containerId: 'c1', createdAt: 'g1', status: 'running' }, containers: [{ id: 'c1', createdAt: 'g1', status: 'running' }] }); });
  try {
    await h.adapter.create(createOp);
    const files = await readdir(join(h.directory, 'operations'));
    await writeFile(join(h.directory, 'operations', files[0]), '{truncated');
    await assert.rejects(h.adapter.create(createOp), /journal is unreadable/);
    assert.equal(calls, 1);
  } finally { await h.close(); }
});

test('upload stores exact bytes privately and rejects a changed body before overwriting them', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; return response({ path: '/tmp/probe', size: 3 }); });
  try {
    await h.adapter.upload({ id: 'c1', generation: 'g1' }, { name: 'upload-once', timeoutMs: 5000, path: '/tmp/probe', bytes: Buffer.from([0, 1, 255]) });
    const files = await readdir(join(h.directory, 'uploads'));
    const file = join(h.directory, 'uploads', files[0]);
    assert.deepEqual(await readFile(file), Buffer.from([0, 1, 255]));
    await assert.rejects(h.adapter.upload({ id: 'c1', generation: 'g1' }, { name: 'upload-once', timeoutMs: 5000, path: '/tmp/probe', bytes: Buffer.from('changed') }), /different request data/);
    assert.deepEqual(await readFile(file), Buffer.from([0, 1, 255]));
    assert.equal(calls, 1);
  } finally { await h.close(); }
});

test('preview operation name cannot reissue a non-idempotent grant', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; return response({ id: 'p1', url: 'https://private.example/token', expiresAt: Date.now() + 60000 }); });
  try {
    const sandbox = { id: 'c1', generation: 'g1' };
    const request = { name: 'preview-no-retry', timeoutMs: 1000, port: 3000 };
    await h.adapter.preview(sandbox, request);
    await assert.rejects(h.adapter.preview(sandbox, request), /already attempted/);
    assert.equal(calls, 1);
  } finally { await h.close(); }
});

test('cleanup proceeds with valid owned resources when another operation journal is corrupt', async () => {
  const h = await harness(async () => { throw new Error('simulate uncertain create'); });
  try {
    await assert.rejects(h.adapter.create(createOp));
    await writeFile(join(h.directory, 'operations', 'corrupt.json'), '{bad');
    const calls: string[] = [];
    const restarted = makeAdapter({ apiUrl: 'http://local', apiKey: 'mb-secret-test', directory: h.directory,
      fetch: async (input, init) => {
        const url = new URL(String(input)); const method = String(init?.method ?? 'GET'); calls.push(`${method} ${url.pathname}`);
        if (method === 'POST' && url.pathname === '/containers') return response({ creation: { containerId: 'known', createdAt: 'gen', status: 'running' }, containers: [{ id: 'known', createdAt: 'gen', status: 'running' }] });
        if (method === 'DELETE' && url.pathname === '/containers') return response({});
        if (method === 'GET' && url.pathname === '/containers') return response({ containers: [], limits: { maxContainers: 4 } });
        if (method === 'GET' && url.pathname === '/workspaces') return response({ workspaces: [], usage: { saved: 0, reservedBytes: 0, savesThisMonth: 0, captureBytesThisMonth: 0, retainedCaptureBytes: 0 }, limits: null });
        throw new Error('unexpected request');
      } });
    const result = await restarted.cleanup();
    assert.equal(result.confirmed, false);
    assert.ok(calls.includes('DELETE /containers'));
    assert.ok(result.errors.some(x => x.includes('journal could not be read')));
  } finally { await h.close(); }
});

test('expired ambiguous create is reported unresolved without replaying its key', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; throw new Error('transport failure'); });
  try {
    await assert.rejects(h.adapter.create(createOp));
    const files = await readdir(join(h.directory, 'operations'));
    const file = join(h.directory, 'operations', files.find(x => x.endsWith('.json'))!);
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await writeFile(file, JSON.stringify(record));
    const restarted = makeAdapter({ apiUrl: 'http://local', apiKey: 'mb-secret-test', directory: h.directory,
      fetch: async (input, init) => {
        calls++;
        const url = new URL(String(input));
        if (url.pathname === '/containers' && init?.method === 'GET') return response({ containers: [], limits: {} });
        if (url.pathname === '/workspaces') return response({ workspaces: [], usage: { saved: 0, reservedBytes: 0, savesThisMonth: 0, captureBytesThisMonth: 0, retainedCaptureBytes: 0 }, limits: null });
        return response({});
      } });
    const result = await restarted.cleanup();
    assert.equal(result.confirmed, false);
    assert.ok(result.errors.some(x => x.includes('beyond its provider idempotency window')));
    assert.equal(calls, 5); // three bounded create attempts plus two read-only inventory calls
  } finally { await h.close(); }
});

test('successful capture headers followed by an auth failure remain unresolved during cleanup', async () => {
  let postCount = 0;
  const h = await harness(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/workspaces' && init?.method === 'POST') {
      postCount++;
      if (postCount === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new Error('body transport loss')); } }), { status: 201 });
      return response({ error: 'unauthorized' }, 401);
    }
    return response({});
  });
  try {
    await assert.rejects(h.adapter.capture({ id: 'source', generation: 'source-gen' }, { name: 'ambiguous-capture', timeoutMs: 3000, mode: 'saved-workspace' }));
    const restarted = makeAdapter({ apiUrl: 'http://local', apiKey: 'mb-secret-test', directory: h.directory,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/workspaces' && init?.method === 'POST') return response({ error: 'unauthorized' }, 401);
        if (url.pathname === '/containers' && init?.method === 'GET') return response({ containers: [], limits: { maxContainers: 4 } });
        if (url.pathname === '/workspaces' && init?.method === 'GET') return response({ workspaces: [{ id: 'possibly-owned' }],
          usage: { saved: 1, reservedBytes: 100, savesThisMonth: 1, captureBytesThisMonth: 100, retainedCaptureBytes: 100 }, limits: null });
        throw new Error('unexpected request');
      } });
    const result = await restarted.cleanup();
    assert.equal(result.confirmed, false);
    assert.ok(result.errors.some(x => x.includes('Could not reconcile')));
    assert.deepEqual(result.workspaces, []); // never guess which listed workspace belongs to this run
  } finally { await h.close(); }
});

test('inventory rejects absent allowance counters instead of treating them as zero', async () => {
  const h = await harness(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/containers') return response({ containers: [], limits: { maxContainers: 4 } });
    return response({ workspaces: [], limits: null, usage: { saved: 0, reservedBytes: 0, savesThisMonth: 0, captureBytesThisMonth: 0 } });
  });
  try { await assert.rejects(h.adapter.inventory(), /invalid workspace usage.retainedCaptureBytes/); }
  finally { await h.close(); }
});

test('valid JSON with an invalid timestamp fails closed without replacing its saved key', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; return response({ creation: { containerId: 'c1', createdAt: 'g1', status: 'running' }, containers: [{ id: 'c1', createdAt: 'g1', status: 'running' }] }); });
  try {
    await h.adapter.create(createOp);
    const files = await readdir(join(h.directory, 'operations'));
    const file = join(h.directory, 'operations', files[0]);
    const record = JSON.parse(await readFile(file, 'utf8'));
    const originalKey = record.key;
    record.createdAt = 'not-a-time';
    await writeFile(file, JSON.stringify(record));
    await assert.rejects(h.adapter.create(createOp), /invalid identity or retention metadata/);
    const untouched = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(untouched.key, originalKey);
    assert.equal(calls, 1);
  } finally { await h.close(); }
});

test('event reattachment cancels the first stream and resumes using its complete event cursor', async () => {
  const cursors: string[] = [];
  let cancelled = false;
  const encoder = new TextEncoder();
  const fetcher: typeof globalThis.fetch = async input => {
    const url = new URL(String(input));
    cursors.push(url.searchParams.get('cursor')!);
    if (cursors.length === 1) {
      let chunk = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunk++ === 0) controller.enqueue(encoder.encode('id: 1\nevent: stdout\ndata: {"data":"rodeo-reconnect-'));
          else controller.enqueue(encoder.encode('start"}\n\n'));
        },
        cancel() { cancelled = true; },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('id: 2\nevent: stdout\ndata: {"data":"rodeo-reconnect-done"}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  const h = await harness(fetcher);
  try {
    const sandbox = { id: 'c1', generation: 'g1' };
    const first = await h.adapter.readEvents(sandbox, 'j1', 0, 'rodeo-reconnect-start');
    assert.equal(first.cursor, 1);
    assert.equal(cancelled, true);
    const newClient = makeAdapter({ apiUrl: 'http://local', apiKey: 'mb-secret-test', directory: h.directory, fetch: fetcher });
    const remaining = await newClient.readEvents(sandbox, 'j1', first.cursor);
    assert.equal(remaining.cursor, 2);
    assert.match(remaining.text, /rodeo-reconnect-done/);
    assert.deepEqual(cursors, ['0', '1']);
  } finally { await h.close(); }
});

test('cleanup rejects another account before replaying an uncertain create or deleting known resources; rotated keys work', async () => {
  let ambiguous = false;
  const h = await harness(async () => {
    if (ambiguous) throw new Error('lost create response');
    return response({ creation: { containerId: 'owned', createdAt: 'generation-A', status: 'running' },
      containers: [{ id: 'owned', createdAt: 'generation-A', status: 'running' }] });
  });
  try {
    await h.adapter.create(createOp);
    ambiguous = true;
    await assert.rejects(h.adapter.create({ ...createOp, name: 'uncertain-create' }));
    const seen: { method: string; path: string; account: string }[] = [];
    const makeClient = (apiKey: string) => new MainbrellaAdapter({ apiUrl: 'http://local', apiKey, directory: h.directory,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? 'GET';
        const key = new Headers(init?.headers).get('Authorization');
        const account = key === 'Bearer account-B-key' ? 'account-B' : 'account-A';
        seen.push({ method, path, account });
        if (path === '/api-keys/me') return response({ accountId: account });
        if (method === 'POST') return response({ creation: { containerId: 'uncertain', createdAt: 'generation-A2', status: 'running' },
          containers: [{ id: 'uncertain', createdAt: 'generation-A2', status: 'running' }] });
        if (method === 'DELETE') return response({});
        if (path === '/containers') return response({ containers: [], limits: { maxContainers: 4 } });
        if (path === '/workspaces') return response({ workspaces: [], limits: null,
          usage: { saved: 0, reservedBytes: 0, savesThisMonth: 0, captureBytesThisMonth: 0, retainedCaptureBytes: 0 } });
        throw new Error('unexpected request');
      } });
    const rejected = await makeClient('account-B-key').cleanup();
    assert.equal(rejected.confirmed, false);
    assert.match(rejected.errors.join(' '), /different account/);
    assert.deepEqual(seen, [{ method: 'GET', path: '/api-keys/me', account: 'account-B' }]);
    await assert.rejects(makeClient('account-B-key').create(createOp), /different account/);
    assert.ok(seen.every(call => call.path === '/api-keys/me'));
    seen.length = 0;
    const accepted = await makeClient('rotated-account-A-key').cleanup();
    assert.equal(accepted.confirmed, true);
    assert.equal(accepted.sandboxes.length, 2);
    assert.ok(seen.some(call => call.method === 'POST'));
    assert.equal(seen.filter(call => call.method === 'DELETE').length, 2);
    assert.ok(seen.every(call => call.account === 'account-A'));
    const binding = await readFile(join(h.directory, 'account.json'), 'utf8');
    assert.deepEqual(JSON.parse(binding), { schemaVersion: 1, apiUrl: 'http://local', accountId: 'account-A' });
    assert.doesNotMatch(binding, /mb-secret-test|rotated-account-A-key/);
  } finally { await h.close(); }
});

test('missing, malformed or foreign-origin account bindings never adopt existing recovery records', async () => {
  const h = await harness(async () => response({ creation: { containerId: 'owned', createdAt: 'generation-A', status: 'running' },
    containers: [{ id: 'owned', createdAt: 'generation-A', status: 'running' }] }));
  try {
    await h.adapter.create(createOp);
    const accountFile = join(h.directory, 'account.json');
    for (const binding of [null, 'null', '0', '{bad', JSON.stringify({ schemaVersion: 1, apiUrl: 'http://other', accountId: 'account-A' })]) {
      if (binding === null) await rm(accountFile);
      else await writeFile(accountFile, binding);
      let calls = 0;
      const restarted = new MainbrellaAdapter({ apiUrl: 'http://local', apiKey: 'other-key', directory: h.directory,
        fetch: async () => { calls++; return response({ accountId: 'account-A' }); } });
      assert.equal((await restarted.cleanup()).confirmed, false);
      await assert.rejects(restarted.create(createOp), /account binding/);
      assert.equal(calls, 0);
    }
  } finally { await h.close(); }
});

test('unavailable or malformed authenticated identity prevents journaling and provisioning', async () => {
  for (const identity of [response({}, 404), response({}, 401), response({}, 503), response({}), response({ accountId: '' })]) {
    const directory = await mkdtemp(join(tmpdir(), 'mainbrella-identity-'));
    const calls: string[] = [];
    try {
      const adapter = new MainbrellaAdapter({ apiUrl: 'http://local', apiKey: 'mb-secret-test', directory,
        fetch: async input => { calls.push(new URL(String(input)).pathname); return identity; } });
      await assert.rejects(adapter.create(createOp), /account identity/);
      assert.deepEqual(calls, ['/api-keys/me']);
      assert.deepEqual(await readdir(join(directory, 'operations')), []);
      await assert.rejects(readFile(join(directory, 'account.json')), { code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

for (const phase of ['payload-sync', 'payload-rename', 'journal-rename', 'before-request']) {
  test(`SIGKILL at upload ${phase} leaves cleanup recoverable without missing journal bytes`, async () => {
    const h = await harness(async () => response({ creation: { containerId: 'owned', createdAt: 'generation-A', status: 'running' },
      containers: [{ id: 'owned', createdAt: 'generation-A', status: 'running' }] }));
    try {
      const { sandbox } = await h.adapter.create(createOp);
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const phase = ${JSON.stringify(phase)};
        const crash = () => process.kill(process.pid, 'SIGKILL');
        const originalOpen = fs.open;
        fs.open = async (...args) => {
          const handle = await originalOpen(...args);
          if (String(args[0]).includes('.bin.') && phase === 'payload-sync') {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => { await sync(); crash(); };
          }
          return handle;
        };
        const originalRename = fs.rename;
        fs.rename = async (from, to) => {
          await originalRename(from, to);
          if (String(to).endsWith('.bin') && phase === 'payload-rename') crash();
          if (String(to).includes('/operations/') && phase === 'journal-rename') crash();
        };
        syncBuiltinESMExports();
        const { MainbrellaAdapter } = await import(${JSON.stringify(new URL('../src/providers/mainbrella.ts', import.meta.url).href)});
        const adapter = new MainbrellaAdapter({ apiUrl: 'http://local', apiKey: 'mb-secret-test',
          directory: ${JSON.stringify(h.directory)}, fetch: async (input, init) => {
            if (new URL(String(input)).pathname === '/api-keys/me') return new Response(JSON.stringify({ accountId: 'account-A' }));
            if (init?.method === 'PUT' && phase === 'before-request') crash();
            throw new Error('Upload must not reach the server before the injected crash');
          } });
        await adapter.upload(${JSON.stringify(sandbox)}, { name: 'crash-upload', timeoutMs: 1000,
          path: '/tmp/probe', bytes: Buffer.from([0, 1, 255]) });
      `], { encoding: 'utf8', timeout: 10000 });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const journals = await readdir(join(h.directory, 'operations'));
      for (const file of journals.filter(file => file.endsWith('.json'))) {
        const record = JSON.parse(await readFile(join(h.directory, 'operations', file), 'utf8'));
        if (record.upload) assert.deepEqual(await readFile(record.upload.file), Buffer.from([0, 1, 255]));
      }
      const restarted = makeAdapter({ apiUrl: 'http://local', apiKey: 'mb-secret-test', directory: h.directory,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (init?.method === 'DELETE') return response({});
          if (url.pathname === '/containers') return response({ containers: [], limits: { maxContainers: 4 } });
          if (url.pathname === '/workspaces') return response({ workspaces: [], limits: null,
            usage: { saved: 0, reservedBytes: 0, savesThisMonth: 0, captureBytesThisMonth: 0, retainedCaptureBytes: 0 } });
          throw new Error('Cleanup must not replay an upload');
        } });
      const cleanup = await restarted.cleanup();
      assert.equal(cleanup.confirmed, true, cleanup.errors.join(' '));
      assert.deepEqual(cleanup.sandboxes, [{ sandbox, absent: true }]);
    } finally { await h.close(); }
  });
}
