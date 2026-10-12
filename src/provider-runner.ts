import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { sha256, snapshotInputs, sealProviderEvidence, writeJson } from './evidence.ts';
import { readScenario } from './scenario.ts';
import { prepareSource } from './experiment-source.ts';
import { verifyPreview } from './browser-verification.ts';
import { previewStatus } from './preview.ts';
import { exportObservations } from './public-evidence.ts';
import { redact } from './experiment-result.ts';
import type { Check, ExperimentResult } from './experiment-result.ts';
import type { Execution, ExperimentMode, Inventory, Operation, Preview, ProcessProbe, ProviderAdapter, ProviderName, Sandbox } from './providers/interface.ts';
import { MainbrellaAdapter } from './providers/mainbrella.ts';
import { E2BAdapter } from './providers/e2b.ts';
import { DaytonaAdapter } from './providers/daytona.ts';

function cloudAdapter(provider: ProviderName, config: { apiUrl: string; apiKey: string; directory: string }) {
  return provider === 'e2b' ? new E2BAdapter(config) : provider === 'daytona' ? new DaytonaAdapter(config) : new MainbrellaAdapter(config);
}

const repository = fileURLToPath(new URL('../', import.meta.url));
export interface ProviderRunOptions {
  provider: ProviderName;
  mode: ExperimentMode;
  seed: number;
  output?: string;
  source?: string;
  sourceRef?: string;
  apiUrl: string;
  apiKey?: string;
  size: string;
  checkIdempotency: boolean;
}
interface RunServices {
  adapter: (options: { apiUrl: string; apiKey: string; directory: string }) => ProviderAdapter;
  verify: typeof verifyPreview;
  previewStatus: typeof previewStatus;
}
interface GuestState {
  hashes: Record<string, string>;
  dependencyHash: string | null;
  prepared: string;
  mode: number;
  link: string;
  branchMarker: string | null;
  process: ProcessProbe;
}
function untested(detail: string): Check { return { status: 'not-exercised', detail }; }
function verified(detail: string): Check { return { status: 'verified', detail }; }
function requireSuccess(job: Execution) {
  if (job.exitCode !== 0 || job.timedOut || job.outputTruncated) throw new Error('Guest command failed, timed out, or lost output; inspect private execution receipts');
  return job.stdout;
}
export function checkCapacity(inventory: Inventory, diskBytes: number) {
  const limits = inventory.workspaceLimits;
  const usage = inventory.workspaceUsage;
  if (!limits || !usage) throw new Error('Workspace quotas are unavailable; use an account with saved-workspace access');
  if (!Number.isFinite(diskBytes) || diskBytes <= 0 ||
    ![usage.saved, usage.reservedBytes, usage.savesThisMonth, usage.captureBytesThisMonth, usage.retainedCaptureBytes,
      limits.maxSaved, limits.maxReservedBytes, limits.maxSavesPerMonth, limits.maxCaptureBytesPerMonth, limits.maxRetainedCaptureBytes,
      inventory.activeContainers, inventory.containerLimits?.maxContainers].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    throw new Error('Provider capacity data is incomplete or invalid; provisioning was not attempted');
  }
  if (usage.saved + 1 > limits.maxSaved || usage.reservedBytes + diskBytes > limits.maxReservedBytes
    || usage.savesThisMonth + 1 > limits.maxSavesPerMonth || usage.captureBytesThisMonth + diskBytes > limits.maxCaptureBytesPerMonth
    || usage.retainedCaptureBytes + diskBytes > limits.maxRetainedCaptureBytes) {
    throw new Error('Workspace quota preflight failed; existing resources were left untouched. Use a test account with capture allowance');
  }
  if (inventory.containerLimits && inventory.activeContainers + 4 > inventory.containerLimits.maxContainers) {
    throw new Error('The account needs capacity for four additional containers');
  }
}

