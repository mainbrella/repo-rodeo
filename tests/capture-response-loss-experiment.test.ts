import test from 'node:test';
import assert from 'node:assert/strict';
import { dropFirstCaptureResponse, exactNamedSnapshot, LostCaptureResponse } from '../src/capture-response-loss-experiment.ts';

test('successful capture loss withholds its body once and leaves inventory reads intact', async () => {
  const receipts: unknown[] = [];
  const loss = dropFirstCaptureResponse(async () => Response.json({ snapshotID: 'snapshot-1' }),
    (url, method) => url.pathname.endsWith('/snapshots') && method === 'POST', async value => { receipts.push(value); });
  await assert.rejects(loss.fetch('https://api.example/snapshots', { method: 'POST' }), LostCaptureResponse);
  assert.deepEqual(await (await loss.fetch('https://api.example/snapshots')).json(), { snapshotID: 'snapshot-1' });
  assert.deepEqual(loss.state(), { dropped: true, submissions: 1 });
  assert.equal(receipts.length, 1);
});

test('a rejected capture is never counted as successful response loss', async () => {
  const loss = dropFirstCaptureResponse(async () => new Response('Denied', { status: 403 }),
    () => true, async () => { assert.fail('A rejected response must not be withheld'); });
  assert.equal((await loss.fetch('https://api.example/snapshots', { method: 'POST' })).status, 403);
  assert.deepEqual(loss.state(), { dropped: false, submissions: 1 });
});

test('snapshot recovery requires an exact name and refuses ambiguous ownership', () => {
  const first = { snapshotId: 'first', names: ['project/rodeo-123:latest'] };
  assert.equal(exactNamedSnapshot([first, { snapshotId: 'other', names: ['rodeo-123-other:latest'] }], 'rodeo-123'), first);
  assert.equal(exactNamedSnapshot([first], 'rodeo-12'), undefined);
  assert.throws(() => exactNamedSnapshot([first, { ...first, snapshotId: 'second' }], 'rodeo-123'), /ambiguous/);
});
