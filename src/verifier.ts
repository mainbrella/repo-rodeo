import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JSONReport, JSONReportSpec, JSONReportSuite } from '@playwright/test/reporter';
import type { Scenario } from './scenario.ts';

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

type Block = { id: string; text: string };
interface Observation {
  expected: Block[];
  beforeSave: Block[];
  afterSave: Block[];
  actual: Block[];
  reload: 'refresh' | 'control';
}
interface DocumentEvidence {
  schemaVersion: number;
  caseId: string;
  seed: number;
  browserVersion: string;
  runtimeErrors: string[];
  observations: Observation[];
}
export interface Verification {
  status: 'passed' | 'reproduced' | 'unverified';
  verifiedExpectedFailure: boolean;
  reason: string;
  tests: { id: string; status: string; observations: number; evidence: string }[];
  browserVersion: string | null;
}

function requireEvidence(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function allSpecs(suites: JSONReportSuite[]): JSONReportSpec[] {
  return suites.flatMap(suite => [...suite.specs, ...allSpecs(suite.suites || [])]);
}

// Paths in the portable JSON report are relative to its directory. Reject
// missing artifacts and links that point outside the retained result directory.
async function artifactPath(root: string, path: string): Promise<string> {
  const absolute = await realpath(resolve(root, path));
  const rel = relative(await realpath(root), absolute);
  requireEvidence(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'Artifact escaped the result directory');
  requireEvidence((await stat(absolute)).size > 0, 'Evidence artifact is empty');
  return absolute;
}

export async function verifyReport(
  reportPath: string,
  process: ProcessResult,
  scenario: Scenario,
  seed: number,
): Promise<Verification> {
  const verification: Verification = {
    status: 'unverified', verifiedExpectedFailure: false, reason: '', tests: [], browserVersion: null,
  };
  try {
    requireEvidence(!process.timedOut && !process.signal, 'The browser test process did not finish normally');
    requireEvidence(process.exitCode === 0 || process.exitCode === 1, 'Unexpected browser test exit code');
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as JSONReport;
    requireEvidence(Array.isArray(report.errors) && report.errors.length === 0, 'Playwright reported a runner or setup error');
    const specs = allSpecs(report.suites);
    requireEvidence(specs.length === scenario.tests.length, 'The report is missing tests or contains extra tests');
    const titles = new Set(specs.map(spec => spec.title));
    requireEvidence(titles.size === specs.length, 'Duplicate tests in the report');

    for (const definition of scenario.tests) {
      const spec = specs.find(item => item.title === `${definition.id}: ${definition.title}`);
      requireEvidence(spec && spec.tests.length === 1, `Missing or duplicated test: ${definition.id}`);
      const test = spec.tests[0];
      requireEvidence(test.expectedStatus === 'passed' && test.results.length === 1, 'Retries or expected failures cannot establish reproduction');
      const result = test.results[0];
      requireEvidence(result.retry === 0 && ['passed', 'failed'].includes(result.status || ''), 'Skipped, interrupted, timed out or retried test');
      const attachment = result.attachments.filter(item => item.name === scenario.verifier.attachment);
      requireEvidence(attachment.length === 1 && attachment[0].path, `Missing document evidence: ${definition.id}`);
      const path = await artifactPath(dirname(reportPath), attachment[0].path);
      const evidence = JSON.parse(await readFile(path, 'utf8')) as DocumentEvidence;
      requireEvidence(evidence.schemaVersion === 1 && evidence.caseId === definition.id && evidence.seed === seed, 'Evidence identity or random seed mismatch');
      requireEvidence(Array.isArray(evidence.runtimeErrors) && evidence.runtimeErrors.length === 0, 'Browser or HTTP errors invalidate the observation');
      requireEvidence(typeof evidence.browserVersion === 'string' && evidence.browserVersion.length > 0, 'Missing browser version');
      verification.browserVersion ??= evidence.browserVersion;
      requireEvidence(verification.browserVersion === evidence.browserVersion, 'Browser version changed during the run');

      for (const name of ['trace', 'screenshot']) {
        const artifacts = result.attachments.filter(item => item.name === name);
        requireEvidence(artifacts.length > 0, `Missing ${name}: ${definition.id}`);
        for (const artifact of artifacts) {
          requireEvidence(artifact.path, `Missing ${name} path`);
          await artifactPath(dirname(reportPath), artifact.path);
        }
      }

      requireEvidence(Array.isArray(evidence.observations), 'Missing document observations');
      for (const observation of evidence.observations) {
        requireEvidence(Array.isArray(observation.expected) && observation.expected.length === 3, 'Expected document must contain all three blocks');
        requireEvidence(new Set(observation.expected.map(block => block.id)).size === 3, 'Expected block IDs must be unique');
        requireEvidence(observation.expected.every(block => ['heading', 'paragraph', 'button'].includes(block.id) && typeof block.text === 'string'), 'Invalid expected document');
        requireEvidence(['refresh', 'control'].includes(observation.reload), 'Missing reload mechanism');
        requireEvidence(isDeepStrictEqual(observation.beforeSave, observation.expected) && isDeepStrictEqual(observation.afterSave, observation.expected), 'The document was already wrong before reload');
      }

      if (result.status === 'passed') {
        requireEvidence(result.errors.length === 0, 'Passing test contains errors');
        requireEvidence(evidence.observations.length === definition.observations, `Incomplete successful test: ${definition.id}`);
        requireEvidence(evidence.observations.every(item => isDeepStrictEqual(item.actual, item.expected)), 'Passing test contains data loss');
      } else {
        requireEvidence(definition.baseline === 'failed', 'A regression check failed');
        requireEvidence(result.errors.length === 1 && result.errors[0].message?.includes(scenario.verifier.assertion), 'The failure was not the document-preservation assertion');
        requireEvidence(evidence.observations.length === 1, 'The seeded bug must fail on the first reload');
        const observation = evidence.observations[0];
        requireEvidence(isDeepStrictEqual(observation.actual, observation.expected.slice(1)), 'Failure does not show exactly the first block disappearing');
      }
      verification.tests.push({
        id: definition.id, status: result.status!, observations: evidence.observations.length,
        evidence: relative(dirname(reportPath), path).split(sep).join('/'),
      });
    }
    const passed = verification.tests.every(test => test.status === 'passed');
    const reproduced = verification.tests.every((test, index) => test.status === scenario.tests[index].baseline);
    requireEvidence(passed || reproduced, 'Mixed outcomes do not match either the repaired or seeded behavior');
    requireEvidence(process.exitCode === (passed ? 0 : 1), 'Exit code disagrees with the test results');
    verification.status = passed ? 'passed' : 'reproduced';
    verification.verifiedExpectedFailure = reproduced;
    verification.reason = passed ? 'All six tests preserved the document and passed regression checks.' : 'All five persistence tests failed specifically on first-block loss; reset isolation passed.';
  } catch (error) {
    verification.reason = error instanceof Error ? error.message : String(error);
  }
  return verification;
}
