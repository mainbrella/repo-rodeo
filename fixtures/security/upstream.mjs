import { timingSafeEqual } from 'node:crypto';

// Disposable credentials stay on the host. No request/response logging.
export function securityUpstream(runId) {
  let token, version = 0, pending;
  const events = [];
  const acknowledgment = authenticated => ({ fixture: 'rodeo-security', runId, authenticated, version, internalHeaders: false });
  const handle = (request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    const received = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + token);
    const authenticated = !!token && received.length === expected.length && timingSafeEqual(received, expected);
    const internalHeaders = Object.keys(request.headers).some(name => /^(x-egress-|x-mainbrella-)/.test(name));
    events.push({ path, authenticated, version, internalHeaders });
    const reply = () => { if (!response.destroyed) {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': 'fixture=discard' });
      response.end(JSON.stringify({ ...acknowledgment(authenticated), internalHeaders }));
    } };
    if (path === '/redirect') { response.writeHead(302, { location: 'https://denied.example.com/auth' }); response.end(); }
    else if (path === '/reflect') { response.end(request.headers.authorization ?? ''); }
    else if (path === '/reflect-base64') { response.end(Buffer.from(token ?? '').toString('base64')); }
    else if (path === '/reflect-header') { response.writeHead(200, { 'x-reflection': token ?? '' }); response.end('ok'); }
    else if (path === '/slow') {
      if (!pending) { response.writeHead(409); response.end(); return; }
      const wait = pending; pending = undefined;
      // Capture the version before rotation; a fenced response must be withheld.
      const captured = { ...acknowledgment(authenticated), internalHeaders };
      wait.release = () => { if (!response.destroyed) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(captured)); } };
      wait.resolve();
    } else if (path === '/auth' || path === '/public') reply();
    else { response.writeHead(404); response.end(); }
  };
  return { handle, events, rotate(value) { token = value; version++; },
    hold() {
      if (pending) throw new Error('A slow request is already pending');
      let resolve;
      const received = new Promise(done => { resolve = done; });
      const wait = { resolve, release: undefined };
      pending = wait;
      return { received, release() { if (!wait.release) throw new Error('Slow request has not arrived'); wait.release(); } };
    } };
}
