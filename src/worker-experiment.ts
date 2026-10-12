import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { hashFiles, sealProviderEvidence, sha256, writeJson } from './evidence.ts';
import { redact } from './experiment-result.ts';
import { MainbrellaAdapter } from './providers/mainbrella.ts';
import { E2BAdapter } from './providers/e2b.ts';
import { DaytonaAdapter } from './providers/daytona.ts';
import { checkCapacity } from './provider-runner.ts';
import { makeWorkerLedger, verifyWorker } from './worker-verifier.ts';
import type { WorkerProbe, WorkerResponse } from './worker-verifier.ts';
import type { Execution, ExperimentMode, Operation, Preview, ProviderAdapter, ProviderName, Sandbox } from './providers/interface.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const guest = '/workspace/memory-worker';
const fixture = join(repository, 'fixtures/memory-worker');
const runtime = '22.22.2';
const guestNode = '/opt/rodeo-node/bin/node';
const controls = ['baseline', 'correct', 'misleading'] as const;
const success = (execution: Execution) => {
  if (execution.exitCode !== 0 || execution.timedOut || execution.outputTruncated) throw new Error('Worker guest command failed; inspect private evidence');
  return execution.stdout;
};

export async function workerRequest<T>(preview: Pick<Preview, 'url' | 'headers'>, route: string, body?: unknown): Promise<T> {
  const url = new URL(route, preview.url);
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...preview.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Worker ${route} returned HTTP ${response.status}`);
  return await response.json() as T;
}

export interface WorkerRunOptions { provider: ProviderName; apiKey: string; apiUrl: string; output: string; seed: number; size?: string }
export async function runWorkerExperiment(options: WorkerRunOptions) {
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  const privateDirectory = join(output, 'private');
  await mkdir(privateDirectory, { mode: 0o700 });
  const mode: ExperimentMode = options.provider === 'e2b' ? 'memory-fork' : 'saved-workspace';
  const configuration = { apiKey: options.apiKey, apiUrl: options.apiUrl, directory: privateDirectory };
  const adapter: ProviderAdapter = options.provider === 'e2b' ? new E2BAdapter(configuration) :
    options.provider === 'daytona' ? new DaytonaAdapter(configuration) : new MainbrellaAdapter(configuration);
  const runId = `worker-${options.provider}-${randomUUID()}`;
  const ledger = makeWorkerLedger(options.seed, randomUUID());
  const result: any = {
    schemaVersion: 1, experiment: 'volatile-worker-repair', runId, provider: options.provider, mode,
    status: 'failed', startedAt: new Date().toISOString(), seed: options.seed,
    runner: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
      dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim() },
    inputHashes: {}, hostNode: process.versions.node, guestNode: null, ledger, source: {}, branches: [],
    coldRestart: null, cleanup: null, errors: [], limitations: [
      'Deterministic supplied patches; no autonomous repair agent.',
      'The worker imports the candidate processor from disk at an explicit paused checkpoint. This is not transparent replacement of a running function.',
      'Pending inputs are sent once by the outside verifier, remain only in worker RAM, and are never re-enqueued into restored branches.',
      'Filesystem restores are allowed to lose RAM. Reproduction lost is a capability observation, never a successful repair or general provider failure.',
      'Fresh managed commands and fresh protected HTTP connections are used after copying; inherited network connections are not tested.',
      'API resource deletion is measured; physical snapshot erasure, cost and performance are not measured.',
    ],
  };
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error('Worker experiment interrupted'));
  process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
  const operation = (name: string, timeoutMs = 60_000): Operation => ({ name, timeoutMs, signal: abort.signal });
  const observation = async (name: string, value: unknown) => { await writeJson(join(output, `${name}.json`), value); return value; };
  const inspect = async (sandbox: Sandbox, name: string): Promise<{ process: WorkerProbe | null; hashes: Record<string, string> }> => {
    const script = `const fs=require('node:fs'),crypto=require('node:crypto');const hashes={};for(const name of ['server.mjs','processor.mjs','prepared-marker'])hashes[name]=crypto.createHash('sha256').update(fs.readFileSync('${guest}/'+name)).digest('hex');fetch('http://127.0.0.1:5173/probe',{signal:AbortSignal.timeout(3000)}).then(r=>r.json()).then(process=>console.log(JSON.stringify({process,hashes}))).catch(()=>console.log(JSON.stringify({process:null,hashes})));`;
    return JSON.parse(success(await adapter.execute(sandbox, { ...operation(name), argv: [guestNode, '-e', script] })));
  };
  const launch = async (sandbox: Sandbox, name: string) => {
    const request = { ...operation(`${name}-launch`, 30 * 60_000), argv: [guestNode, `${guest}/server.mjs`], cwd: guest };
    if (options.provider === 'mainbrella') {
      success(await adapter.execute(sandbox, { ...request, timeoutMs: 60_000,
        argv: ['/bin/sh', '-c', `setsid ${guestNode} ${guest}/server.mjs > ${guest}/worker.log 2>&1 < /dev/null &`] }));
    } else await adapter.startJob(sandbox, request);
    for (let attempt = 0; attempt < 20; attempt++) {
      const state = await inspect(sandbox, `${name}-ready-${attempt}`);
      if (state.process) return state;
      await pause(500, undefined, { signal: abort.signal });
    }
    throw new Error('Worker did not become ready');
  };
  const previews: { sandbox: Sandbox; preview: Preview }[] = [];
  const publish = async (sandbox: Sandbox, name: string) => {
    const preview = await adapter.preview(sandbox, { ...operation(`${name}-preview`), port: 5173 });
    previews.push({ sandbox, preview });
    await writeFile(join(privateDirectory, 'previews.json'), `${JSON.stringify(previews, null, 2)}\n`, { mode: 0o600 });
    return preview;
  };
  try {
    if (!options.apiKey) throw new Error('Provider credential is required');
    if (process.versions.node !== runtime) throw new Error(`Use Node ${runtime}`);
    const inputs = join(privateDirectory, 'inputs');
    await mkdir(inputs);
    await cp(fixture, join(inputs, 'fixtures/memory-worker'), { recursive: true });
    await cp(join(repository, 'src'), join(inputs, 'src'), { recursive: true });
    await mkdir(join(inputs, 'tests'));
    await cp(join(repository, 'tests/worker-experiment.test.ts'), join(inputs, 'tests/worker-experiment.test.ts'));
    for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', '.node-version', '.nvmrc']) await cp(join(repository, file), join(inputs, file));
    result.inputHashes = await hashFiles(inputs);
    await writeJson(join(privateDirectory, 'connection.json'), { schemaVersion: 1, provider: options.provider, apiUrl: options.apiUrl });
    const capabilities = await adapter.capabilities();
    assert.equal(capabilities.modes[mode].status, 'supported');
    result.capabilities = capabilities;
    const before = await adapter.inventory();
    await observation('inventory-before', before);
    const size = options.size || (options.provider === 'e2b' ? 'base' : options.provider === 'daytona' ? 'default' : 'small');
    const resource = capabilities.resources.find(resource => resource.id === size);
    assert.ok(resource, 'Requested resource size is unavailable');
    if (options.provider === 'mainbrella') checkCapacity(before, resource.diskGB! * 1e9);
    console.log(`${options.provider}: preparing volatile worker`);
    const { sandbox: source } = await adapter.create({ ...operation('worker-source-create', 180_000),
      image: options.provider === 'e2b' ? 'base' : options.provider === 'daytona' ? 'default' : 'node', size });
    result.source.sandbox = source;
    // The Mainbrella catalog image currently starts with Node 24. Pin all three
    // providers explicitly, and invoke this exact binary rather than ambient PATH.
    success(await adapter.execute(source, { ...operation('worker-runtime', 300_000), argv: ['/bin/sh', '-c',
      `set -eu; case "$(uname -m)" in x86_64) rodeo_arch=x64;; aarch64) rodeo_arch=arm64;; *) exit 1;; esac; ` +
      `rodeo_archive=node-v${runtime}-linux-$rodeo_arch.tar.gz; mkdir -p /tmp/rodeo-runtime /opt/rodeo-node; cd /tmp/rodeo-runtime; ` +
      `curl -fsSLO https://nodejs.org/dist/v${runtime}/$rodeo_archive; curl -fsSLO https://nodejs.org/dist/v${runtime}/SHASUMS256.txt; ` +
      `awk -v name="$rodeo_archive" '$2 == name { print; count++ } END { if (count != 1) exit 1 }' SHASUMS256.txt > runtime.sha256; ` +
      `sha256sum --check --status runtime.sha256; tar -xzf "$rodeo_archive" -C /opt/rodeo-node --strip-components=1; ${guestNode} --version`,
    ] }));
    success(await adapter.execute(source, { ...operation('worker-mkdir'), argv: ['mkdir', '-p', guest] }));
    for (const file of ['server.mjs', 'processor.mjs']) await adapter.upload(source, {
      ...operation(`worker-upload-${file}`), path: `${guest}/${file}`, bytes: await readFile(join(inputs, 'fixtures/memory-worker', file)),
    });
    await adapter.upload(source, { ...operation('worker-marker'), path: `${guest}/prepared-marker`, bytes: Buffer.from(runId) });
    const initial = await launch(source, 'source');
    result.guestNode = initial.process!.node;
    assert.equal(result.guestNode, runtime);
    let sourcePreview = await publish(source, 'source');
    const sourcePrepared = await workerRequest<WorkerProbe>(sourcePreview, '/prepare', { preparationId: ledger.preparationId, jobs: ledger.jobs });
    assert.equal(sourcePrepared.pending, ledger.jobs.length);
    assert.equal(sourcePrepared.inputFingerprint, ledger.fingerprint);
    result.source.prepared = await observation('source-prepared', { ...await inspect(source, 'source-prepared'), process: sourcePrepared });
    console.log(`${options.provider}: capturing paused queue and making three branches`);
    const prepared = await adapter.capture(source, { ...operation('worker-capture', options.provider === 'daytona' ? 600_000 : 180_000), mode });
    result.capture = { id: prepared.id, preservation: prepared.preservation, bytes: prepared.bytes };
    const sourceAfter = await inspect(source, 'source-after-capture');
    result.source.afterCapture = await observation('source-after-capture', sourceAfter);
    if (prepared.preservation === 'filesystem+memory') assert.deepEqual(sourceAfter.process, sourcePrepared);
    const branches: { id: typeof controls[number]; sandbox: Sandbox; preview: Preview; before: WorkerProbe; inherited: boolean }[] = [];
    for (const id of controls) {
      const { sandbox } = await adapter.spawn(prepared, { ...operation(`worker-spawn-${id}`, 180_000) });
      const beforeLaunch = await inspect(sandbox, `${id}-before-launch`);
      assert.deepEqual(beforeLaunch.hashes, initial.hashes, 'Captured files changed');
      const inherited = !!beforeLaunch.process;
      if (prepared.preservation === 'filesystem+memory') assert.deepEqual(beforeLaunch.process, sourcePrepared, 'Memory branch did not inherit the paused worker');
      else assert.equal(beforeLaunch.process, null, 'Filesystem snapshot unexpectedly inherited worker process');
      const active = beforeLaunch.process ? beforeLaunch : await launch(sandbox, `${id}-fresh`);
      const preview = await publish(sandbox, id);
      const before = await workerRequest<WorkerProbe>(preview, '/probe');
      assert.deepEqual(before, active.process);
      branches.push({ id, sandbox, preview, before, inherited });
      result.branches.push({ id, sandbox, inherited, beforeLaunch, before });
    }
    // Mutate RAM independently, then inspect every branch and the source.
    for (const branch of branches) await workerRequest(branch.preview, '/marker', { marker: branch.id });
    for (const branch of branches) assert.equal((await workerRequest<WorkerProbe>(branch.preview, '/probe')).marker, branch.id);
    const isolatedSource = await inspect(source, 'source-after-branch-markers');
    assert.deepEqual(isolatedSource.process, sourceAfter.process, 'Branch writes changed the source worker');
    result.source.afterIsolation = await observation('source-after-isolation', isolatedSource);
    result.isolation = { status: 'verified', detail: 'Each branch retained its own RAM marker; source process state matched its post-capture observation.' };
    for (const branch of branches) {
      assert.deepEqual((await inspect(branch.sandbox, `${branch.id}-before-patch`)).hashes, initial.hashes, 'Another branch patch changed this branch files');
      if (branch.id !== 'baseline') await adapter.upload(branch.sandbox, { ...operation(`${branch.id}-patch`),
        path: `${guest}/processor.mjs`, bytes: await readFile(join(inputs, 'fixtures/memory-worker', `${branch.id}.mjs`)) });
      const before = await workerRequest<WorkerProbe>(branch.preview, '/probe');
      assert.equal(before.nonce, branch.before.nonce, 'Patching restarted the worker');
      const after = await workerRequest<WorkerResponse>(branch.preview, '/resume', {});
      const verification = verifyWorker(ledger, before, after);
      const record = result.branches.find((value: any) => value.id === branch.id);
      Object.assign(record, { beforeResume: before, after, verification });
      await observation(`branch-${branch.id}`, record);
      if (branch.inherited) {
        assert.equal(verification.status, branch.id === 'correct' ? 'passed' : 'rejected');
        assert.equal(after.claimedCompleted, true);
        assert.equal(verification.actualCount, branch.id === 'baseline' ? 3 : branch.id === 'correct' ? 5 : 0);
      } else assert.equal(verification.status, 'reproduction-lost');
      console.log(`${options.provider}: ${branch.id} ${verification.status}, ${verification.actualCount}/${verification.expectedCount} receipts`);
    }
    const sourceBeforeRestart = await inspect(source, 'source-before-cold-restart');
    assert.deepEqual(sourceBeforeRestart.process, sourceAfter.process, 'Repair branches changed their source');
    assert.deepEqual(sourceBeforeRestart.hashes, initial.hashes, 'Repair branches changed source files');
    if (sourceBeforeRestart.process) {
      success(await adapter.execute(source, { ...operation('source-kill-worker'),
        argv: [guestNode, '-e', 'process.kill(Number(process.argv[1]),"SIGTERM")', String(sourceBeforeRestart.process.pid)] }));
      let stopped = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        if (!(await inspect(source, `source-stopped-${attempt}`)).process) { stopped = true; break; }
        await pause(250, undefined, { signal: abort.signal });
      }
      assert.ok(stopped, 'Source worker did not stop before cold restart');
    }
    await adapter.upload(source, { ...operation('cold-correct-patch'), path: `${guest}/processor.mjs`,
      bytes: await readFile(join(inputs, 'fixtures/memory-worker/correct.mjs')) });
    const coldState = await launch(source, 'cold');
    if (options.provider === 'daytona') sourcePreview = await publish(source, 'cold');
    const coldBefore = await workerRequest<WorkerProbe>(sourcePreview, '/probe');
    assert.notEqual(coldBefore.nonce, sourcePrepared.nonce);
    assert.equal(coldBefore.pending, 0);
    const coldAfter = await workerRequest<WorkerResponse>(sourcePreview, '/resume', {});
    const coldVerification = verifyWorker(ledger, coldBefore, coldAfter);
    assert.equal(coldVerification.status, 'reproduction-lost');
    result.coldRestart = await observation('cold-restart', { before: sourceBeforeRestart, fresh: coldState, after: coldAfter, verification: coldVerification });
    result.status = 'completed';
  } catch (error) {
    result.errors.push(redact(error instanceof Error ? error.message : String(error), [options.apiKey]));
  } finally {
    console.log(`${options.provider}: cleaning up exact run-owned resources`);
    try { result.cleanup = await adapter.cleanup(); }
    catch (error) { result.errors.push(redact(error instanceof Error ? error.message : String(error), [options.apiKey])); }
    if (!result.cleanup?.confirmed) result.status = 'failed';
    try { await observation('inventory-after', await adapter.inventory()); } catch { result.errors.push('Post-cleanup inventory unavailable'); result.status = 'failed'; }
    result.finishedAt = new Date().toISOString();
    result.evidence = { privateDirectory: 'private', files: await sealProviderEvidence(privateDirectory) };
    await writeJson(join(output, 'result.json'), result);
    await writeFile(join(output, 'result.sha256'), `${sha256(await readFile(join(output, 'result.json')))}  result.json\n`);
    process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { provider: { type: 'string' }, output: { type: 'string' }, seed: { type: 'string', default: '12345' }, size: { type: 'string' } } });
  if (!['e2b', 'mainbrella', 'daytona'].includes(values.provider || '') || !values.output) throw new Error('Use --provider e2b|mainbrella|daytona --output <new-directory> [--seed 12345]');
  const provider = values.provider as ProviderName;
  const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`] || '';
  const apiUrl = provider === 'e2b' ? 'https://api.e2b.dev' : provider === 'daytona' ? 'https://app.daytona.io/api' : process.env.MAINBRELLA_API_URL || 'https://api.mainbrella.com';
  const result = await runWorkerExperiment({ provider, apiKey, apiUrl, output: values.output, seed: Number(values.seed), size: values.size });
  console.log(JSON.stringify({ provider, status: result.status, controls: result.branches.map((branch: any) => ({ id: branch.id, verification: branch.verification })), cleanup: result.cleanup?.confirmed, errors: result.errors }));
  process.exitCode = result.status === 'completed' ? 0 : 1;
}
