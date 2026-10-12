// Matched editor runs plus independent inventory and a separate, live HTTP control.
// Credentials are read from the environment and never written to shared evidence.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { runProvider } from './provider-runner.ts';
import { MainbrellaAdapter } from './providers/mainbrella.ts';
import { E2BAdapter } from './providers/e2b.ts';
import { DaytonaAdapter } from './providers/daytona.ts';
import type { CleanupResult, Inventory, Preview, ProviderName, Sandbox } from './providers/interface.ts';
import { assessPreviewRevocation, probePreviewRevocation } from './preview-revocation.ts';
import { previewStatus } from './preview.ts';
import { redact } from './experiment-result.ts';
import { sha256, writeJson } from './evidence.ts';

const { values } = parseArgs({ options: { provider: { type: 'string' }, output: { type: 'string' }, source: { type: 'string' }, 'source-ref': { type: 'string' } } });
assert.ok(['mainbrella', 'e2b', 'daytona'].includes(values.provider ?? ''), 'Choose a provider');
assert.ok(values.output && values.source && values['source-ref'], 'Output, source and source-ref are required');
const provider = values.provider as ProviderName;
const apiUrl = provider === 'mainbrella' ? 'https://api.mainbrella.com' : provider === 'e2b' ? 'https://api.e2b.dev' : 'https://app.daytona.io/api';
const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`];
assert.ok(apiKey, 'Provider credential is required');
const output = resolve(values.output);
await mkdir(output, { mode: 0o700 });
const makeAdapter = (name: string) => {
  const options = { apiUrl, apiKey, directory: join(output, name) };
  return provider === 'mainbrella' ? new MainbrellaAdapter(options) : provider === 'e2b' ? new E2BAdapter(options) : new DaytonaAdapter(options);
};
const inventoryClient = makeAdapter('private-inventory');
const before = await inventoryClient.inventory();
await writeJson(join(output, 'private-inventory-before.json'), before);
const diff = execFileSync('git', ['diff', '--binary', 'HEAD'], { encoding: 'utf8' });
await writeFile(join(output, 'runner.patch'), diff);
const result = await runProvider({ provider, mode: provider === 'e2b' ? 'memory-fork' : 'saved-workspace', seed: 12345,
  output: join(output, 'editor'), source: values.source, sourceRef: values['source-ref'], apiUrl, apiKey,
  size: provider === 'mainbrella' ? 'small' : provider === 'e2b' ? 'base' : 'default', checkIdempotency: false });
const afterEditor = await inventoryClient.inventory();
await writeJson(join(output, 'private-inventory-after-editor.json'), afterEditor);
const runPrivate = join(output, 'editor/private');
const previews: { sandbox: Sandbox; preview: Preview }[] = [...new Map((JSON.parse(await readFile(join(runPrivate, 'previews.json'), 'utf8')) as { sandbox: Sandbox; preview: Preview }[]).map(item => [item.preview.url, item])).values()];
const beforeCleanup = JSON.parse(await readFile(join(runPrivate, 'preview-before-cleanup.json'), 'utf8')).probes;
const control = makeAdapter('private-live-control');
let controlCleanup: CleanupResult | null = null;
let liveControlStatus = 0;
let probes: Awaited<ReturnType<typeof probePreviewRevocation>> = [];
const errors: string[] = [];
try {
  // Provision after deleting the four editor sandboxes: capacity stays bounded.
  const { sandbox } = await control.create({ name: 'live-control-create', timeoutMs: 180_000, image: provider === 'mainbrella' ? 'node' : provider === 'e2b' ? 'base' : 'default', size: provider === 'mainbrella' ? 'small' : provider === 'e2b' ? 'base' : 'default' });
  await control.startJob(sandbox, { name: 'live-control-server', timeoutMs: 120_000, argv: ['node', '-e',
    "require('node:http').createServer((q,s)=>{s.writeHead(200,{'content-type':'text/plain'});s.end('repo-rodeo-live-control')}).listen(5173,'0.0.0.0')"] });
  const preview = await control.preview(sandbox, { name: 'live-control-preview', timeoutMs: 30_000, port: 5173 });
  for (let i = 0; i < 20; i++) {
    try { liveControlStatus = await previewStatus(preview.url, '/repo-rodeo-bug', preview.headers); } catch { liveControlStatus = 0; }
    if (liveControlStatus === 200) break;
    await pause(500);
  }
  assert.equal(liveControlStatus, 200, 'Known-live control never returned HTTP200');
  probes = await probePreviewRevocation(provider, previews, previewStatus, { beforeCleanup, liveControl: preview });
} catch (error) {
  errors.push(String(redact(error instanceof Error ? error.message : error, [apiKey])));
} finally {
  controlCleanup = await control.cleanup();
}
const after = await inventoryClient.inventory();
await writeJson(join(output, 'private-inventory-after.json'), after);
const identities = (inventory: Inventory) => ({ sandboxes: inventory.sandboxes.map(s => `${s.id}/${s.generation}`).sort(), workspaces: inventory.workspaces.map(s => s.id).sort() });
const initial = identities(before), final = identities(after);
const inventoryRestored = JSON.stringify(initial) === JSON.stringify(final);
const report = { schemaVersion: 1, kind: 'matched-editor-cleanup-followup', provider, seed: 12345, sourceRef: values['source-ref'],
  runner: { commit: result.runner.commit, dirty: result.runner.dirty, patchSha256: sha256(diff), inputHashes: result.source.inputHashes },
  editor: { status: result.status, controls: result.controls.map(c => ({ id: c.id, status: c.verification?.status })), checks: result.checks },
  cleanup: result.cleanup, liveControl: { initialStatus: liveControlStatus, cleanup: controlCleanup }, probes,
  previewApplicationAccess: assessPreviewRevocation(provider, result.cleanup, probes),
  independentTokenInvalidation: { status: 'not-exercised', detail: 'Deletion and gateway responses do not prove independent invalidation of a credential for a still-live resource. Any separate source restart token check is reported in editor.checks.' },
  inventory: { before: initial, after: final, restoredExactly: inventoryRestored }, physicalStorage: 'not-measured', errors,
  completedAt: new Date().toISOString() };
await writeJson(join(output, 'followup.json'), report);
await writeFile(join(output, 'followup.sha256'), `${sha256(await readFile(join(output, 'followup.json')))}  followup.json\n`);
console.log(JSON.stringify({ provider, editorStatus: result.status, controls: report.editor.controls, cleanup: result.cleanup?.confirmed, liveControlStatus,
  liveControlCleanup: controlCleanup?.confirmed, previewAccess: report.previewApplicationAccess.status, inventoryRestored, errors }));
process.exitCode = result.status === 'complete' && controlCleanup?.confirmed && inventoryRestored && !errors.length ? 0 : 1;
