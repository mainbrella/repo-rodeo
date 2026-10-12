import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPreviewRevocation, assessPreviewTokenInvalidation, type RevocationProbe } from '../src/preview-revocation.ts';
import type { CleanupResult } from '../src/providers/interface.ts';

const sandbox = { id: 'source', generation: 'source-generation' };
const cleanup: CleanupResult = { confirmed: true, sandboxes: [{ sandbox, absent: true }], workspaces: [], physicalStorage: 'not-measured', errors: [] };
const probe = (authenticated = 502, unauthenticated = 502): RevocationProbe => ({ sandbox,
  rounds: Array.from({ length: 3 }, () => ({ at: '2026-10-12T03:25:04Z', authenticated, unauthenticated })) });

test('E2B accepts repeated deleted-gateway responses only alongside exact confirmed API absence', () => {
  assert.equal(assessPreviewRevocation('e2b', cleanup, [probe()]).status, 'verified');
  for (const incomplete of [null, { ...cleanup, confirmed: false }, { ...cleanup, sandboxes: [] },
    { ...cleanup, sandboxes: [{ sandbox, absent: false }] },
    { ...cleanup, sandboxes: [{ sandbox: { ...sandbox, generation: 'another-generation' }, absent: true }] }]) {
    assert.equal(assessPreviewRevocation('e2b', incomplete, [probe()]).status, 'failed');
  }
});

test('E2B rejects successful access, network failures, unexpected statuses, and incomplete repeated evidence', () => {
  for (const sample of [probe(200), probe(502, 200), probe(0), probe(502, 0), probe(503), probe(403)]) {
    assert.equal(assessPreviewRevocation('e2b', cleanup, [sample]).status, 'failed');
  }
  const short = probe(); short.rounds.pop();
  assert.equal(assessPreviewRevocation('e2b', cleanup, [short]).status, 'failed');
  assert.equal(assessPreviewRevocation('e2b', cleanup, [probe(), { ...probe(), sandbox: { id: 'unconfirmed', generation: 'unconfirmed' } }]).status, 'failed');
});

test('other providers retain explicit 404/410 confirmation and no previews remain unexercised', () => {
  for (const provider of ['mainbrella', 'daytona'] as const) {
    assert.equal(assessPreviewRevocation(provider, cleanup, [probe()]).status, 'failed');
    assert.equal(assessPreviewRevocation(provider, cleanup, [probe(404)]).status, 'verified');
    assert.equal(assessPreviewRevocation(provider, cleanup, [probe(410)]).status, 'verified');
  }
  assert.equal(assessPreviewRevocation('e2b', cleanup, []).status, 'not-exercised');
});

test('Daytona sandbox absence and snapshot deletion remain separate from preview access', () => {
  assert.equal(assessPreviewRevocation('daytona', { ...cleanup, confirmed: false, workspaces: [{ id: 'snapshot', absent: false }] }, [probe(404)]).status, 'verified');
  for (const inventory of [null, { ...cleanup, sandboxes: [] }, { ...cleanup, sandboxes: [{ sandbox, absent: false }] },
    { ...cleanup, sandboxes: [{ sandbox: { ...sandbox, generation: 'replacement' }, absent: true }] }]) {
    assert.equal(assessPreviewRevocation('daytona', inventory, [probe(404)]).status, 'failed');
  }
  assert.equal(assessPreviewRevocation('daytona', cleanup, [probe(400)]).status, 'failed');
});

test('preview token invalidation requires an authentication denial and fresh access at the same URL', () => {
  assert.equal(assessPreviewTokenInvalidation(401, 200).status, 'verified');
  assert.equal(assessPreviewTokenInvalidation(403, 200).status, 'verified');
  for (const [retained, fresh] of [[400, 200], [404, 200], [0, 200], [200, 200], [401, 400], [401, 0]]) {
    assert.equal(assessPreviewTokenInvalidation(retained, fresh).status, 'failed');
  }
});
