import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import type { JSONReportSuite } from '@playwright/test/reporter';
import { hashFiles, sha256, snapshotInputs, writeJson } from './evidence.ts';
import { eventRecorder } from './metrics.ts';
import { execute } from './process.ts';
import { readScenario } from './scenario.ts';
import type { Scenario } from './scenario.ts';
import { verifyReport } from './verifier.ts';
import type { ProcessResult, Verification } from './verifier.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));

interface ControlResult {
  id: string;
  expected: string;
  patch: string | null;
  patchSha256: string | null;
  sourceHashes: Record<string, string>;
  verification: Verification;
  process: ProcessResult | null;
  preview: { url: string; readyAt: string; readinessMs: number } | null;
  elapsedMs: number;
  report: string | null;
  error: string | null;
  cleanup: { serverClosed: boolean; previewRevoked: boolean; workspaceRemoved: boolean; confirmed: boolean };
}

async function portableReport(reportPath: string): Promise<void> {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const visit = (suites: JSONReportSuite[]) => {
    for (const suite of suites) {
      for (const spec of suite.specs) {
        for (const test of spec.tests) {
          for (const result of test.results) {
            for (const attachment of result.attachments) {
              if (attachment.path) attachment.path = relative(dirname(reportPath), resolve(dirname(reportPath), attachment.path)).split(sep).join('/');
            }
          }
        }
      }
      visit(suite.suites || []);
    }
  };
  visit(report.suites);
  // Keep the exact reporter output too. Only attachment paths are rewritten in
  // the portable report, so the evidence remains usable after moving the bundle.
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function runControl(
  control: Scenario['controls'][number], scenario: Scenario, output: string, seed: number,
  event: ReturnType<typeof eventRecorder>, signal: AbortSignal,
): Promise<ControlResult> {
  const started = performance.now();
  const directory = join(output, control.id);
  await mkdir(directory);
  const result: ControlResult = {
    id: control.id, expected: control.expected, patch: null, patchSha256: null, sourceHashes: {},
    verification: { status: 'unverified', verifiedExpectedFailure: false, reason: 'Test process did not run.', tests: [], browserVersion: null },
    process: null, preview: null, elapsedMs: 0, report: null, error: null,
    cleanup: { serverClosed: false, previewRevoked: false, workspaceRemoved: false, confirmed: false },
  };
  let workspace: string | undefined;
  let server: Server | undefined;
  await event('control.started', { control: control.id });
  try {
    signal.throwIfAborted();
    workspace = await mkdtemp(join(tmpdir(), 'repo-rodeo-'));
    const app = join(workspace, 'app');
    await cp(join(output, 'inputs', scenario.app), app, { recursive: true });
    if (control.patch) {
      const patch = await readFile(join(output, 'inputs', control.patch));
      await writeFile(join(directory, 'applied.patch'), patch, { flag: 'wx' });
      result.patch = `${control.id}/applied.patch`;
      result.patchSha256 = sha256(patch);
      execFileSync('git', ['apply', '--check', join(directory, 'applied.patch')], { cwd: app, stdio: 'pipe', timeout: 10_000 });
      execFileSync('git', ['apply', join(directory, 'applied.patch')], { cwd: app, stdio: 'pipe', timeout: 10_000 });
    }
    result.sourceHashes = await hashFiles(app);
    await cp(app, join(directory, 'app'), { recursive: true });
    await event('control.prepared', { control: control.id, sourceHashes: result.sourceHashes });

    const serverStarted = performance.now();
    const module = await import(pathToFileURL(join(app, 'server.mjs')).href) as { startServer: (options: { port: number }) => Server };
    server = module.startServer({ port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not allocate a TCP port');
    const url = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${url}${scenario.route}`, { signal: AbortSignal.timeout(5_000) });
    if (response.status !== 200 || !(await response.text()).includes('id="blocks"')) throw new Error('Fixture readiness check failed');
    result.preview = { url, readyAt: new Date().toISOString(), readinessMs: performance.now() - serverStarted };
    await event('preview.ready', { control: control.id, ...result.preview });

    const args = ['node_modules/@playwright/test/cli.js', 'test', '--config', scenario.verifier.config];
    await writeJson(join(directory, 'command.json'), {
      executable: process.execPath, args, timeoutMs: 180_000,
      environment: { REPRO_BASE_URL: url, RODEO_SEED: String(seed) },
    });
    result.process = await execute(process.execPath, args, {
      cwd: repository,
      env: {
        ...process.env, REPRO_BASE_URL: url, RODEO_SEED: String(seed),
        RODEO_JSON_REPORT: join(directory, 'report.json'), RODEO_TEST_OUTPUT: join(directory, 'test-results'),
      },
      stdout: join(directory, 'stdout.log'), stderr: join(directory, 'stderr.log'), timeoutMs: 180_000, signal,
    });
    await writeJson(join(directory, 'process.json'), result.process);
    await cp(join(directory, 'report.json'), join(directory, 'report.raw.json'));
    await portableReport(join(directory, 'report.json'));
    result.report = `${control.id}/report.json`;
    result.verification = await verifyReport(join(directory, 'report.json'), result.process, scenario, seed);
    if (!isDeepStrictEqual(result.sourceHashes, await hashFiles(app))) throw new Error('The app source changed during verification');
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.verification.status = 'unverified';
    result.verification.verifiedExpectedFailure = false;
    result.verification.reason = result.error;
  } finally {
    try {
      if (server) {
        const closed = new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await closed;
      }
      result.cleanup.serverClosed = true;
      // A rejected fetch after closing is the local equivalent of a revoked
      // preview. No claim about provider routing or grant expiry is made here.
      if (result.preview) {
        try {
          await fetch(`${result.preview.url}${scenario.route}`, { signal: AbortSignal.timeout(2_000) });
        } catch {
          result.cleanup.previewRevoked = true;
        }
      } else result.cleanup.previewRevoked = true;
    } catch (error) {
      result.error = `Server cleanup failed: ${String(error)}`;
    }
    try {
      if (workspace) await rm(workspace, { recursive: true });
      result.cleanup.workspaceRemoved = !workspace || await stat(workspace).then(() => false, error => {
        if (error.code === 'ENOENT') return true;
        throw error;
      });
    } catch (error) {
      result.error = `Workspace cleanup failed: ${String(error)}`;
    }
    result.cleanup.confirmed = result.cleanup.serverClosed && result.cleanup.previewRevoked && result.cleanup.workspaceRemoved;
    result.elapsedMs = performance.now() - started;
    await writeJson(join(directory, 'verification.json'), result.verification);
    await writeJson(join(directory, 'cleanup.json'), result.cleanup);
    await event('control.finished', { control: control.id, status: result.verification.status, elapsedMs: result.elapsedMs, cleanup: result.cleanup });
  }
  return result;
}

export async function runLocal(values: { seed?: string; output?: string; help?: boolean }) {
  if (values.help) {
    console.log('npm run experiment -- [--seed <uint32>] [--output <new-directory>]');
    return;
  }
  const seed = values.seed === undefined ? randomBytes(4).readUInt32LE() : Number(values.seed);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || values.seed === '') throw new Error('Seed must be an unsigned 32-bit integer');
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const output = resolve(values.output || join(repository, 'artifacts', runId));
  const scenario = await readScenario(join(repository, 'fixtures/editor/scenario.json'));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Never overwrite an earlier evidence bundle.
  const event = eventRecorder(join(output, 'events.jsonl'));
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error('Experiment interrupted'));
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const started = performance.now();
  const results: ControlResult[] = [];
  let sourceCommit: string | null = null;
  let dirty: boolean | null = null;
  let inputHashes: Record<string, string> = {};
  let error: string | null = null;
  let inputIntegrity = false;
  let playwrightVersion: string | null = null;
  let gitVersion: string | null = null;
  const startedAt = new Date().toISOString();
  console.log(`Evidence: ${output}\nHoldout seed: ${seed}`);
  try {
    await event('run.started', { runId, seed });
    gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    const gitStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repository, encoding: 'utf8' });
    dirty = gitStatus.trim().length > 0;
    await writeFile(join(output, 'git-status.txt'), gitStatus, { flag: 'wx' });
    await writeFile(join(output, 'source.diff'), execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: repository }), { flag: 'wx' });
    inputHashes = await snapshotInputs(repository, join(output, 'inputs'));
    if (process.versions.node !== scenario.runtime.node) throw new Error(`Use Node ${scenario.runtime.node}; found ${process.versions.node}`);
    playwrightVersion = JSON.parse(await readFile(join(repository, 'node_modules/@playwright/test/package.json'), 'utf8')).version;
    if (playwrightVersion !== scenario.runtime.playwright) throw new Error(`Use Playwright ${scenario.runtime.playwright}; run npm ci`);

    for (const control of scenario.controls) {
      const result = await runControl(control, scenario, output, seed, event, abort.signal);
      results.push(result);
      console.log(`${control.id}: ${result.verification.status} — ${result.verification.reason}`);
      if (control.id === 'baseline' && result.verification.status !== 'reproduced') throw new Error('Baseline was not verified; candidate runs were not started');
      abort.signal.throwIfAborted();
    }
    // The verifier runs in this checkout, outside the copied application. Ensure
    // no source, scenario, test or lockfile changed while it was running.
    const current: Record<string, string> = {};
    for (const file of Object.keys(inputHashes)) current[file] = sha256(await readFile(join(repository, file)));
    inputIntegrity = isDeepStrictEqual(current, inputHashes);
    if (!inputIntegrity) throw new Error('Experiment inputs changed during the run');
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    console.error(error);
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    const complete = !error && inputIntegrity && results.length === scenario.controls.length && results.every(result => result.verification.status === result.expected && result.cleanup.confirmed && !result.error);
    await event('run.finished', { status: complete ? 'complete' : 'failed', error });
    const files = await hashFiles(output);
    const manifest = {
      schemaVersion: 1, runId, status: complete ? 'complete' : 'failed', provider: 'local',
      scenario: scenario.id, sourceCommit, source: { dirty, snapshot: 'inputs/', inputHashes, inputIntegrity },
      startedAt, finishedAt: new Date().toISOString(), seed,
      toolVersions: { node: process.versions.node, playwright: playwrightVersion, git: gitVersion },
      host: { platform: platform(), release: release(), arch: arch() },
      checkpoint: { mode: 'filesystem', implementation: 'local temporary directory copies; no process preservation or sandbox isolation' },
      baseline: results.find(result => result.id === 'baseline') || null,
      candidates: results.filter(result => result.id !== 'baseline'),
      measurements: {
        elapsedMs: performance.now() - started,
        scope: 'single local run; not a cloud benchmark',
        costs: { providerCompute: null, persistentStorage: null, modelInference: null, status: 'not-measured' },
      },
      cleanup: { confirmed: results.length > 0 && results.every(result => result.cleanup.confirmed) },
      error, files,
    };
    await writeJson(join(output, 'manifest.json'), manifest);
    await writeFile(join(output, 'manifest.sha256'), `${sha256(await readFile(join(output, 'manifest.json')))}  manifest.json\n`, { flag: 'wx' });
    console.log(`Manifest: ${join(output, 'manifest.json')}`);
    if (!complete) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { seed: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } });
  runLocal(values).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