export async function runProvider(options: ProviderRunOptions, services: RunServices = {
  adapter: config => cloudAdapter(options.provider, config), verify: verifyPreview, previewStatus,
}): Promise<ExperimentResult> {
  const runId = `${options.provider}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const output = resolve(options.output || join(repository, 'artifacts', runId));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 }); // A prior run can only be opened by cleanup.
  const privateDirectory = join(output, 'private');
  await mkdir(privateDirectory, { mode: 0o700 });
  const started = performance.now();
  const result: ExperimentResult = {
    schemaVersion: 2, runId, provider: options.provider, mode: options.mode, status: 'failed', scope: 'not-run',
    startedAt: new Date().toISOString(), finishedAt: '', seed: options.seed, capabilities: null,
    source: { kind: options.source ? 'web-checkout' : 'standalone', commit: null, archiveSha256: null, inputHashes: {}, integrity: false },
    environment: { host: { node: process.versions.node, platform: platform(), arch: arch(), playwright: null },
      guest: null, requested: { image: 'node', size: options.size }, observedResourceLimits: null, model: null, billing: 'not-measured' },
    controls: [], checks: {
      filesystem: untested('Restore not attempted.'), processes: untested('Process probes not compared.'), isolation: untested('Branch writes not checked.'),
      jobReattachment: untested('API stream reconnect not attempted; dashboard sessions are outside this runner.'),
      captureIdempotency: untested('Response-loss experiment not requested.'), previewRevocation: untested('No previews issued.'),
    }, storage: { captureBytes: null, before: null, afterCapture: null, afterCleanup: null }, cleanup: null,
    measurements: { elapsedMs: 0, comparableBenchmark: false, costs: null }, errors: [], evidence: { privateDirectory: 'private', files: {}, publicObservations: {} },
  };
  let adapter: ProviderAdapter | undefined;
  const previews: { sandbox: Sandbox; preview: Preview }[] = [];
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error('Experiment interrupted'));
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  let activeCheck: keyof ExperimentResult['checks'] | undefined;
  const operation = (name: string, timeoutMs = 60_000): Operation => ({ name, timeoutMs, signal: abort.signal });
  const progress = (message: string) => console.log(message);
  const inspect = async (sandbox: Sandbox, name: string): Promise<GuestState> => {
    const text = requireSuccess(await adapter!.execute(sandbox, { ...operation(name), argv: ['node', '/workspace/rodeo-inspect.mjs'] }));
    return JSON.parse(text);
  };
  const launch = async (sandbox: Sandbox, name: string) => {
    const request = {
      ...operation(`${name}-launch`), cwd: '/workspace/rodeo',
      env: { VITE_API_URL: options.provider !== 'mainbrella' ? 'http://localhost:8787' : options.apiUrl,
        ...(options.provider === 'e2b' ? { RODEO_ALLOWED_HOSTS: '.e2b.app' } : {}),
        ...(options.provider === 'daytona' ? { RODEO_ALLOWED_HOSTS: '.proxy.daytona.work,.proxy.daytona.works' } : {}) },
      argv: ['/bin/sh', '-c', `setsid node rodeo-server.mjs ${result.source.kind} > /workspace/rodeo-server.log 2>&1 < /dev/null &`],
    };
    let server: Execution | undefined;
    if (options.provider !== 'mainbrella') {
      server = await adapter!.startJob(sandbox, { ...request, timeoutMs: 30 * 60_000,
        argv: ['node', 'rodeo-server.mjs', result.source.kind] });
      await writeJson(join(privateDirectory, `${name}-server-job.json`), server);
    } else requireSuccess(await adapter!.execute(sandbox, request));
    // The managed launcher exiting is not proof that its detached HTTP server is ready.
    for (let attempt = 0; attempt < 15; attempt++) {
      const state = await inspect(sandbox, `${name}-ready-${attempt}`);
      if (state.process.serverReachable) return state;
      await pause(500, undefined, { signal: abort.signal });
    }
    if (server) {
      try { await writeJson(join(privateDirectory, `${name}-server-diagnostics.json`), await adapter!.getJob(sandbox, server.id)); }
      catch { /* Preserve the original readiness failure. */ }
    }
    throw new Error('Guest HTTP server did not become ready');
  };
  const publish = async (sandbox: Sandbox, name: string) => {
    const preview = await adapter!.preview(sandbox, { ...operation(`${name}-preview`), port: 5173 });
    previews.push({ sandbox, preview });
    await writeFile(join(privateDirectory, 'previews.json'), `${JSON.stringify(previews, null, 2)}\n`, { mode: 0o600 });
    const denied = preview.headers ? await services.previewStatus(preview.url, '/repo-rodeo-bug') : null;
    if (denied !== null && !(options.provider === 'daytona' ? [401, 403] : [403]).includes(denied)) throw new Error('Protected preview did not reject unauthenticated access');
    if (await services.previewStatus(preview.url, '/repo-rodeo-bug', preview.headers) !== 200) throw new Error('Preview readiness did not return HTTP 200');
    return preview;
  };
  try {
    progress(`Evidence: ${output}`);
    const scenario = await readScenario(join(repository, 'fixtures/editor/scenario.json'));
    if (process.versions.node !== scenario.runtime.node) throw new Error(`Use Node ${scenario.runtime.node}`);
    const playwrightVersion = JSON.parse(await readFile(join(repository, 'node_modules/@playwright/test/package.json'), 'utf8')).version;
    result.environment.host.playwright = playwrightVersion;
    if (playwrightVersion !== scenario.runtime.playwright) throw new Error('Pinned Playwright is required; run npm ci');
    if (!options.apiKey) throw new Error(`Set ${options.provider === 'e2b' ? 'E2B_API_KEY' : options.provider === 'daytona' ? 'DAYTONA_API_KEY' : 'MAINBRELLA_API_KEY'} for the test account`);
    const api = new URL(options.apiUrl);
    if (api.username || api.password || api.search || api.hash || api.pathname !== (options.provider === 'daytona' ? '/api' : '/')) throw new Error('Invalid provider API URL');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname);
    if (api.protocol !== 'https:' && !(local && api.protocol === 'http:')) throw new Error('Remote API origins require HTTPS');
    result.scope = local ? 'local-api' : 'cloud-api';
    const apiUrl = options.provider === 'daytona' ? `${api.origin}/api` : api.origin;
    await writeJson(join(privateDirectory, 'connection.json'), { schemaVersion: 1, provider: options.provider, apiUrl });
    adapter = services.adapter({ apiUrl, apiKey: options.apiKey, directory: privateDirectory });
    result.capabilities = await adapter.capabilities();
    const mode = result.capabilities.modes[options.mode];
    if (mode.status !== 'supported') {
      result.status = 'unsupported';
      result.errors.push(`${options.mode}: ${mode.reason}`);
      return result;
    }
    if (!result.capabilities.previews || !result.capabilities.managedJobs) throw new Error('The deployment must support protected previews and managed executions');
    const before = await adapter.inventory();
    result.storage.before = before.workspaceUsage;
    const resource = result.capabilities.resources.find(resource => resource.id === options.size);
    if (!resource) throw new Error('Requested size is absent from the deployment resource catalog');
    Object.assign(result.environment.requested, { cpuVcpu: resource.cpuVcpu, memoryMiB: resource.memoryMiB, diskGB: resource.diskGB });
    if (options.provider === 'mainbrella') {
      if (!resource.diskGB) throw new Error('Provider disk size is unavailable');
      checkCapacity(before, resource.diskGB * 1_000_000_000);
    }
    const inputs = join(privateDirectory, 'inputs');
    result.source.inputHashes = await snapshotInputs(repository, inputs);
    const source = await prepareSource({ repository, inputs, directory: privateDirectory, scenario, source: options.source, sourceRef: options.sourceRef });
    result.source.commit = source.commit;
    result.source.archiveSha256 = sha256(source.archive);
    progress('Preparing one source container.');
    if (options.provider === 'e2b') result.environment.requested.image = 'base';
    if (options.provider === 'daytona') result.environment.requested.image = 'default';
    const { sandbox } = await adapter.create({ ...operation('source-create', 180_000), image: result.environment.requested.image, size: options.size });
    if (options.provider !== 'mainbrella') {
      assert.match(scenario.runtime.node, /^\d+\.\d+\.\d+$/);
      const archive = `node-v${scenario.runtime.node}-linux-x64.tar.xz`;
      requireSuccess(await adapter.execute(sandbox, { ...operation('source-runtime', 300_000), argv: ['/bin/sh', '-c',
        `set -eu; test "$(uname -m)" = x86_64; mkdir -p /tmp/rodeo-runtime /opt/rodeo-node; cd /tmp/rodeo-runtime; ` +
        `curl -fsSLO https://nodejs.org/dist/v${scenario.runtime.node}/${archive}; ` +
        `curl -fsSLO https://nodejs.org/dist/v${scenario.runtime.node}/SHASUMS256.txt; ` +
        `awk '$2 == "${archive}" { print; count++ } END { if (count != 1) exit 1 }' SHASUMS256.txt > runtime.sha256; ` +
        `sha256sum --check --status runtime.sha256; tar -xJf ${archive} -C /opt/rodeo-node --strip-components=1; /opt/rodeo-node/bin/node --version`,
      ] }));
    }
    await adapter.upload(sandbox, { ...operation('source-upload', 300_000), path: '/workspace/rodeo.tar.gz', bytes: source.archive });
    requireSuccess(await adapter.execute(sandbox, { ...operation('source-extract'), argv: ['/bin/sh', '-c', 'mkdir -p /workspace/rodeo && tar -xzf /workspace/rodeo.tar.gz -C /workspace/rodeo'] }));
    for (const [name, path, bytes] of [
      ['launcher', '/workspace/rodeo/rodeo-server.mjs', await readFile(join(inputs, 'src/guest/launch.mjs'))],
      ['inspector', '/workspace/rodeo-inspect.mjs', await readFile(join(inputs, 'src/guest/inspect.mjs'))],
      ['inventory', '/workspace/rodeo-files.json', Buffer.from(JSON.stringify(Object.keys(source.hashes)))],
    ] as const) await adapter.upload(sandbox, { ...operation(`source-${name}-upload`, 300_000), path, bytes });
    if (source.kind === 'web-checkout') {
      requireSuccess(await adapter.execute(sandbox, { ...operation('source-install', 600_000), argv: ['npm', 'ci', '--no-audit', '--no-fund'], cwd: '/workspace/rodeo' }));
      requireSuccess(await adapter.execute(sandbox, { ...operation('source-typecheck', 180_000), argv: ['npm', 'run', 'type-check'], cwd: '/workspace/rodeo' }));
    }
    requireSuccess(await adapter.execute(sandbox, { ...operation('source-markers'), argv: ['node', '-e',
      "const fs=require('node:fs');fs.writeFileSync('/workspace/rodeo-prepared',process.argv[1],{mode:0o755});fs.symlinkSync('/workspace/rodeo-prepared','/workspace/rodeo-link')", runId] }));
    const toolOutput = requireSuccess(await adapter.execute(sandbox, { ...operation('guest-tools'), argv: ['node', '-e',
      "console.log(JSON.stringify({node:process.versions.node,npm:require('node:child_process').execFileSync('npm',['--version'],{encoding:'utf8'}).trim()}))"] }));
    const guestTools = JSON.parse(toolOutput);
    if (typeof guestTools.node !== 'string' || typeof guestTools.npm !== 'string') throw new Error('Guest tool versions were not reported');
    result.environment.guest = { node: guestTools.node, npm: guestTools.npm };
    const original = await launch(sandbox, 'source');
    assert.deepEqual(original.hashes, source.hashes, 'Source integrity failed before capture');
    if (source.kind === 'web-checkout') assert.ok(original.dependencyHash, 'Installed dependency lockfile missing');
    const sourcePreview = await publish(sandbox, 'source');
    const baseline = await services.verify({ repository, directory: join(privateDirectory, 'prepared-baseline'), url: sourcePreview.url, headers: sourcePreview.headers, seed: options.seed, scenario, signal: abort.signal });
    if (baseline.status !== 'reproduced') throw new Error('Prepared baseline was not verified; capture and candidates were not started');

    progress('Capturing prepared state and creating three controls.');
    const checkIdempotency = options.checkIdempotency && options.provider === 'mainbrella';
    if (options.checkIdempotency && !checkIdempotency) result.checks.captureIdempotency = { status: 'unsupported', detail: `${options.provider === 'e2b' ? 'E2B' : 'Daytona'} has no documented keyed create/fork/snapshot replay contract; no response-loss mutation was reissued.` };
    activeCheck = checkIdempotency ? 'captureIdempotency' : undefined;
    const captureOperation = { ...operation('prepared-capture', options.provider === 'daytona' ? 600_000 : 180_000), mode: options.mode, dropResponseAfterHeaders: checkIdempotency };
    const prepared = await adapter.capture(sandbox, captureOperation);
    result.storage.captureBytes = prepared.bytes;
    const afterCapture = await adapter.inventory();
    result.storage.afterCapture = afterCapture.workspaceUsage;
    if (checkIdempotency) {
      const replay = await adapter.capture(sandbox, captureOperation);
      const afterReplay = await adapter.inventory();
      assert.equal(replay.id, prepared.id, 'Capture replay returned another workspace');
      assert.deepEqual(afterReplay.workspaceUsage, afterCapture.workspaceUsage, 'Replay changed workspace reservations');
      assert.ok(afterCapture.workspaceUsage && before.workspaceUsage && resource.diskGB, 'Capture accounting is unavailable');
      assert.equal(afterCapture.workspaceUsage.savesThisMonth - before.workspaceUsage.savesThisMonth, 1, 'Capture count did not increase by one');
      assert.equal(afterCapture.workspaceUsage.captureBytesThisMonth - before.workspaceUsage.captureBytesThisMonth, resource.diskGB * 1_000_000_000, 'Unexpected capture reservation');
      assert.equal(afterCapture.workspaceUsage.retainedCaptureBytes - before.workspaceUsage.retainedCaptureBytes, resource.diskGB * 1_000_000_000, 'Unexpected retained reservation');
      assert.deepEqual(afterCapture.workspaces.map(item => item.id).sort(), [...before.workspaces.map(item => item.id), prepared.id].sort(), 'Unexpected workspace inventory delta');
      result.checks.captureIdempotency = verified('Discarded the first successful response body after receiving backend headers; identical keyed retry and replay recovered one workspace with one capture reservation.');
    }
    activeCheck = 'processes';
    const after = await inspect(sandbox, 'source-after-capture');
    if (options.provider === 'daytona') {
      assert.equal(after.process.serverReachable, false, 'Stopped container snapshot unexpectedly retained its source listener');
      const resumed = await launch(sandbox, 'source-resumed');
      assert.ok(resumed.process.nonce && resumed.process.nonce !== original.process.nonce, 'Source restart reused pre-capture process state');
    } else {
      assert.equal(after.process.nonce, original.process.nonce, 'Capture changed the source process nonce');
      assert.equal(after.process.pid, original.process.pid, 'Capture changed the source PID');
    }
    const branches: { id: string; sandbox: Sandbox; nonce: string | null; hashes: Record<string, string> }[] = [];
    for (const control of scenario.controls) {
      activeCheck = 'filesystem';
      const { sandbox: branch } = await adapter.spawn(prepared, operation(`${control.id}-restore`, 180_000));
      const restored = await inspect(branch, `${control.id}-restored-state`);
      assert.deepEqual(restored.hashes, source.hashes, 'Restored source changed');
      assert.equal(restored.prepared, original.prepared, 'Prepared marker changed');
      assert.equal(restored.mode, original.mode, 'Prepared permissions changed');
      assert.equal(restored.link, original.link, 'Prepared symlink changed');
      assert.equal(restored.dependencyHash, original.dependencyHash, 'Prepared dependencies changed');
      activeCheck = 'processes';
      if (prepared.preservation === 'filesystem+memory') {
        assert.equal(restored.process.serverReachable, true, 'Memory fork lost its listener');
        assert.equal(restored.process.nonce, original.process.nonce, 'Memory fork lost the source nonce');
        assert.equal(restored.process.pid, original.process.pid, 'Memory fork changed the source PID');
        assert.ok(Number.isInteger(restored.process.pid) && restored.process.pid! > 1, 'Memory fork process PID is invalid');
        requireSuccess(await adapter.execute(branch, { ...operation(`${control.id}-stop-inherited-server`), argv: ['node', '-e',
          "process.kill(Number(process.argv[1]),'SIGTERM')", String(restored.process.pid)] }));
        for (let attempt = 0; attempt < 15; attempt++) {
          if (!(await inspect(branch, `${control.id}-stopped-${attempt}`)).process.serverReachable) break;
          if (attempt === 14) throw new Error('Inherited server did not stop before patch verification');
          await pause(100, undefined, { signal: abort.signal });
        }
      } else assert.equal(restored.process.serverReachable, false, 'Filesystem restore unexpectedly retained a listener');
      activeCheck = 'isolation';
      assert.equal(restored.branchMarker, null, 'Restore contained another branch marker');
      requireSuccess(await adapter.execute(branch, { ...operation(`${control.id}-write-marker`), argv: ['node', '-e',
        "require('node:fs').writeFileSync('/workspace/rodeo-branch',process.argv[1])", control.id] }));
      const patch = source.patches[control.id];
      const record = { id: control.id, expected: control.expected, patchSha256: patch ? sha256(patch.bytes) : null,
        sourceHashes: patch?.hashes || source.hashes, verification: null };
      result.controls.push(record);
      activeCheck = undefined;
      if (patch) {
        await adapter.upload(branch, { ...operation(`${control.id}-patch-upload`), path: '/workspace/rodeo.patch', bytes: patch.bytes });
        requireSuccess(await adapter.execute(branch, { ...operation(`${control.id}-patch`), argv: ['git', 'apply', '/workspace/rodeo.patch'], cwd: '/workspace/rodeo' }));
      }
      const running = await launch(branch, control.id);
      assert.deepEqual(running.hashes, record.sourceHashes, 'Patched guest source differs from the retained patch');
      assert.ok(running.process.nonce && running.process.nonce !== original.process.nonce, 'Restored server reused source process state');
      branches.push({ id: control.id, sandbox: branch, nonce: running.process.nonce, hashes: record.sourceHashes });
      const preview = await publish(branch, control.id);
      const verification = await services.verify({ repository, directory: join(privateDirectory, control.id), url: preview.url, headers: preview.headers, seed: options.seed, scenario, signal: abort.signal });
      result.controls[result.controls.length - 1].verification = verification;
      progress(`${control.id}: ${verification.status}`);
      assert.deepEqual((await inspect(branch, `${control.id}-after-tests`)).hashes, record.sourceHashes, 'Guest source changed during verification');
      if (verification.status !== control.expected) throw new Error(`${control.id} did not match the expected verification`);
    }
    activeCheck = 'isolation';
    const branchMarkers: string[] = [];
    for (const branch of branches) {
      const state = await inspect(branch.sandbox, `${branch.id}-isolation`);
      assert.deepEqual(state.hashes, branch.hashes, `Later branch writes changed ${branch.id}'s source`);
      assert.equal(state.branchMarker, branch.id, 'Branch marker leaked');
      branchMarkers.push(state.branchMarker);
    }
    assert.equal(new Set(branchMarkers).size, branches.length, 'Branch markers are not independent');
    const sourceAfterBranches = await inspect(sandbox, 'source-isolation');
    assert.equal(sourceAfterBranches.branchMarker, null, 'Branch writes reached the source');
    assert.deepEqual(sourceAfterBranches.hashes, source.hashes, 'Branch patches reached the source');
    result.checks.isolation = verified('After all controls finished, each branch retained its expected patched hashes and a distinct marker; the source marker stayed absent and its tracked files stayed unchanged.');
    result.checks.filesystem = verified(`Three restores retained source hashes, prepared marker, permissions and symlink${source.kind === 'web-checkout' ? ', plus installed dependencies without another npm ci' : '; the standalone fixture has no install step'}.`);
    activeCheck = 'processes';
    assert.equal(new Set(branches.map(branch => branch.nonce)).size, 3, 'Restored servers reused a process nonce');
    result.checks.processes = verified(prepared.preservation === 'filesystem+memory'
      ? 'Source nonce/PID survived capture; each memory fork retained the listener, nonce and PID. Its inherited server was stopped, then explicitly restarted with a distinct nonce for patch verification.'
      : options.provider === 'daytona'
      ? 'Container capture explicitly stopped and restarted its source; the source listener was absent after restart and its server received a fresh nonce when relaunched. Each filesystem restore had no listener, then a distinct nonce after explicitly starting a server.'
      : 'Source nonce/PID survived capture; each restore had no listener, then a distinct nonce after explicitly starting a server.');
    activeCheck = 'jobReattachment';
    if (result.capabilities.jobReattachment) {
      const job = await adapter.startJob(sandbox, { ...operation('reattach-job', 30_000), argv: ['node', '-e',
        "console.log('rodeo-reconnect-start');setTimeout(()=>console.log('rodeo-reconnect-done'),8000)"] });
      const first = await adapter.readEvents(sandbox, job.id, 0, 'rodeo-reconnect-start');
      assert.ok(first.text.includes('rodeo-reconnect-start'), 'First stream had no start output');
      assert.ok(!first.text.includes('rodeo-reconnect-done'), 'Job finished before disconnection');
      const secondClient = services.adapter({ apiUrl: options.apiUrl, apiKey: options.apiKey, directory: privateDirectory });
      let record = await secondClient.getJob(sandbox, job.id);
      for (let attempt = 0; attempt < 30 && !['succeeded', 'failed', 'canceled', 'timed_out', 'interrupted', 'output_limit'].includes(record.status); attempt++) {
        await pause(500, undefined, { signal: abort.signal });
        record = await secondClient.getJob(sandbox, job.id);
      }
      requireSuccess(record);
      assert.equal(record.id, job.id, 'Reconnection changed the execution ID');
      assert.ok(record.stdout.includes('rodeo-reconnect-start') && record.stdout.includes('rodeo-reconnect-done'), 'Reconnection lost retained output');
      const remaining = await secondClient.readEvents(sandbox, job.id, first.cursor);
      assert.ok(remaining.text.includes('rodeo-reconnect-done'), 'Cursor replay lost remaining output');
      await writeJson(join(privateDirectory, 'reattachment.json'), { executionId: job.id, first, record, remaining });
      result.checks.jobReattachment = verified(options.provider === 'e2b'
        ? 'An E2B SDK command stream disconnected after initial output; a new SDK client reconnected to the same sandbox and command PID. It recovered exit 0 and durable guest stdout, then read the remaining bytes from the saved offset. This is not server-side SSE cursor replay or dashboard reconnection.'
        : options.provider === 'daytona'
        ? 'After initial session output, the first polling client detached. A new Daytona SDK client recovered the same session and command IDs, exit 0 and retained stdout, then read remaining bytes from the saved offset. Live stream disconnection, server SSE replay and dashboard reconnection were not exercised.'
        : 'An API SSE client disconnected after initial output; a new client recovered the same execution ID, exit 0 and remaining output from its cursor. Dashboard/browser session reconnection was not exercised.');
    } else result.checks.jobReattachment = { status: 'unsupported', detail: 'Deployment does not advertise managed execution reconnection.' };
    activeCheck = undefined;
    const current: Record<string, string> = {};
    for (const file of Object.keys(result.source.inputHashes)) current[file] = sha256(await readFile(join(repository, file)));
    result.source.integrity = isDeepStrictEqual(current, result.source.inputHashes);
    if (!result.source.integrity) throw new Error('Host experiment inputs changed while the run was active');
    result.status = 'complete';
  } catch (error) {
    const message = String(redact(error instanceof Error ? error.message : String(error), [options.apiKey || '']));
    result.errors.push(message);
    if (activeCheck) result.checks[activeCheck] = { status: 'failed', detail: message };
    result.status = 'failed';
  } finally {
    progress('Reconciling and cleaning up this run’s resources.');
    if (adapter) {
      for (const { sandbox, preview } of previews) {
        try { await adapter.revokePreview(sandbox, preview, { name: `revoke-${preview.id}`, timeoutMs: 30_000 }); }
        catch { /* Destroy below also invalidates grants, including lost issuance responses. */ }
      }
      try { result.cleanup = await adapter.cleanup(); }
      catch { result.errors.push('Cleanup could not complete; retry the cleanup command using this evidence directory.'); }
      if (!result.cleanup?.confirmed) {
        result.status = 'failed';
        result.errors.push('API cleanup is unconfirmed; inspect private receipts and retry cleanup.');
      }
      try { result.storage.afterCleanup = (await adapter.inventory()).workspaceUsage; }
      catch { result.errors.push('Post-cleanup accounting could not be read.'); if (result.status === 'complete') result.status = 'failed'; }
      if (previews.length) {
        const statuses: number[] = [];
        for (const { preview } of previews) {
          try { statuses.push(await services.previewStatus(preview.url, '/repo-rodeo-bug', preview.headers)); } catch { statuses.push(0); }
        }
        await writeJson(join(privateDirectory, 'preview-revocation.json'), { statuses });
        result.checks.previewRevocation = statuses.every(status => status === 404 || status === 410)
          ? verified(`${statuses.length} preview URLs returned HTTP 404/410 after cleanup.`)
          : { status: 'failed', detail: 'A preview did not confirm revocation with HTTP 404/410; network failures are inconclusive.' };
        if (result.checks.previewRevocation.status === 'failed') result.status = 'failed';
      }
    }
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    result.finishedAt = new Date().toISOString();
    result.measurements.elapsedMs = performance.now() - started;
    try {
      result.evidence.files = await sealProviderEvidence(privateDirectory);
      result.evidence.publicObservations = await exportObservations(privateDirectory, join(output, 'observations'), result.controls,
        [options.apiKey || '', ...previews.flatMap(item => [item.preview.url, ...Object.values(item.preview.headers ?? {})])]);
    } catch {
      result.errors.push('Evidence export failed; inspect the private evidence before sharing.');
      result.status = 'failed';
    }
    await writeJson(join(output, 'result.json'), redact(result, [options.apiKey || '', ...previews.flatMap(item => [item.preview.url, ...Object.values(item.preview.headers ?? {})])]));
    await writeFile(join(output, 'result.sha256'), `${sha256(await readFile(join(output, 'result.json')))}  result.json\n`, { flag: 'wx' });
    progress(`Result: ${join(output, 'result.json')} (${result.status})`);
  }
  return result;
}

