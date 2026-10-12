import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { previewStatus } from '../src/preview.ts';

test('protected preview readiness follows a same-origin redirect and preserves authentication', async t => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    if (request.headers['e2b-traffic-access-token'] !== 'private-preview-token') { response.writeHead(403).end(); return; }
    seen.push(request.url!);
    if (request.url === '/repo-rodeo-bug') response.writeHead(308, { location: '/repo-rodeo-bug/' }).end();
    else response.writeHead(200).end('editor');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  assert.equal(await previewStatus(url, '/repo-rodeo-bug'), 403);
  assert.equal(await previewStatus(url, '/repo-rodeo-bug', { 'e2b-traffic-access-token': 'private-preview-token' }), 200);
  assert.deepEqual(seen, ['/repo-rodeo-bug', '/repo-rodeo-bug/']);
});

test('preview redirects never forward private headers to another origin and loops are bounded', async t => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    response.writeHead(308, { location: request.url === '/external' ? 'https://outside.example/' : '/loop' }).end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await assert.rejects(previewStatus(url, '/external', { authorization: 'Bearer private-token' }), /outside its origin/);
  assert.equal(requests, 1);
  await assert.rejects(previewStatus(url, '/loop'), /redirect limit/);
  assert.equal(requests, 7);
});
