import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { readScenario } from '../src/scenario.ts';
import { verifyReport, type ProcessResult, type Verification } from '../src/verifier.ts';

type ReportResult = {
  retry: number;
  status: string;
  errors: { message?: string }[];
  attachments: { name: string; path?: string }[];
};
type ReportTest = { expectedStatus: string; results: ReportResult[] };
type ReportSpec = { title: string; tests: ReportTest[] };
type EvidenceBlock = { id: string; text: string };
type EvidenceObservation = {
  expected: EvidenceBlock[];
  beforeSave: EvidenceBlock[];
  afterSave: EvidenceBlock[];
  actual: EvidenceBlock[];
  reload: 'refresh' | 'control';
};
type CaseEvidence = {
  schemaVersion: number;
  caseId: string;
  seed: number;
  browserVersion: string;
  runtimeErrors: string[];
  observations: EvidenceObservation[];
};
type FixtureBundle = {
  root: string;
  report: { errors: unknown[]; suites: { specs: ReportSpec[] }[] };
  evidence: Map<string, CaseEvidence>;
  persistEvidence(): Promise<void>;
};

const seed = 481516;
const scenarioPath = fileURLToPath(new URL('../fixtures/editor/scenario.json', import.meta.url));
const scenario = await readScenario(scenarioPath);
const expectedBlocks: EvidenceBlock[] = [
  { id: 'heading', text: 'Friday demo' },
  { id: 'paragraph', text: 'Bring something that almost works.' },
  { id: 'button', text: 'Join the waitlist' },
];