export async function cleanupRun(directory: string, apiKey: string) {
  const output = resolve(directory);
  const privateDirectory = join(output, 'private');
  const config = JSON.parse(await readFile(join(privateDirectory, 'connection.json'), 'utf8'));
  if (!['mainbrella', 'e2b', 'daytona'].includes(config.provider) || config.schemaVersion !== 1) throw new Error('Unsupported cleanup metadata');
  const adapter = cloudAdapter(config.provider, { apiUrl: config.apiUrl, apiKey, directory: privateDirectory });
  const cleanup = await adapter.cleanup();
  let previews: { preview: Preview }[] = [];
  try { previews = JSON.parse(await readFile(join(privateDirectory, 'previews.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const statuses = [];
  for (const { preview } of previews) {
    try { statuses.push(await previewStatus(preview.url, '/repo-rodeo-bug', preview.headers)); } catch { statuses.push(0); }
  }
  const report = { schemaVersion: 2, kind: 'cleanup-reconciliation', completedAt: new Date().toISOString(), cleanup,
    previewStatuses: statuses, confirmed: cleanup.confirmed && statuses.every(status => status === 404 || status === 410) };
  const path = join(output, `cleanup-${Date.now()}.json`);
  await writeJson(path, redact(report, [apiKey]));
  console.log(`Cleanup: ${path}`);
  return report.confirmed;
}
