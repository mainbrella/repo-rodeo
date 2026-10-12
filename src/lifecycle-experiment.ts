import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { hashFiles, sha256, writeJson } from './evidence.ts';
import type { AccountState, ContainerIdentity, Sandbox } from '../../backend/sdk/javascript/index.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const apiUrl = 'https://api.mainbrella.com';
const identity = (value: ContainerIdentity) => ({ id: value.id, createdAt: value.createdAt });
const same = (a: ContainerIdentity, b: ContainerIdentity) => a.id === b.id && a.createdAt === b.createdAt;
type Workspaces = { workspaces: { id: string; name: string; source: ContainerIdentity }[];
  usage: { saved: number; reservedBytes: number; savesThisMonth: number; captureBytesThisMonth: number; retainedCaptureBytes: number };
  limits: { maxSaved: number; maxReservedBytes: number; maxSavesPerMonth: number; maxCaptureBytesPerMonth: number; maxRetainedCaptureBytes: number } };

export function checkLifecycleCapacity(account: AccountState, workspaces: Workspaces): number {
  assert.equal(account.active, true, 'Paid account required');
  const size = account.sizes.find(size => size.id === 'lite');
  assert.ok(size && size.diskGB > 0 && size.computeUnits > 0, 'Lite allocation is missing');
  assert.ok(account.imageCatalog.some(image => image.id === 'node'), 'Node catalog image is missing');
  assert.ok(account.limits.maxStartsPerMonth - account.usage.starts >= 3, 'Three starts must be available');
  assert.ok(account.containers.length + 2 <= account.limits.maxContainers, 'Two container slots must be available');
  assert.ok(account.usage.concurrentComputeUnits + 2 * size.computeUnits <= account.limits.maxConcurrentComputeUnits, 'Two Lite allocations must fit');
  assert.ok(Number.isFinite(account.limits.maxSessionMs) && account.limits.maxSessionMs > 0, 'Session reservation limit is missing');
  assert.ok(account.usage.availableComputeUnitHours >= 2 * size.computeUnits * account.limits.maxSessionMs / 3600000, 'Compute allowance cannot reserve two sessions');
  const bytes = size.diskGB * 1e9, u = workspaces.usage, l = workspaces.limits;
  assert.ok(u.saved + 2 <= l.maxSaved && u.reservedBytes + 2 * bytes <= l.maxReservedBytes, 'Two saved workspaces must fit');
  assert.ok(u.savesThisMonth + 2 <= l.maxSavesPerMonth, 'Two captures must be available');
  assert.ok(u.captureBytesThisMonth + 2 * bytes <= l.maxCaptureBytesPerMonth && u.retainedCaptureBytes + 2 * bytes <= l.maxRetainedCaptureBytes, 'Capture capacity is insufficient');
  return bytes;
}

export function checkPreservedInventory(before: ContainerIdentity[], after: ContainerIdentity[], owned: ContainerIdentity[]) {
  assert.ok(!owned.some(value => before.some(existing => same(value, existing))), 'Ownership overlaps original inventory');
  assert.ok(!owned.some(value => after.some(existing => same(value, existing))), 'Owned generation remains');
  const keys = (values: ContainerIdentity[]) => values.map(value => JSON.stringify(identity(value))).sort();
  assert.deepEqual(keys(after), keys(before), 'Original container inventory changed');
}

export function recoverCaptureIds(workspaces: Workspaces['workspaces'], beforeIds: string[], source: ContainerIdentity, names: string[]): string[] {
  return names.flatMap(name => {
    const matches = workspaces.filter(value => value.name === name && same(value.source, source) && !beforeIds.includes(value.id));
    assert.ok(matches.length <= 1, 'Capture ownership is ambiguous');
    return matches.map(value => value.id);
  });
}

