import { mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hashFiles, writeJson } from './evidence.ts';
import { redact } from './experiment-result.ts';
import type { ProviderControl } from './experiment-result.ts';

// Export only structured document observations from completed verifier results.
// Raw reports, traces, screenshots, commands and receipts never cross this boundary.
export async function exportObservations(privateDirectory: string, destination: string, controls: ProviderControl[], secrets: string[]) {
  await mkdir(destination, { mode: 0o700 });
  for (const control of controls) {
    if (!control.verification || control.verification.status === 'unverified') continue;
    const directory = join(privateDirectory, control.id);
    await mkdir(join(destination, control.id));
    for (const test of control.verification.tests) {
      const path = await realpath(resolve(directory, test.evidence));
      const rel = relative(await realpath(directory), path);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Observation path escaped the control directory');
      const input = JSON.parse(await readFile(path, 'utf8'));
      if (input.schemaVersion !== 1 || input.caseId !== test.id || input.browserVersion !== control.verification.browserVersion ||
        !Array.isArray(input.runtimeErrors) || input.runtimeErrors.length || !Array.isArray(input.observations) || input.observations.length !== test.observations) {
        throw new Error('Observation identity or outcome changed after verification');
      }
      const blocks = (value: { id: string; text: string }[]) => value.map(block => ({ id: block.id, text: block.text }));
      const evidence = {
        schemaVersion: input.schemaVersion, caseId: input.caseId, seed: input.seed, browserVersion: input.browserVersion,
        runtimeErrors: [],
        observations: input.observations.map((observation: {
          expected: { id: string; text: string }[]; beforeSave: { id: string; text: string }[];
          afterSave: { id: string; text: string }[]; actual: { id: string; text: string }[]; reload: string;
        }) => ({ expected: blocks(observation.expected), beforeSave: blocks(observation.beforeSave),
          afterSave: blocks(observation.afterSave), actual: blocks(observation.actual), reload: observation.reload })),
      };
      await writeJson(join(destination, control.id, `${test.id}.json`), redact(evidence, secrets));
    }
  }
  return hashFiles(destination);
}
