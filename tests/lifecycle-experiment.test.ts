import assert from 'node:assert/strict';
import test from 'node:test';
import { checkLifecycleCapacity, checkPreservedInventory, recoverCaptureIds } from '../src/lifecycle-experiment.ts';

const account: any = { active: true, containers: [], sizes: [{ id: 'lite', diskGB: 2, computeUnits: 1 }], imageCatalog: [{ id: 'node' }],
  limits: { maxStartsPerMonth: 10, maxContainers: 3, maxConcurrentComputeUnits: 4, maxSessionMs: 3600000 },
  usage: { starts: 2, concurrentComputeUnits: 0, availableComputeUnitHours: 3 } };
const workspaces: any = { workspaces: [], usage: { saved: 0, reservedBytes: 0, savesThisMonth: 0, captureBytesThisMonth: 0, retainedCaptureBytes: 0 },
  limits: { maxSaved: 3, maxReservedBytes: 8e9, maxSavesPerMonth: 10, maxCaptureBytesPerMonth: 20e9, maxRetainedCaptureBytes: 20e9 } };

test('lifecycle capacity reserves two full disks and three starts before admission', () => {
  assert.equal(checkLifecycleCapacity(account, workspaces), 2e9);
  const blocked = structuredClone(workspaces); blocked.usage.retainedCaptureBytes = 17e9;
  assert.throws(() => checkLifecycleCapacity(account, blocked), /Capture capacity/);
  const starts = structuredClone(account); starts.usage.starts = 8;
  assert.throws(() => checkLifecycleCapacity(starts, workspaces), /Three starts/);
});
test('lifecycle preflight rejects unavailable compute, slots and missing measurements', () => {
  for (const altered of [{ ...account, active: false }, { ...account, sizes: [] },
    { ...account, usage: { ...account.usage, availableComputeUnitHours: 0 } },
    { ...account, containers: [{ id: 'small' }, { id: 'c1' }] },
    { ...account, usage: { ...account.usage, concurrentComputeUnits: 3 } }]) assert.throws(() => checkLifecycleCapacity(altered, workspaces));
});
test('cleanup requires exact-generation absence and preserves unrelated inventory', () => {
  const original = { id: 'small', createdAt: 'original' }, owned = { id: 'c1', createdAt: 'owned' };
  checkPreservedInventory([original], [original], [owned]);
  assert.throws(() => checkPreservedInventory([original], [original, owned], [owned]), /Owned generation remains/);
  assert.throws(() => checkPreservedInventory([original], [], [owned]), /Original container inventory changed/);
  assert.throws(() => checkPreservedInventory([original], [original], [original]), /Ownership overlaps/);
  assert.throws(() => checkPreservedInventory([original], [original, { ...owned, createdAt: 'someone-else' }], [owned]), /Original container inventory changed/);
});
test('partial captures require exact run name and generation, with unique ownership', () => {
  const source = { id: 'small', createdAt: 'original' };
  const owned = { id: 'capture', name: 'random-run-fork', source };
  assert.deepEqual(recoverCaptureIds([owned, { ...owned, id: 'unrelated', name: 'other-name' }], [], source, ['random-run-fork']), ['capture']);
  assert.deepEqual(recoverCaptureIds([owned], ['capture'], source, ['random-run-fork']), []);
  assert.deepEqual(recoverCaptureIds([{ ...owned, source: { ...source, createdAt: 'replacement' } }], [], source, ['random-run-fork']), []);
  assert.throws(() => recoverCaptureIds([owned, { ...owned, id: 'second' }], [], source, ['random-run-fork']), /ambiguous/);
});
