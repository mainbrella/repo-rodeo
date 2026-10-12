import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const config = JSON.parse(process.argv[2]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function matches(bytes) {
  // Only hashes and lengths of disposable credentials enter the guest.
  const candidates = bytes.toString('utf8').match(/[A-Za-z0-9+/=_%.-]{32,}/g) ?? [];
  return config.credentials.some(({ length, sha256 }) => candidates.some(candidate => {
    for (let at = 0; at + length <= candidate.length; at++) if (digest(candidate.slice(at, at + length)) === sha256) return true;
    return false;
  }));
}
async function scan() {
  const files = ['/proc/self/environ', '/proc/self/cmdline'];
  const skipped = [];
  for (const root of ['/workspace', '/tmp']) {
    async function walk(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile()) files.push(child);
      }
    }
    await walk(root);
  }
  let scannedBytes = 0, found = false;
  for (const file of files) {
    const size = (await stat(file)).size;
    if (size > 1024 * 1024 || scannedBytes + size > 8 * 1024 * 1024) { skipped.push(file); continue; }
    const bytes = await readFile(file); scannedBytes += bytes.length; found ||= matches(bytes);
  }
  return { credentialsFound: found, scannedBytes, skipped, scope: '/workspace, /tmp, self environment and argv' };
}
try {
  let result;
  if (config.scan) result = await scan();
  else {
    const response = await fetch(config.url, { headers: config.headers ?? {}, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const credentialReflected = matches(bytes);
    let acknowledgment;
    try {
      const body = JSON.parse(bytes.toString('utf8'));
      // Allowlist fields; never print arbitrary upstream headers/body to an API job log.
      if (body.fixture === 'rodeo-security') acknowledgment = {
        fixture: body.fixture, runId: body.runId === config.runId ? body.runId : null,
        authenticated: body.authenticated === true, version: Number.isInteger(body.version) ? body.version : null,
        internalHeaders: body.internalHeaders !== false,
      };
    } catch {}
    result = { status: response.status, credentialReflected, cookieRemoved: !response.headers.has('set-cookie'), acknowledgment };
  }
  console.log(JSON.stringify(result));
} catch { console.log(JSON.stringify({ status: 0, transportFailure: true })); }
