import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPreviewRevocation, assessPreviewTokenInvalidation, classifyPreviewStatus, probePreviewRevocation, type RevocationProbe } from '../src/preview-revocation.ts';
import type { CleanupResult } from '../src/providers/interface.ts';

const sandbox = { id: 'source', generation: 'source-generation' };
const cleanup: CleanupResult = { confirmed: true, sandboxes: [{ sandbox, absent: true }], workspaces: [], physicalStorage: 'not-measured', errors: [] };
const probe = (authenticated = 404, unauthenticated = 401): RevocationProbe => ({ sandbox,
  beforeCleanup: { at: '', authenticated: 200, unauthenticated: 401 },
  rounds: Array.from({ length: 3 }, () => ({ at: '2026-10-12T03:25:04Z', authenticated, unauthenticated, liveControl: 200 })) });

for (const provider of ['mainbrella', 'e2b', 'daytona'] as const) {
  test(`${provider} uses the same access transition and exact deletion requirements`, () => {
    for (const status of [401, 403, 404, 410]) assert.equal(assessPreviewRevocation(provider, cleanup, [probe(status)]).status, 'verified');
    for (const inventory of [null, { ...cleanup, sandboxes: [] }, { ...cleanup, sandboxes: [{ sandbox, absent: false }] },
      { ...cleanup, sandboxes: [{ sandbox: { ...sandbox, generation: 'replacement' }, absent: true }] }]) {
      assert.equal(assessPreviewRevocation(provider, inventory, [probe()]).status, 'inconclusive');
    }
    for (const sample of [probe(502), probe(404, 502), probe(0), probe(404, 0), probe(503), probe(400),
      { ...probe(), beforeCleanup: undefined }, { ...probe(), beforeCleanup: { at: '', authenticated: 401, unauthenticated: 401 } },
      { ...probe(), rounds: probe().rounds.slice(1) }, { ...probe(), rounds: probe().rounds.map(round => ({ ...round, liveControl: 502 })) }]) {
      assert.equal(assessPreviewRevocation(provider, cleanup, [sample]).status, 'inconclusive');
    }
    for (const sample of [probe(200), probe(404, 200)]) assert.equal(assessPreviewRevocation(provider, cleanup, [sample]).status, 'failed');
    assert.equal(assessPreviewRevocation(provider, cleanup, []).status, 'not-exercised');
    assert.equal(assessPreviewRevocation(provider, { ...cleanup, confirmed: false, workspaces: [{ id: 'snapshot', absent: false }] }, [probe()]).status, 'verified');
  });
  test(`${provider} probes both credential modes three times and records a live control`, async () => {
    const calls: boolean[] = [];
    const previews = [{ sandbox, preview: { id: 'test', url: 'https://preview.example.test', expiresAt: null, headers: { authorization: 'test' } } }];
    const probes = await probePreviewRevocation(provider, previews, async (url, _path, headers) => {
      if (url.includes('control')) return 200;
      calls.push(Boolean(headers));
      return headers ? 404 : 401;
    }, { intervalMs: 0, liveControl: { id: 'control', url: 'https://control.example.test', expiresAt: null } });
    assert.deepEqual(calls, [true, false, true, false, true, false]);
    assert.equal(probes[0].rounds.length, 3);
    assert.ok(probes[0].rounds.every(round => round.liveControl === 200));
  });
}
test('HTTP observations distinguish authentication, route absence, availability and network errors', () => {
  assert.deepEqual([200, 401, 404, 502, 0].map(classifyPreviewStatus), ['accessible', 'denied', 'absent', 'unavailable', 'inconclusive']);
});
test('preview token invalidation requires an authentication denial and fresh access at the same URL', () => {
  for (const retained of [401, 403]) assert.equal(assessPreviewTokenInvalidation(retained, 200).status, 'verified');
  assert.equal(assessPreviewTokenInvalidation(200, 200).status, 'failed');
  for (const [retained, fresh] of [[400, 200], [404, 200], [0, 200], [502, 200], [401, 400], [401, 0]]) {
    assert.equal(assessPreviewTokenInvalidation(retained, fresh).status, 'inconclusive');
  }
});
