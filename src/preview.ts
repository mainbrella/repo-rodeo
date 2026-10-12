import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// *.localhost previews resolve in Chromium but not in every host DNS resolver.
// Only that reserved local suffix is mapped to loopback; remote hosts are normal.
export async function previewStatus(address: string, path: string): Promise<number> {
  const url = new URL(path, address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid preview URL');
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'http:' ? httpRequest : httpsRequest)(url, {
      signal: AbortSignal.timeout(10_000),
      ...(url.hostname.endsWith('.localhost') ? { lookup: (_hostname: string, options: { all?: boolean }, callback: Function) => {
        if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
        else callback(null, '127.0.0.1', 4);
      } } : {}),
    }, response => {
      response.resume();
      resolve(response.statusCode || 0);
    });
    request.on('error', () => reject(new Error('Preview request failed')));
    request.end();
  });
}
