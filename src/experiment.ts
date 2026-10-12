import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { ExperimentMode, ProviderName } from './providers/interface.ts';
import { redact } from './experiment-result.ts';

async function main() {
  const { values } = parseArgs({ options: {
    provider: { type: 'string', default: 'local' }, mode: { type: 'string', default: 'saved-workspace' },
    seed: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
    source: { type: 'string' }, 'source-ref': { type: 'string' },
    'api-url': { type: 'string' }, size: { type: 'string', default: 'small' },
    'check-idempotency': { type: 'boolean', default: false }, cleanup: { type: 'string' },
  } });
  if (values.help) {
    console.log(`npm run experiment -- [--provider local|mainbrella|e2b|daytona] [--seed <uint32>] [--output <new-directory>]

Provider options:
  --mode saved-workspace|filesystem-fork|memory-fork|volume|warm-pool
  --source <web-checkout> --source-ref <commit>   Otherwise use the bundled editor
  --api-url <origin>                            Default MAINBRELLA_API_URL or http://localhost:8787
  --size <catalog-size>                         Default small
  --check-idempotency                           Discard an accepted capture response, then retry the same key
  --cleanup <run-directory>                     Reconcile and remove only that run's resources

Set MAINBRELLA_API_KEY in the host environment. Keys are never uploaded.
E2B and Daytona currently emit schema-version-2 unsupported results (exit 2).
Provider runs keep raw evidence under private/ and write a sanitized result.json.
The standalone local runner retains its original version-1 manifest format.`);
    return;
  }
  if (!['local', 'mainbrella', 'e2b', 'daytona'].includes(values.provider)) throw new Error('Unknown provider');
  const modes = ['saved-workspace', 'filesystem-fork', 'memory-fork', 'volume', 'warm-pool'];
  if (!modes.includes(values.mode)) throw new Error('Unknown experiment mode');
  const seed = values.seed === undefined ? randomBytes(4).readUInt32LE() : Number(values.seed);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || values.seed === '') throw new Error('Seed must be an unsigned 32-bit integer');
  if (values.cleanup) {
    if (!process.env.MAINBRELLA_API_KEY) throw new Error('Set MAINBRELLA_API_KEY to reconcile this run');
    const { cleanupRun } = await import('./provider-runner.ts');
    process.exitCode = await cleanupRun(values.cleanup, process.env.MAINBRELLA_API_KEY) ? 0 : 1;
    return;
  }
  if (values.provider === 'local') {
    if (values.source || values['source-ref'] || values['api-url'] || values['check-idempotency'] || values.mode !== 'saved-workspace' || values.size !== 'small') {
      throw new Error('Source, API, size, mode and idempotency options require a provider');
    }
    const { runLocal } = await import('./runner.ts');
    await runLocal({ seed: String(seed), output: values.output });
    return;
  }
  if (values['source-ref'] && !values.source) throw new Error('--source-ref requires --source');
  const { runProvider } = await import('./provider-runner.ts');
  const result = await runProvider({
    provider: values.provider as ProviderName, mode: values.mode as ExperimentMode, seed, output: values.output,
    source: values.source, sourceRef: values['source-ref'], apiUrl: values['api-url'] || process.env.MAINBRELLA_API_URL || 'http://localhost:8787',
    apiKey: process.env.MAINBRELLA_API_KEY, size: values.size, checkIdempotency: values['check-idempotency'],
  });
  for (const error of result.errors) console.error(redact(error, [process.env.MAINBRELLA_API_KEY || '']));
  process.exitCode = result.status === 'complete' ? 0 : result.status === 'unsupported' ? 2 : 1;
}

main().catch(error => {
  console.error(redact(error instanceof Error ? error.message : String(error), [process.env.MAINBRELLA_API_KEY || '']));
  process.exitCode = 1;
});
