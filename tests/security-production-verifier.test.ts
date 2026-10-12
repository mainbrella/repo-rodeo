import assert from 'node:assert/strict';
import test from 'node:test';
import { ownsSecurityResource, productionSecurityChecks, verifyProductionSecurity } from '../src/security-production-verifier.ts';

const id = '11111111-1111-4111-8111-111111111111';
function passing() {
  return { target: 'restricted-production-api-runtime-relay-tls', checks: Object.fromEntries(productionSecurityChecks.map(name => [name, true])), errors: [] as string[],
    startsRequested: 6, startDelta: 6, captureDelta: 2, secondaryStartDelta: 0,
    deployedVersions: Object.fromEntries(['api', 'runtime', 'relay', 'ack'].map(name => [name, id])), imageDigest: `registry.cloudflare.com/account/node@sha256:${'a'.repeat(64)}`,
    cleanup: { completed: true, remainingOwnedContainers: 0, remainingOwnedSecrets: 0, remainingOwnedWorkspaces: 0, upstreamAbsent: true, baselinePreserved: true, errors: [] as string[] } };
}
test('canary evidence requires every control, pinned deployments, exact cost budget and reconciled cleanup', () => {
  assert.equal(verifyProductionSecurity(passing()), true);
  for (const name of productionSecurityChecks) { const report = passing(); delete report.checks[name]; assert.equal(verifyProductionSecurity(report), false); }
  for (const property of ['startsRequested', 'startDelta', 'captureDelta', 'secondaryStartDelta'] as const) {
    const report = passing(); report[property]++; assert.equal(verifyProductionSecurity(report), false);
  }
  const deployment = passing(); delete deployment.deployedVersions.runtime; assert.equal(verifyProductionSecurity(deployment), false);
  const image = passing(); image.imageDigest = 'node:latest'; assert.equal(verifyProductionSecurity(image), false);
  for (const property of ['remainingOwnedContainers', 'remainingOwnedSecrets', 'remainingOwnedWorkspaces'] as const) {
    const report = passing(); report.cleanup[property] = 1; assert.equal(verifyProductionSecurity(report), false);
  }
  for (const property of ['upstreamAbsent', 'baselinePreserved'] as const) {
    const report = passing(); report.cleanup[property] = false; assert.equal(verifyProductionSecurity(report), false);
  }
  const errors = passing(); errors.errors.push('interrupted'); assert.equal(verifyProductionSecurity(errors), false);
});
test('cleanup fences exact generations and snapshot sources while recovering run-named uncertain creates', () => {
  const identities = [{ id: 'c1', createdAt: 'old' }];
  assert.equal(ownsSecurityResource({ id: 'c1', createdAt: 'old' }, id, identities), true);
  assert.equal(ownsSecurityResource({ id: 'c1', createdAt: 'new' }, id, identities), false);
  assert.equal(ownsSecurityResource({ id: 'snapshot', source: { id: 'c1', createdAt: 'old' } }, id, identities), true);
  assert.equal(ownsSecurityResource({ id: 'snapshot', source: { id: 'c1', createdAt: 'new' } }, id, identities), false);
  assert.equal(ownsSecurityResource({ id: 'c2', name: `Rodeo security ${id}` }, id, identities), true);
  assert.equal(ownsSecurityResource({ id: 'c2', name: 'another workload' }, id, identities), false);
});
