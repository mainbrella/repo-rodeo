import { readFile, readlink, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = {};
for (const file of JSON.parse(await readFile('/workspace/rodeo-files.json', 'utf8'))) {
  hashes[file] = hash(await readFile(`/workspace/rodeo/${file}`));
}
let processProbe = { nonce: null, pid: null, serverReachable: false };
try {
  const response = await fetch('http://127.0.0.1:5173/__rodeo_process', { signal: AbortSignal.timeout(2000) });
  const probe = await response.json();
  if (response.ok && typeof probe.nonce === 'string' && Number.isInteger(probe.pid)) {
    processProbe = { nonce: probe.nonce, pid: probe.pid, serverReachable: true };
  }
} catch { /* No listener is an observation, not a failed restore. */ }
let dependencyHash = null;
try { dependencyHash = hash(await readFile('/workspace/rodeo/node_modules/.package-lock.json')); } catch {}
let branchMarker = null;
try { branchMarker = await readFile('/workspace/rodeo-branch', 'utf8'); } catch {}
console.log(JSON.stringify({
  hashes, dependencyHash, branchMarker,
  prepared: await readFile('/workspace/rodeo-prepared', 'utf8'),
  mode: (await stat('/workspace/rodeo-prepared')).mode & 0o777,
  link: await readlink('/workspace/rodeo-link'),
  process: { ...processProbe, observedAt: new Date().toISOString() },
}));
