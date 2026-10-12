import { readFile } from 'node:fs/promises';

export interface Scenario {
  schemaVersion: 1;
  id: string;
  runtime: { node: string; playwright: string };
  app: string;
  route: string;
  verifier: { config: string; testFile: string; assertion: string; attachment: string; failure: string };
  tests: { id: string; title: string; baseline: 'failed' | 'passed'; observations: number }[];
  controls: { id: string; patch: string | null; expected: 'reproduced' | 'passed' }[];
}

export async function readScenario(path: string): Promise<Scenario> {
  const scenario = JSON.parse(await readFile(path, 'utf8')) as Scenario;
  if (scenario.schemaVersion !== 1 || scenario.id !== 'editor-first-block') {
    throw new Error('Unsupported scenario; this runner implements editor-first-block version 1');
  }
  if (scenario.tests.length !== 6 || new Set(scenario.tests.map(test => test.id)).size !== 6) {
    throw new Error('The scenario must describe all six independent editor tests');
  }
  return scenario;
}
