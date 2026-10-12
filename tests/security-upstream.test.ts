import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import type { TestContext } from 'node:test';
// @ts-expect-error The standalone Node fixture has no TypeScript declarations.
import { securityUpstream } from '../fixtures/security/upstream.mjs';
import { assertAcknowledgment } from '../src/security-verifier.ts';

async function fixture(t: TestContext) {
  const upstream = securityUpstream('run'), server = createServer(upstream.handle);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const request = (path: string, authorization?: string) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    headers: authorization ? { authorization } : {}, redirect: 'manual', signal: AbortSignal.timeout(3000),
  });
  return { upstream, request };
}
test('owned upstream acknowledges only the exact current credential without reflecting it', async t => {
  const { upstream, request } = await fixture(t); upstream.rotate('disposable-token');
  for (const authorization of [undefined, 'Bearer guest-spoof', 'Bearer disposable-token-longer']) {
    assertAcknowledgment(await (await request('/auth', authorization)).json(), 'run', false, 1);
  }
  assertAcknowledgment(await (await request('/auth', 'Bearer disposable-token')).json(), 'run', true, 1);
  upstream.rotate('rotated-token');
  assertAcknowledgment(await (await request('/auth', 'Bearer disposable-token')).json(), 'run', false, 2);
  assertAcknowledgment(await (await request('/auth', 'Bearer rotated-token')).json(), 'run', true, 2);
  assert.equal(JSON.stringify(upstream.events).includes('disposable-token'), false);
});
test('slow request retains its admitted version across host-side rotation', async t => {
  const { upstream, request } = await fixture(t); upstream.rotate('original');
  const held = upstream.hold(), pending = request('/slow', 'Bearer original');
  await held.received; upstream.rotate('replacement'); held.release();
  assertAcknowledgment(await (await pending).json(), 'run', true, 1);
  assertAcknowledgment(await (await request('/auth', 'Bearer replacement')).json(), 'run', true, 2);
});
test('fixture provides real redirect and reflection adversaries and rejects unrelated paths', async t => {
  const { upstream, request } = await fixture(t); upstream.rotate('disposable');
  const redirect = await request('/redirect'); assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://denied.example.com/auth');
  assert.equal(await (await request('/reflect', 'Bearer disposable')).text(), 'Bearer disposable');
  assert.equal(await (await request('/reflect-base64')).text(), Buffer.from('disposable').toString('base64'));
  assert.equal((await request('/reflect-header')).headers.get('x-reflection'), 'disposable');
  assert.equal((await request('/unrelated')).status, 404);
});