const server = `import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const nonce=randomUUID();let heap=0;
createServer(async(req,res)=>{if(req.method==='POST'&&req.url==='/memory')heap++;
res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
res.end(JSON.stringify({fixture:'rodeo-lifecycle',nonce,pid:process.pid,heap,
marker:await readFile('/workspace/lifecycle-marker','utf8'),authorization:req.headers.authorization??null,cookie:req.headers.cookie??null}));
}).listen(3000,'0.0.0.0');
`;

export async function runLifecycle(output: string, sdkModule: string) {
  const apiKey = process.env.MAINBRELLA_API_KEY || '';
  assert.match(apiKey, /^mb_[a-f0-9]{64}$/i, 'MAINBRELLA_API_KEY required');
  assert.equal(process.versions.node, '22.22.2');
  await mkdir(output, { recursive: false, mode: 0o700 });
  const privateDirectory = join(output, 'private');
  await mkdir(privateDirectory, { mode: 0o700 });
  const inputs = join(privateDirectory, 'inputs');
  await mkdir(inputs);
  await cp(dirname(sdkModule), join(inputs, 'sdk'), { recursive: true });
  for (const file of ['src/lifecycle-experiment.ts', 'src/evidence.ts', 'tests/lifecycle-experiment.test.ts', 'package.json', 'package-lock.json']) {
    await mkdir(dirname(join(inputs, file)), { recursive: true });
    await cp(join(repository, file), join(inputs, file));
  }
  const sdk: typeof import('../../backend/sdk/javascript/index.js') = await import(pathToFileURL(join(inputs, 'sdk', 'index.js')).href);
  const sdkMetadata = JSON.parse(await readFile(join(inputs, 'sdk/package.json'), 'utf8'));
  assert.equal(sdkMetadata.version, '0.2.0');
  const runId = randomUUID(), sourceName = `Rodeo lifecycle ${runId}`, forkName = `Rodeo fork ${runId}`;
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error('qualification_interrupted'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const timer = setTimeout(interrupt, 10 * 60_000);
  let cleaning = false, sequence = 0, dropKey: string | undefined;
  const dropped = new Set<string>(), previews: { label: string; url: string }[] = [];
  const owned: ContainerIdentity[] = [], workspaceIds = new Set<string>();
  const operations: { action: string; path: string; body: Record<string, unknown>; key: string; attempted: boolean; settled: boolean; rejected?: boolean }[] = [];
  const result: any = { schemaVersion: 1, experiment: 'mainbrella-deployed-filesystem-lifecycle', runId,
    status: 'failed', apiUrl, startedAt: new Date().toISOString(), budget: { maxStarts: 3, maxCaptures: 2 },
    sdk: { version: sdkMetadata.version, source: 'clean installation of the locally qualified npm candidate archive' },
    runner: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
      dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim() },
    inputHashes: await hashFiles(inputs), checks: {}, processes: {}, sdkFindings: [], errors: [], cleanup: { confirmed: false, errors: [] },
    limitations: ['Three Lite starts and two full-disk captures, not a performance or price comparison.',
      'Response loss occurs after successful HTTP headers and a privately retained response, not during snapshot capture.',
      'HTTP previews are exercised; dashboard browser controls, SSH, WebSockets and Python installed SDK are separate checks.',
      'The SDK candidate is unpublished. API deletion does not establish physical snapshot erasure.',
      'Egress and vault are disabled and are not qualified by this lifecycle run.'] };
  const save = async () => {
    const path = join(privateDirectory, 'recovery.json');
    await writeFile(path + '.tmp', JSON.stringify({ apiUrl, accountId: result.accountId, runId, sourceName, forkName, operations, owned, workspaceIds: [...workspaceIds], previews }, null, 2) + '\n', { mode: 0o600 });
    await rename(path + '.tmp', path);
  };
  const remember = (value: ContainerIdentity) => { if (!owned.some(existing => same(value, existing))) owned.push(identity(value)); };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, apiUrl);
    const request = { method: init?.method || 'GET', path: url.pathname + url.search,
      key: new Headers(init?.headers).get('Idempotency-Key') };
    if (!cleaning) abort.signal.throwIfAborted();
    const operation = operations.find(value => value.key === request.key);
    if (operation && !operation.attempted) { operation.attempted = true; await save(); }
    const response = await fetch(url, { ...init, signal: AbortSignal.any([
      ...(init?.signal ? [init.signal] : []), ...(cleaning ? [] : [abort.signal]), AbortSignal.timeout(cleaning ? 15000 : 90000),
    ]) });
    let data: any;
    if (response.headers.get('content-type')?.includes('application/json')) data = await response.clone().json();
    await writeJson(join(privateDirectory, `receipt-${++sequence}.json`), { at: new Date().toISOString(), request, status: response.status,
      headers: Object.fromEntries(['cf-ray', 'x-mainbrella-version'].flatMap(name => response.headers.has(name) ? [[name, response.headers.get(name)]] : [])), data });
    if (request.key) {
      if (operation && response.ok) {
        if (data?.creation) {
          const descriptor = data.containers?.find((value: any) => value.id === data.creation.containerId && value.createdAt === data.creation.createdAt);
          if (descriptor) {
            remember(descriptor);
            if (descriptor.workspaceId) workspaceIds.add(descriptor.workspaceId);
          }
        }
        if (operation.action === 'stop') {
          const descriptor = data?.containers?.find((value: any) => value.id === operation.body.id && value.createdAt === operation.body.createdAt && value.status === 'stopped');
          if (descriptor?.workspaceId) workspaceIds.add(descriptor.workspaceId);
        }
        await save();
      }
      if (operation && response.status >= 400 && response.status < 500 && data?.error !== 'idempotency_key_conflict') { operation.rejected = true; await save(); }
      if (dropKey === request.key && response.ok && !dropped.has(dropKey)) {
        dropped.add(dropKey);
        await response.arrayBuffer();
        throw new Error('intentional_successful_reply_loss');
      }
    }
    return response;
  };
  const client = new sdk.Mainbrella({ apiKey, baseUrl: apiUrl, fetch: fetcher, timeoutMs: 90000 });
  const mutate = async <T>(action: string, path: string, body: Record<string, unknown>, call: (key: string) => Promise<T>, loseReply = false) => {
    assert.ok(!operations.some(value => value.action === action), 'Never allocate a fresh key to retry an operation');
    const operation = { action, path, body, key: randomUUID(), attempted: false, settled: false };
    operations.push(operation); await save();
    if (loseReply) dropKey = operation.key;
    const value = await call(operation.key);
    operation.settled = true; await save(); return value;
  };
  const requestWorkspaces = () => client.workspaces.list() as Promise<Workspaces>;
  const inspect = async (sandbox: Sandbox) => {
    const command = await sandbox.commands.run('node -e "fetch(\'http://127.0.0.1:3000/probe\').then(r=>r.text()).then(console.log)"', { timeoutMs: 15000 });
    assert.equal(command.exitCode, 0, 'Guest probe failed');
    return JSON.parse(command.stdout);
  };
  const preview = async (sandbox: Sandbox, label: string) => {
    const link = await sandbox.previews.create(3000, { ttlSeconds: 600 });
    previews.push({ label, url: link.url }); await save();
    const response = await fetch(new URL('/probe', link.url), { headers: { Authorization: 'Bearer disposable-header-must-strip', Cookie: 'session=disposable-header-must-strip' },
      redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) });
    assert.equal(response.status, 200, 'Outside protected preview must respond');
    const process = await response.json();
    assert.equal(process.fixture, 'rodeo-lifecycle'); assert.equal(process.authorization, null); assert.equal(process.cookie, null);
    result.processes[label] = process; return process;
  };
  const denied = async (call: () => Promise<unknown>, expected: number) => {
    await assert.rejects(call(), (error: any) => error.status === expected); return true;
  };
  try {
    const account = await client.request<{ accountId: string }>('/api-keys/me'); result.accountId = account.accountId; assert.ok(result.accountId); await save();
    const capabilities = await client.capabilities();
    assert.equal(capabilities.persistence.filesystemAfterStop, true); assert.equal(capabilities.persistence.filesystemFork, true);
    assert.equal(capabilities.persistence.startupConfiguration, true); assert.equal(capabilities.persistence.restoreLaunch, true);
    assert.equal(capabilities.previews.supported, true); assert.equal(capabilities.execution.background, true); assert.equal(capabilities.execution.argv, true);
    result.capabilities = { apiVersion: capabilities.apiVersion, persistence: capabilities.persistence, networking: capabilities.networking, secrets: capabilities.secrets };
    const before = await client.list(), workspacesBefore = await requestWorkspaces();
    result.inventoryBefore = before; result.workspacesBefore = workspacesBefore;
    result.diskReservationBytes = checkLifecycleCapacity(before, workspacesBefore);
    console.log('Lifecycle: creating one Lite source');
    const source = await mutate('create', '/containers', { catalogId: 'node', size: 'lite', name: sourceName },
      key => client.create({ catalogId: 'node', size: 'lite', name: sourceName, idempotencyKey: key, waitTimeoutMs: 180000 }));
    remember(source); result.source = identity(source); await save();
    const fixture = await source.commands.run('mkdir -p /workspace/lifecycle-nested; printf source > /workspace/lifecycle-marker; printf metadata > /workspace/lifecycle-nested/marker; chmod 640 /workspace/lifecycle-nested/marker; touch -d @1700000000 /workspace/lifecycle-nested/marker; ln -s lifecycle-nested/marker /workspace/lifecycle-link', { timeoutMs: 15000 });
    assert.equal(fixture.exitCode, 0);
    const bytes = Buffer.from([0, 255, 128, 10, 0, 195, 169]);
    await source.files.write('/workspace/lifecycle 界.bin', bytes);
    await source.files.write('/workspace/rodeo-lifecycle-server.mjs', Buffer.from(server));
    result.binary = { bytes: bytes.length, sha256: sha256(bytes) };
    const job = await source.commands.start(['node', '/workspace/rodeo-lifecycle-server.mjs'], { timeoutMs: 600000 });
    let listenerReady = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await inspect(source); listenerReady = true; break; } catch { await pause(500, undefined, { signal: abort.signal }); }
    }
    assert.equal(listenerReady, true, 'Source listener did not start');
    const memory = await source.commands.run('node -e "fetch(\'http://127.0.0.1:3000/memory\',{method:\'POST\'}).then(r=>r.text()).then(console.log)"', { timeoutMs: 15000 });
    assert.equal(memory.exitCode, 0);
    const original = await preview(source, 'source'); assert.equal(original.heap, 1);
    const recipe = { command: 'set -eu\nexec node /workspace/rodeo-lifecycle-server.mjs', cwd: '/workspace', readiness: { port: 3000, path: '/probe', timeoutMs: 60000 } };
    await source.configureStartup(recipe); assert.deepEqual(await inspect(source), original);
    result.recipe = recipe; result.checks.configurationKeepsSourceProcess = true;
    console.log('Lifecycle: forking with reply loss, then checking isolation and replay');
    const fork = await mutate('fork', '/containers/fork', { ...identity(source), name: forkName },
      key => source.fork({ name: forkName, idempotencyKey: key, waitTimeoutMs: 180000 }), true);
    remember(fork); assert.ok(fork.workspaceId, 'Fork capture ownership must be returned'); workspaceIds.add(fork.workspaceId); result.fork = identity(fork); await save();
    await fork.waitUntilReady({ waitTimeoutMs: 90000 });
    const forkProcess = await preview(fork, 'fork'); assert.notEqual(forkProcess.nonce, original.nonce); assert.equal(forkProcess.heap, 0);
    assert.deepEqual(await inspect(source), original);
    assert.deepEqual(Buffer.from(await fork.files.read('/workspace/lifecycle 界.bin')), bytes);
    await fork.files.write('/workspace/lifecycle-marker', Buffer.from('fork'));
    assert.equal((await inspect(source)).marker, 'source');
    const forkKey = operations.find(value => value.action === 'fork')!.key;
    const forkReplay = await source.fork({ name: forkName, idempotencyKey: forkKey });
    assert.deepEqual(identity(forkReplay), identity(fork)); assert.equal((await inspect(forkReplay)).nonce, forkProcess.nonce);
    await denied(() => source.fork({ name: forkName + ' changed', idempotencyKey: forkKey }), 409);
    result.checks.fork = { sourceAlive: true, independentWrites: true, binaryPreserved: true, freshProcessAndHeap: true, automaticStartup: true, replaySameGeneration: true, successfulReplyLossRecovered: dropped.has(forkKey), changedBodyRejected: true };
    console.log('Lifecycle: stopping, resuming and fencing the old generation');
    const stopped = await mutate('stop', '/containers/stop', identity(source), key => source.stop({ idempotencyKey: key }));
    const descriptor = stopped.containers.find(value => same(value, source)); assert.equal(descriptor?.status, 'stopped'); assert.ok(descriptor.workspaceId);
    workspaceIds.add(descriptor.workspaceId); await save();
    const stopKey = operations.find(value => value.action === 'stop')!.key;
    const stopReplay = await source.stop({ idempotencyKey: stopKey });
    assert.equal(stopReplay.containers.find(value => same(value, source))?.workspaceId, descriptor.workspaceId);
    const stopWorkspaces = await requestWorkspaces();
    result.checks.stop = { stoppedIdentityRetained: true, snapshotVisible: stopWorkspaces.workspaces.some(value => value.id === descriptor.workspaceId), replaySameWorkspace: true };
    result.checks.stoppedReadDenied = await denied(() => source.files.read('/workspace/lifecycle-marker'), 409);
    const resumed = await mutate('resume', '/containers/resume', identity(source),
      key => source.resume({ idempotencyKey: key, waitTimeoutMs: 180000 }));
    remember(resumed); result.resume = identity(resumed); await save();
    await resumed.waitUntilReady({ waitTimeoutMs: 90000 });
    const resumedProcess = await preview(resumed, 'resume');
    assert.equal(resumed.id, source.id); assert.notEqual(resumed.createdAt, source.createdAt);
    assert.notEqual(resumedProcess.nonce, original.nonce); assert.notEqual(resumedProcess.nonce, forkProcess.nonce); assert.equal(resumedProcess.heap, 0);
    assert.equal(resumedProcess.marker, 'source'); assert.equal((await inspect(fork)).marker, 'fork');
    assert.deepEqual(Buffer.from(await resumed.files.read('/workspace/lifecycle 界.bin')), bytes);
    const metadata = await resumed.commands.run('test "$(readlink /workspace/lifecycle-link)" = lifecycle-nested/marker && test "$(cat /workspace/lifecycle-link)" = metadata && test "$(stat -c %a /workspace/lifecycle-nested/marker)" = 640 && test "$(stat -c %Y /workspace/lifecycle-nested/marker)" = 1700000000', { timeoutMs: 15000 });
    assert.equal(metadata.exitCode, 0);
    assert.ok(!(await resumed.commands.list()).executions.some(value => value.id === job.id && ['starting', 'running'].includes(value.status)));
    result.checks.staleReadDenied = await denied(() => source.files.read('/workspace/lifecycle-marker'), 409);
    result.checks.staleDeleteDenied = await denied(() => source.kill(), 409);
    const resumeKey = operations.find(value => value.action === 'resume')!.key;
    const resumedReplay = await source.resume({ idempotencyKey: resumeKey });
    assert.deepEqual(identity(resumedReplay), identity(resumed)); assert.deepEqual(await inspect(resumedReplay), resumedProcess);
    const lateStop = await client.request<AccountState>('/containers/stop', { method: 'POST', body: identity(source), headers: { 'Idempotency-Key': stopKey } });
    assert.ok(lateStop.containers.some((value: any) => same(value, resumed) && value.status === 'running'));
    assert.deepEqual(await inspect(resumed), resumedProcess);
    try { await source.stop({ idempotencyKey: stopKey }); result.checks.sdkLateStopReplay = true; }
    catch (error) { const code = error instanceof sdk.MainbrellaError ? error.code : 'unknown'; result.checks.sdkLateStopReplay = false; result.sdkFindings.push({ code, operation: 'stop replay after resume', apiSucceededWithoutStoppingReplacement: true }); }
    result.checks.resume = { freshGeneration: true, freshProcessAndHeap: true, automaticStartup: true, binaryAndMetadataPreserved: true, forkStillIndependent: true, replayDoesNotRelaunch: true, lateStopReplayKeepsReplacementRunning: true };
    const after = await client.list(), workspaceAfter = await requestWorkspaces();
    result.inventoryBeforeCleanup = after; result.workspacesBeforeCleanup = workspaceAfter;
    assert.equal(after.usage.starts - before.usage.starts, 3);
    assert.equal(workspaceAfter.usage.savesThisMonth - workspacesBefore.usage.savesThisMonth, 2);
    assert.equal(workspaceAfter.usage.captureBytesThisMonth - workspacesBefore.usage.captureBytesThisMonth, 2 * result.diskReservationBytes);
    result.checks.budget = { starts: 3, captures: 2, reservedCaptureBytes: 2 * result.diskReservationBytes };
    result.status = result.sdkFindings.length ? 'completed_with_sdk_findings' : 'completed';
  } catch (error) {
    result.errors.push(error instanceof sdk.MainbrellaError ? { code: error.code, status: error.status } : { message: error instanceof Error ? error.message.replaceAll(apiKey, '[REDACTED]').replace(/https?:\/\/[^\s]+/g, '[URL]') : 'Qualification failed' });
  } finally {
    clearTimeout(timer); cleaning = true;
    console.log('Lifecycle: reconciling and cleaning up exact owned resources');
    try {
      const account = await client.request<{ accountId: string }>('/api-keys/me'); assert.equal(account.accountId, result.accountId, 'Cleanup account mismatch');
      for (const operation of operations.filter(value => value.attempted && !value.settled && !value.rejected)) {
        // Reconcile only the original durable key. A rejected request never gets
        // a replacement key; recovery may finish the already reserved operation.
        try {
          const deadline = Date.now() + 60000;
          while (true) {
            const data = await client.request<AccountState & { creation?: { status: string } }>(operation.path, { method: 'POST', body: operation.body, headers: { 'Idempotency-Key': operation.key } });
            if (!data.creation || data.creation.status === 'running') { operation.settled = true; await save(); break; }
            assert.ok(Date.now() < deadline, 'Pending mutation remains ambiguous');
            await pause(1000);
          }
        }
        catch { result.cleanup.errors.push(`Unsettled ${operation.action}; inspect private recovery journal`); }
      }
      // A capture can exist before the corresponding creation/stop completes.
      // Match the persisted random run name and exact source, never sweep all
      // snapshots of that source or adopt a pre-existing workspace.
      if (result.source) {
        const names = operations.filter(value => value.attempted && ['fork', 'stop'].includes(value.action))
          .map(value => value.action === 'fork' ? forkName : `Stopped ${sourceName}`.slice(0, 80));
        try {
          const workspaces = await requestWorkspaces();
          for (const id of recoverCaptureIds(workspaces.workspaces, (result.workspacesBefore?.workspaces || []).map((value: any) => value.id), result.source, names)) workspaceIds.add(id);
        } catch { result.cleanup.errors.push('Partial capture ownership could not be confirmed'); }
      }
      await save();
      for (const value of [...owned].reverse()) {
        try { await client.connect(value).kill(); }
        catch {
          try { const inventory = await client.list(); assert.ok(!inventory.containers.some(existing => same(existing, value)), 'Owned generation cleanup failed'); }
          catch { result.cleanup.errors.push(`Owned generation ${value.id} cleanup unconfirmed`); }
        }
      }
      for (const id of workspaceIds) {
        try {
          assert.ok(!result.workspacesBefore?.workspaces.some((existing: any) => existing.id === id), 'Workspace ownership overlaps original inventory');
          await client.workspaces.delete(id);
        } catch { result.cleanup.errors.push(`Owned workspace ${id} cleanup unconfirmed`); }
      }
      const after = await client.list(), workspaceAfter = await requestWorkspaces();
      checkPreservedInventory(result.inventoryBefore?.containers || [], after.containers, owned);
      assert.deepEqual(workspaceAfter.workspaces.map(value => value.id).sort(), (result.workspacesBefore?.workspaces || []).map((value: any) => value.id).sort());
      result.inventoryAfter = after; result.workspacesAfter = workspaceAfter;
      result.cleanup.generations = owned; result.cleanup.workspaces = [...workspaceIds]; result.cleanup.originalInventoryPreserved = true;
      result.cleanup.previewObservations = [];
      for (const value of previews) {
        const response = await fetch(new URL('/probe', value.url), { redirect: 'error', signal: AbortSignal.timeout(10000) });
        await response.arrayBuffer(); result.cleanup.previewObservations.push({ label: value.label, status: response.status });
        assert.ok([403, 404, 410].includes(response.status), 'Old preview access denial is unconfirmed');
      }
      result.cleanup.confirmed = result.cleanup.errors.length === 0;
    } catch (error) { result.cleanup.errors.push(error instanceof sdk.MainbrellaError ? error.code : 'Cleanup confirmation failed; inspect private journal'); }
    if (!result.cleanup.confirmed) result.status = 'failed';
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    result.finishedAt = new Date().toISOString();
    await save();
    await writeJson(join(privateDirectory, 'full-result.json'), result);
    result.evidence = { privateDirectory: 'private', files: await hashFiles(privateDirectory) };
    // Account identity and inventories remain private. The public result retains
    // measurements and allowlisted observations, never a key or bearer preview.
    const { accountId: _accountId, inventoryBefore: before, inventoryBeforeCleanup: during, inventoryAfter: after,
      workspacesBefore: wb, workspacesBeforeCleanup: wd, workspacesAfter: wa, ...publicResult } = result;
    publicResult.accounting = { startsBefore: before?.usage.starts, startsAfter: after?.usage.starts,
      workspacesBefore: wb?.usage, workspacesBeforeCleanup: wd?.usage, workspacesAfter: wa?.usage };
    assert.ok(!JSON.stringify(publicResult).includes(apiKey));
    for (const value of previews) assert.ok(!JSON.stringify(publicResult).includes(new URL(value.url).hostname));
    await writeJson(join(output, 'result.json'), publicResult);
    await writeFile(join(output, 'result.sha256'), `${sha256(await readFile(join(output, 'result.json')))}  result.json\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify({ status: result.status, checks: result.checks, sdkFindings: result.sdkFindings, cleanup: result.cleanup.confirmed, errors: result.errors }));
  return result.status === 'failed' ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'sdk-module': { type: 'string' } } });
  assert.ok(values.output && values['sdk-module'], 'Use --output <new-directory> --sdk-module <clean installed index.js>');
  process.exitCode = await runLifecycle(resolve(values.output), resolve(values['sdk-module']));
}
