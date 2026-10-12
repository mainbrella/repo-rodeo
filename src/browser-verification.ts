import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { JSONReportSuite } from '@playwright/test/reporter';
import { execute } from './process.ts';
import { writeJson } from './evidence.ts';
import type { Scenario } from './scenario.ts';
import { verifyReport } from './verifier.ts';

export async function verifyPreview(options: {
  repository: string; directory: string; url: string; seed: number; scenario: Scenario; signal: AbortSignal; headers?: Record<string, string>;
}) {
  const { repository, directory, url, seed, scenario, signal } = options;
  await mkdir(directory);
  const args = ['node_modules/@playwright/test/cli.js', 'test', '--config', scenario.verifier.config];
  await writeJson(join(directory, 'command.json'), { executable: process.execPath, args, seed });
  // Credentials belong to the adapter, never to the app or verifier process.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/MAINBRELLA|API_KEY|TOKEN|SECRET|PASSWORD/i.test(key)));
  const processResult = await execute(process.execPath, args, {
    cwd: repository, env: { ...env, REPRO_BASE_URL: url, RODEO_SEED: String(seed),
      RODEO_PREVIEW_HEADERS: JSON.stringify(options.headers ?? {}),
      RODEO_JSON_REPORT: join(directory, 'report.json'), RODEO_TEST_OUTPUT: join(directory, 'test-results') },
    stdout: join(directory, 'stdout.log'), stderr: join(directory, 'stderr.log'), timeoutMs: 180_000, signal,
  });
  await writeJson(join(directory, 'process.json'), processResult);
  const reportPath = join(directory, 'report.json');
  await cp(reportPath, join(directory, 'report.raw.json'));
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const visit = (suites: JSONReportSuite[]) => {
    for (const suite of suites) {
      for (const spec of suite.specs) for (const test of spec.tests) for (const result of test.results) {
        for (const attachment of result.attachments) if (attachment.path) {
          attachment.path = relative(dirname(reportPath), resolve(dirname(reportPath), attachment.path)).split(sep).join('/');
        }
      }
      visit(suite.suites || []);
    }
  };
  visit(report.suites);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const verification = await verifyReport(reportPath, processResult, scenario, seed);
  await writeJson(join(directory, 'verification.json'), verification);
  return verification;
}
