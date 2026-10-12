import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAcknowledgment, assertNoCredentialLeak, securityChecks, verifyLocalSecurity } from '../src/security-verifier.ts';
import type { SecurityReport } from '../src/security-verifier.ts';

const passing = (): SecurityReport => ({ target: 'isolated-local-api-runtime-relay-tls',
  checks: Object.fromEntries(securityChecks.map(name => [name, true])), errors: [],
  cleanup: { completed: true, remainingContainers: 0, remainingSecrets: 0, remainingDockerContainers: [], errors: [] } });

test('local security qualification requires every check and complete resource cleanup', () => {
  assert.equal(verifyLocalSecurity(passing()), true);
  for (const name of securityChecks) for (const state of [false, undefined]) {
    const report = passing(); report.checks[name] = state;
    assert.equal(verifyLocalSecurity(report), false, name);
  }
});
test('failure, interruption, missing inventory and leftover sidecars cannot qualify', () => {
  const variants: SecurityReport[] = [
    { ...passing(), target: 'production' }, { ...passing(), errors: ['failed'] }, { ...passing(), interruptedBy: 'SIGINT' },
    ...[{ completed: false }, { remainingContainers: 1 }, { remainingSecrets: 1 }, { remainingContainers: null },
      { remainingSecrets: null }, { remainingDockerContainers: null }, { remainingDockerContainers: ['sidecar'] },
      { errors: ['cleanup failed'] }].map(change => ({ ...passing(), cleanup: { ...passing().cleanup, ...change } })),
  ];
  for (const report of variants) assert.equal(verifyLocalSecurity(report), false);
});
test('an HTTP success or unrelated acknowledgment cannot establish scoped credential injection', () => {
  const ack = { fixture: 'rodeo-security', runId: 'run', authenticated: true, version: 2, internalHeaders: false };
  assertAcknowledgment(ack, 'run', true, 2);
  for (const value of [null, {}, { ...ack, runId: 'other' }, { ...ack, authenticated: false },
    { ...ack, version: 1 }, { ...ack, internalHeaders: true }, { ...ack, credential: 'reflected' }]) {
    assert.throws(() => assertAcknowledgment(value, 'run', true, 2));
  }
});
test('credential leak detection covers raw, escaped, URL and base64 forms without disclosing the value', () => {
  const credential = 'disposable/+"credential';
  assertNoCredentialLeak('metadata only', [credential]);
  for (const form of [credential, encodeURIComponent(credential), Buffer.from(credential).toString('base64'),
    JSON.stringify(credential).slice(1, -1)]) {
    assert.throws(() => assertNoCredentialLeak(Buffer.from(`before ${form} after`), [credential]), error => {
      assert.ok(error instanceof Error); assert.equal(error.message.includes(credential), false); return true;
    });
  }
});
