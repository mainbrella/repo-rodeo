import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { Sandbox as E2B } from 'e2b';
import { E2BAdapter } from './providers/e2b.ts';
import { DaytonaAdapter } from './providers/daytona.ts';
import { redact } from './experiment-result.ts';
import { hashFiles, sealProviderEvidence, sha256, snapshotInputs, writeJson } from './evidence.ts';
import type { Inventory, PreparedState, ProviderAdapter } from './providers/interface.ts';

export class LostCaptureResponse extends Error {
  constructor() { super('Successful capture response deliberately withheld'); }
}

// The observer retains the receipt privately. Recovery never receives its body.
export function dropFirstCaptureResponse(fetcher: typeof fetch, matches: (url: URL, method: string) => boolean,
  observe: (value: { url: string; status: number; body: string }) => Promise<void>) {
  let dropped = false, submissions = 0;
  const fetchWithLoss: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const capture = matches(url, method);
    if (capture) submissions++;
    const response = await fetcher(input, init);
    if (capture && response.ok && !dropped) {
      await observe({ url: url.href, status: response.status, body: await response.text() });
      dropped = true;
      throw new LostCaptureResponse();
    }
    return response;
  };
  return { fetch: fetchWithLoss, state: () => ({ dropped, submissions }) };
}

export function inventoryIdentities(inventory: Inventory) {
  return { sandboxes: inventory.sandboxes.map(s => `${s.id}/${s.generation}`).sort(),
    workspaces: inventory.workspaces.map(s => s.id).sort() };
}

export function exactNamedSnapshot(items: { snapshotId: string; names: string[] }[], name: string) {
  const matches = items.filter(item => item.names.some(value => value.split('/').at(-1)?.split(':')[0] === name));
  assert.ok(matches.length <= 1, 'Snapshot name is ambiguous');
  return matches[0];
}