async function makeBundle(t: TestContext, mode: 'passed' | 'seeded' = 'passed'): Promise<FixtureBundle> {
  const root = await mkdtemp(join(tmpdir(), 'repo-rodeo-verifier-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = new Map<string, CaseEvidence>();
  const specs: ReportSpec[] = [];

  for (const definition of scenario.tests) {
    const failed = mode === 'seeded' && definition.baseline === 'failed';
    const observationCount = definition.id === 'reset-isolation' ? 0 : failed ? 1 : definition.observations;
    const observations: EvidenceObservation[] = Array.from({ length: observationCount }, () => ({
      expected: expectedBlocks.map(block => ({ ...block })),
      beforeSave: expectedBlocks.map(block => ({ ...block })),
      afterSave: expectedBlocks.map(block => ({ ...block })),
      actual: failed ? expectedBlocks.slice(1).map(block => ({ ...block })) : expectedBlocks.map(block => ({ ...block })),
      reload: definition.id.includes('refresh') ? 'refresh' : 'control',
    }));
    const documentEvidence: CaseEvidence = {
      schemaVersion: 1,
      caseId: definition.id,
      seed,
      browserVersion: 'Chromium 140.0.7339.0',
      runtimeErrors: [],
      observations,
    };
    evidence.set(definition.id, documentEvidence);

    const attachmentDirectory = join(root, 'artifacts');
    await mkdir(attachmentDirectory, { recursive: true });
    const evidencePath = `artifacts/${definition.id}.json`;
    await writeFile(join(root, evidencePath), JSON.stringify(documentEvidence));
    const tracePath = `artifacts/${definition.id}.zip`;
    const screenshotPath = `artifacts/${definition.id}.png`;
    await writeFile(join(root, tracePath), 'trace bytes');
    await writeFile(join(root, screenshotPath), 'screenshot bytes');

    const result: ReportResult = {
      retry: 0,
      status: failed ? 'failed' : 'passed',
      errors: failed ? [{ message: scenario.verifier.assertion }] : [],
      attachments: [
        { name: scenario.verifier.attachment, path: evidencePath },
        { name: 'trace', path: tracePath },
        { name: 'screenshot', path: screenshotPath },
      ],
    };
    specs.push({
      title: `${definition.id}: ${definition.title}`,
      tests: [{ expectedStatus: 'passed', results: [result] }],
    });
  }

  const report = { errors: [], suites: [{ specs }] };
  await writeFile(join(root, 'report.json'), JSON.stringify(report));
  return {
    root,
    report,
    evidence,
    async persistEvidence() {
      for (const [id, documentEvidence] of evidence) {
        await writeFile(join(root, 'artifacts', `${id}.json`), JSON.stringify(documentEvidence));
      }
    },
  };
}

function normalProcess(exitCode: number): ProcessResult {
  return { exitCode, signal: null, timedOut: false };
}

async function check(bundle: FixtureBundle, process = normalProcess(0)): Promise<Verification> {
  await bundle.persistEvidence();
  await writeFile(join(bundle.root, 'report.json'), JSON.stringify(bundle.report));
  return verifyReport(join(bundle.root, 'report.json'), process, scenario, seed);
}

function firstResult(bundle: FixtureBundle, testIndex = 0): ReportResult {
  return bundle.report.suites[0].specs[testIndex].tests[0].results[0];
}

test('recognizes the exact seeded first-block-loss pattern only with exit code 1', async t => {
  const bundle = await makeBundle(t, 'seeded');
  const result = await check(bundle, normalProcess(1));
  assert.equal(result.status, 'reproduced');
  assert.equal(result.verifiedExpectedFailure, true);
  assert.equal(result.tests.length, 6);
  assert.equal(result.tests.filter(item => item.status === 'failed').length, 5);
  assert.equal(result.tests.find(item => item.id === 'reset-isolation')?.status, 'passed');

  const wrongExit = await check(bundle, normalProcess(0));
  assert.equal(wrongExit.status, 'unverified');
  assert.match(wrongExit.reason, /Exit code disagrees/);
});

test('recognizes all six passing tests only with exit code 0', async t => {
  const bundle = await makeBundle(t);
  const result = await check(bundle);
  assert.equal(result.status, 'passed');
  assert.equal(result.verifiedExpectedFailure, false);
  assert.equal(result.tests.length, 6);
  assert.equal(result.tests.every(item => item.status === 'passed'), true);

  const wrongExit = await check(bundle, normalProcess(1));
  assert.equal(wrongExit.status, 'unverified');
  assert.match(wrongExit.reason, /Exit code disagrees/);
});

type BundleMutation = (bundle: FixtureBundle) => void | Promise<void>;
const invalidReports: { name: string; mutate: BundleMutation; process?: ProcessResult }[] = [
  { name: 'runner or browser launch error', mutate: bundle => { bundle.report.errors.push({ message: 'browser launch failed' }); } },
  { name: 'HTTP or runtime error', mutate: bundle => { bundle.evidence.get('button-refresh')!.runtimeErrors.push('HTTP 404 at /repo-rodeo-bug'); } },
  { name: 'wrong missing block', mutate: bundle => { bundle.evidence.get('button-refresh')!.observations[0].actual = expectedBlocks.slice(0, 2); } },
  { name: 'wrong block text', mutate: bundle => { bundle.evidence.get('button-refresh')!.observations[0].actual[0].text = 'Changed heading'; } },
  { name: 'wrong block order', mutate: bundle => { bundle.evidence.get('button-refresh')!.observations[0].actual.reverse(); } },
  { name: 'loss before save', mutate: bundle => { bundle.evidence.get('button-refresh')!.observations[0].beforeSave = expectedBlocks.slice(1); } },
  { name: 'reset regression', mutate: bundle => { firstResult(bundle, 4).status = 'failed'; firstResult(bundle, 4).errors = [{ message: scenario.verifier.assertion }]; } },
  { name: 'partial test set', mutate: bundle => { bundle.report.suites[0].specs.pop(); } },
  { name: 'duplicate test', mutate: bundle => { bundle.report.suites[0].specs[1] = structuredClone(bundle.report.suites[0].specs[0]); } },
  { name: 'extra test', mutate: bundle => { bundle.report.suites[0].specs.push({ title: 'unexpected test', tests: structuredClone(bundle.report.suites[0].specs[0].tests) }); } },
  { name: 'partial observations', mutate: bundle => { bundle.evidence.get('edited-text')!.observations.pop(); } },
  { name: 'retry', mutate: bundle => { firstResult(bundle).retry = 1; } },
  { name: 'skipped test', mutate: bundle => { firstResult(bundle).status = 'skipped'; } },
  { name: 'timed out test', mutate: bundle => { firstResult(bundle).status = 'timedOut'; } },
  { name: 'interrupted test', mutate: bundle => { firstResult(bundle).status = 'interrupted'; } },
  { name: 'timed out process', mutate: () => {}, process: { exitCode: null, signal: null, timedOut: true } },
  { name: 'signal exit', mutate: () => {}, process: { exitCode: null, signal: 'SIGTERM', timedOut: false } },
  { name: 'expected failure annotation', mutate: bundle => { bundle.report.suites[0].specs[0].tests[0].expectedStatus = 'failed'; } },
  { name: 'missing trace', mutate: bundle => { firstResult(bundle).attachments = firstResult(bundle).attachments.filter(item => item.name !== 'trace'); } },
  { name: 'missing screenshot', mutate: bundle => { firstResult(bundle).attachments = firstResult(bundle).attachments.filter(item => item.name !== 'screenshot'); } },
  { name: 'mismatched seed', mutate: bundle => { bundle.evidence.get('button-refresh')!.seed += 1; } },
  { name: 'artifact path escape', mutate: bundle => { firstResult(bundle).attachments[0].path = '../../etc/passwd'; } },
];

for (const { name, mutate, process } of invalidReports) {
  test(`does not verify ${name}`, async t => {
    const bundle = await makeBundle(t);
    await mutate(bundle);
    const result = await check(bundle, process ?? normalProcess(0));
    assert.equal(result.status, 'unverified');
    assert.ok(result.reason.length > 0);
  });
}

test('rejects missing and malformed report files', async t => {
  const bundle = await makeBundle(t);
  const missing = await verifyReport(join(bundle.root, 'missing.json'), normalProcess(0), scenario, seed);
  assert.equal(missing.status, 'unverified');

  await writeFile(join(bundle.root, 'bad.json'), '{');
  const malformed = await verifyReport(join(bundle.root, 'bad.json'), normalProcess(0), scenario, seed);
  assert.equal(malformed.status, 'unverified');
});

test('does not accept matching loss observations with an unrelated assertion failure', async t => {
  const bundle = await makeBundle(t, 'seeded');
  firstResult(bundle).errors = [{ message: 'HTTP 404: page.goto failed' }];
  const result = await check(bundle, normalProcess(1));
  assert.equal(result.status, 'unverified');
  assert.equal(result.verifiedExpectedFailure, false);
  assert.match(result.reason, /not the document-preservation assertion/);
});

test('a teardown error invalidates an otherwise correct reproduction', async t => {
  const bundle = await makeBundle(t, 'seeded');
  firstResult(bundle).errors.push({ message: 'Browser process crashed during teardown' });
  const result = await check(bundle, normalProcess(1));
  assert.equal(result.status, 'unverified');
});

test('rejects a seeded report that lost a different block', async t => {
  const bundle = await makeBundle(t, 'seeded');
  bundle.evidence.get('button-refresh')!.observations[0].actual = expectedBlocks.slice(0, 2);
  const result = await check(bundle, normalProcess(1));
  assert.equal(result.status, 'unverified');
  assert.match(result.reason, /exactly the first block/);
});

test('rejects an existing artifact outside the evidence bundle', async t => {
  const bundle = await makeBundle(t, 'seeded');
  const external = await mkdtemp(join(tmpdir(), 'repo-rodeo-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const path = join(external, 'document.json');
  await writeFile(path, JSON.stringify(bundle.evidence.get('button-refresh')));
  firstResult(bundle).attachments[0].path = path;
  const result = await check(bundle, normalProcess(1));
  assert.equal(result.status, 'unverified');
  assert.match(result.reason, /escaped the result directory/);
});

