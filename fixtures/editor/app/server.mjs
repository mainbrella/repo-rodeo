import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/repo-rodeo-bug', ['index.html', 'text/html; charset=utf-8']],
  ['/editor.js', ['editor.js', 'text/javascript; charset=utf-8']],
  ['/editor.css', ['editor.css', 'text/css; charset=utf-8']],
]);

export function startServer({ host = '127.0.0.1', port = 4175 } = {}) {
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    let pathname;
    try {
      pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
    } catch {
      response.writeHead(400).end('Bad request');
      return;
    }
    const route = routes.get(pathname);
    if (!route || (request.method !== 'GET' && request.method !== 'HEAD')) {
      response.writeHead(404).end('Not found');
      return;
    }
    try {
      const body = await readFile(join(appDirectory, route[0]));
      response.writeHead(200, { 'Content-Type': route[1] });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(500).end('Could not read fixture file');
    }
  });
  server.listen(port, host);
  return server;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number.parseInt(process.env.PORT || '4175', 10);
  const server = startServer({ host, port });
  server.once('listening', () => {
    const address = server.address();
    if (address && typeof address === 'object') {
      console.log(`Repo Rodeo editor listening at http://${host}:${address.port}`);
    }
  });
  server.once('error', error => {
    console.error(`Could not start Repo Rodeo editor: ${error.message}`);
    process.exitCode = 1;
  });
  const stop = () => server.close(() => process.exit());
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