export async function runCaptureResponseLoss(options: { provider: 'e2b' | 'daytona'; apiKey: string; output: string }) {
  assert.equal(process.versions.node, '22.22.2', 'Use the pinned Node runtime');
  assert.ok(options.apiKey, 'Provider credential is required');
  const output = resolve(options.output), privateDirectory = join(output, 'private');
  await mkdir(output, { recursive: false, mode: 0o700 });
  await mkdir(privateDirectory, { mode: 0o700 });
  const runId = randomUUID(), provider = options.provider;
  const apiUrl = provider === 'e2b' ? 'https://api.e2b.dev' : 'https://app.daytona.io/api';
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Qualification interrupted'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const timer = setTimeout(interrupt, 12 * 60_000);
  const loss = dropFirstCaptureResponse(fetch, (url, method) => url.origin === new URL(apiUrl).origin &&
    method === 'POST' && /\/(?:sandbox|sandboxes)\/[^/]+\/(?:snapshot|snapshots)$/.test(url.pathname),
  async value => writeJson(join(privateDirectory, 'withheld-response.json'), value));
  const adapter: ProviderAdapter = provider === 'e2b'
    ? new E2BAdapter({ apiUrl, apiKey: options.apiKey, directory: privateDirectory })
    : new DaytonaAdapter({ apiUrl, apiKey: options.apiKey, directory: privateDirectory, fetch: loss.fetch });
  const inventoryClient: ProviderAdapter = provider === 'e2b'
    ? new E2BAdapter({ apiUrl, apiKey: options.apiKey, directory: join(privateDirectory, 'independent-inventory') })
    : new DaytonaAdapter({ apiUrl, apiKey: options.apiKey, directory: join(privateDirectory, 'independent-inventory') });
  const result: any = { schemaVersion: 1, experiment: 'named-snapshot-response-loss-recovery', provider, runId,
    status: 'failed', startedAt: new Date().toISOString(), budget: { maxSandboxCreates: 2, maxCaptureSubmissions: 1 },
    runner: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() },
    sdkVersion: provider === 'e2b' ? '2.55.0' : '0.223.1', checks: {}, errors: [], cleanup: null,
    limitations: ['One run per provider, not a reliability, performance or price ranking.',
      'A successful response is withheld after HTTP headers and body are received privately, not before admission.',
      'Recovery uses a persisted snapshot name and inventory reads; no undocumented idempotency header is assumed.',
      'E2B full snapshot and Daytona container filesystem snapshot have different state-preservation semantics.',
      'API resource absence does not prove physical storage erasure or credential invalidation.'] };
  const operation = (name: string, timeoutMs = 180_000) => ({ name: `${runId}-${name}`, timeoutMs, signal: controller.signal });
  let before: Inventory | undefined;
  try {
    result.inputHashes = await snapshotInputs(process.cwd(), join(privateDirectory, 'inputs'));
    before = await inventoryClient.inventory();
    await writeJson(join(privateDirectory, 'inventory-before.json'), before);
    // Bound concurrency before provisioning; these runs preserve existing resources.
    assert.ok(before.sandboxes.length + 2 <= 20, 'Two sandbox slots are required');
    await adapter.inventory();
    const binding = JSON.parse(await readFile(join(privateDirectory, `${provider}-credential.json`), 'utf8'));
    const snapshotName = provider === 'e2b' ? `rodeo-${binding.runLabel}` : `rodeo-${binding.runLabel}-prepared`;
    result.snapshotName = snapshotName;
    const source = await adapter.create({ ...operation('source'), image: provider === 'e2b' ? 'base' : 'default',
      size: provider === 'e2b' ? 'base' : 'default' });
    result.source = source.sandbox;
    const marker = `capture-response-loss-${runId}`, markerPath = '/workspace/rodeo-capture-marker.txt';
    await adapter.upload(source.sandbox, { ...operation('marker'), path: markerPath, bytes: Buffer.from(marker) });
    let prepared: PreparedState;
    if (provider === 'daytona') {
      // The adapter submits once, catches an uncertain reply, and polls its durable name.
      prepared = await adapter.capture(source.sandbox, { ...operation('capture', 600_000), mode: 'saved-workspace' });
      result.recoveryMechanism = 'Poll the persisted snapshot name; no second capture POST';
    } else {
      const body = { name: snapshotName, memory: true };
      await writeJson(join(privateDirectory, 'capture-request.json'), { sandbox: source.sandbox, body });
      try {
        const response = await loss.fetch(`${apiUrl}/sandboxes/${encodeURIComponent(source.sandbox.id)}/snapshots`, {
          method: 'POST', redirect: 'error', headers: { 'X-API-Key': options.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
        });
        assert.fail(`Capture response was not withheld (HTTP ${response.status})`);
      } catch (error) { assert.ok(error instanceof LostCaptureResponse, 'Capture did not reach the deliberate successful-response loss'); }
      const deadline = Date.now() + 60_000;
      let recovered: ReturnType<typeof exactNamedSnapshot>;
      do {
        controller.signal.throwIfAborted();
        const paginator = E2B.listSnapshots({ apiKey: options.apiKey, retries: 0, requestTimeoutMs: 15000,
          sandboxId: source.sandbox.id, name: snapshotName });
        const items = [];
        while (paginator.hasNext) items.push(...await paginator.nextItems());
        await writeJson(join(privateDirectory, `snapshot-observation-${randomUUID()}.json`), items);
        recovered = exactNamedSnapshot(items, snapshotName);
        if (recovered) break;
        await pause(1000, undefined, { signal: controller.signal });
      } while (Date.now() < deadline);
      assert.ok(recovered, 'A new client could not recover the exact snapshot name');
      // Only now does the independent observer check the withheld response identity.
      const receipt = JSON.parse(await readFile(join(privateDirectory, 'withheld-response.json'), 'utf8'));
      assert.equal(recovered.snapshotId, JSON.parse(receipt.body).snapshotID);
      prepared = { id: recovered.snapshotId, mode: 'saved-workspace', preservation: 'filesystem+memory',
        source: source.sandbox, bytes: null, receipt: { operationId: `${runId}-capture`, requestedAt: result.startedAt,
          completedAt: new Date().toISOString(), rawEvidencePath: 'private/withheld-response.json' } };
      result.recoveryMechanism = 'New SDK client lists by persisted snapshot name; no second capture POST';
    }
    assert.deepEqual(loss.state(), { dropped: true, submissions: 1 });
    result.capture = { id: prepared.id, preservation: prepared.preservation };
    const restored = await adapter.spawn(prepared, operation('restore'));
    result.restore = restored.sandbox;
    const content = await adapter.execute(restored.sandbox, { ...operation('read-marker', 30000), argv: ['cat', markerPath] });
    assert.equal(content.exitCode, 0); assert.equal(content.stdout, marker);
    result.checks = { responseBodyLost: true, nameRecovery: true, captureSubmissions: 1,
      restoredSnapshotUsable: true, preparedFilePreserved: true };
    result.status = 'completed';
  } catch (error) {
    result.errors.push(redact(error instanceof Error ? error.message : String(error), [options.apiKey]));
  } finally {
    clearTimeout(timer);
    try { result.cleanup = await adapter.cleanup(); }
    catch { result.cleanup = { confirmed: false, errors: ['Cleanup failed'] }; }
    if (!result.cleanup.confirmed) result.status = 'failed';
    if (before) {
      try {
        const after = await inventoryClient.inventory();
        await writeJson(join(privateDirectory, 'inventory-after.json'), after);
        result.inventory = { before: inventoryIdentities(before), after: inventoryIdentities(after) };
        assert.deepEqual(result.inventory.after, result.inventory.before, 'Original resource inventory changed');
        result.checks.originalInventoryPreserved = true;
      } catch { result.errors.push('Independent inventory did not confirm original resources preserved'); result.status = 'failed'; }
    }
    result.lossInjection = loss.state(); result.finishedAt = new Date().toISOString();
    result.evidence = await sealProviderEvidence(privateDirectory);
    await writeJson(join(output, 'result.json'), result);
    const bytes = await readFile(join(output, 'result.json'));
    assert.ok(!bytes.includes(Buffer.from(options.apiKey)), 'Result contains provider credential');
    await writeFile(join(output, 'result.sha256'), `${sha256(bytes)}  result.json\n`, { flag: 'wx', mode: 0o600 });
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { provider: { type: 'string' }, output: { type: 'string' } } });
  assert.ok(values.provider === 'e2b' || values.provider === 'daytona', 'Choose e2b or daytona');
  assert.ok(values.output, 'Use a new output directory');
  const result = await runCaptureResponseLoss({ provider: values.provider,
    apiKey: process.env[`${values.provider.toUpperCase()}_API_KEY`] ?? '', output: values.output });
  console.log(JSON.stringify({ provider: result.provider, status: result.status, checks: result.checks, cleanup: result.cleanup.confirmed, errors: result.errors }));
  process.exitCode = result.status === 'completed' ? 0 : 1;
}
