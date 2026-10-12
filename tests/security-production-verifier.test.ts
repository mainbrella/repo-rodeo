import assert from 'node:assert/strict';
import test from 'node:test';
import { ownsSecurityResource, productionSecurityChecks, verifiedOnlineControl, verifyProductionSecurity } from '../src/security-production-verifier.ts';

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
test('continuations reuse only a cleaned single-start control at the same accounts, upstream and deployments', () => {
  const report = { ...passing(), startsRequested: 1, startDelta: 1, captureDelta: 0, upstreamOrigin: 'https://ack.workers.dev',
    accounts: { primary: 'a', secondary: 'b' }, onlineProtocols: { udpTxt: true, tcpDns: { validResponse: true, answered: true }, alternateTlsDns: { validResponse: true, answered: true } } };
  assert.equal(verifiedOnlineControl(report, report), true);
  assert.equal(verifiedOnlineControl({ ...report, startDelta: 2 }, report), false);
  assert.equal(verifiedOnlineControl({ ...report, accounts: { primary: 'b', secondary: 'a' } }, report), false);
  assert.equal(verifiedOnlineControl({ ...report, deployedVersions: { ...report.deployedVersions, api: 'different' } }, report), false);
  const fixture = { ...report, deployedVersions: { ...report.deployedVersions, ack: 'different' } };
  assert.equal(verifiedOnlineControl(fixture, report), false);
  assert.equal(verifiedOnlineControl(fixture, report, true), true);
  assert.equal(verifiedOnlineControl({ ...fixture, deployedVersions: { ...fixture.deployedVersions, runtime: 'different' } }, report, true), false);
  assert.equal(verifiedOnlineControl({ ...report, cleanup: { ...report.cleanup, completed: false } }, report), false);
  assert.equal(verifiedOnlineControl({ ...report, onlineProtocols: { ...report.onlineProtocols, tcpDns: { answered: false } } }, report), false);
  const continuation = { ...passing(), startsRequested: 5, startDelta: 5, carriedOnlineStarts: 1, onlineControl: { sha256: 'a'.repeat(64), verified: true } };
  assert.equal(verifyProductionSecurity(continuation), true);
  assert.equal(verifyProductionSecurity({ ...continuation, carriedOnlineStarts: 2 }), false);
  assert.equal(verifyProductionSecurity({ ...continuation, onlineControl: { ...continuation.onlineControl, verified: false } }), false);
  const bounded = { ...continuation, startsRequested: 4, startDelta: 4, spentStarts: 1, spentEvidence: { sha256: 'b'.repeat(64), verified: true } };
  assert.equal(verifyProductionSecurity(bounded), true);
  assert.equal(verifyProductionSecurity({ ...bounded, spentEvidence: { ...bounded.spentEvidence, verified: false } }), false);
});
