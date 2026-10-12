import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// *.localhost previews resolve in Chromium but not in every host DNS resolver.
// Only that reserved local suffix is mapped to loopback; remote hosts are normal.
export async function previewStatus(address: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  let url = new URL(path, address);
  const origin = url.origin;
  for (let hop = 0; hop < 6; hop++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid preview URL');
    const result = await new Promise<{ status: number; location?: string }>((resolve, reject) => {
    const request = (url.protocol === 'http:' ? httpRequest : httpsRequest)(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
      ...(url.hostname.endsWith('.localhost') ? { lookup: (_hostname: string, options: { all?: boolean }, callback: Function) => {
        if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
        else callback(null, '127.0.0.1', 4);
      } } : {}),
    }, response => {
      response.resume();
      resolve({ status: response.statusCode || 0, location: response.headers.location });
    });
    request.on('error', () => reject(new Error('Preview request failed')));
    request.end();
    });
    if (![301, 302, 303, 307, 308].includes(result.status) || !result.location) return result.status;
    const next = new URL(result.location, url);
    if (next.origin !== origin) throw new Error('Preview redirected outside its origin');
    url = next;
  }
  throw new Error('Preview redirect limit exceeded');
}
