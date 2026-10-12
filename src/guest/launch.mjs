// Copied into the guest app, never installed in the user's source checkout.
import { randomUUID } from 'node:crypto';
const probe = { nonce: randomUUID(), pid: process.pid, startedAt: new Date().toISOString() };
const respond = (_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(probe));
};
if (process.argv[2] === 'web-checkout') {
  const { createServer } = await import('vite');
  const server = await createServer({
    server: { host: '0.0.0.0', port: 5173, strictPort: true, hmr: false, allowedHosts: ['container'] },
    plugins: [{ name: 'rodeo-process-probe', configureServer(server) {
      server.middlewares.use('/__rodeo_process', respond);
    } }],
  });
  await server.listen();
} else {
  const { startServer } = await import('./server.mjs');
  const server = startServer({ host: '0.0.0.0', port: 5173 });
  const handlers = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    if (request.url === '/__rodeo_process') return respond(request, response);
    for (const handler of handlers) handler.call(server, request, response);
  });
}
console.log(JSON.stringify(probe));
