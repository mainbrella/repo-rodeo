import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';

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
async function protocols() {
  const { parseDnsAnswer } = await import('./dns.mjs');
  const resolver = new dns.Resolver({ timeout: 1000, tries: 1 });
  resolver.setServers(['1.1.1.1']);
  const udpTxt = await resolver.resolveTxt('example.com').then(records => records.length > 0, () => false);
  resolver.cancel();
  const tcp = async encrypted => new Promise(resolve => {
    const question = Buffer.from('076578616d706c6503636f6d0000010001', 'hex');
    const id = 0x7777, request = Buffer.concat([Buffer.from('777701000001000000000000', 'hex'), question]);
    const length = Buffer.alloc(2); length.writeUInt16BE(request.length);
    const socket = encrypted ? tls.connect({ host: '1.1.1.1', port: 853, servername: 'cloudflare-dns.com', rejectUnauthorized: true }) : net.connect({ host: '1.1.1.1', port: 53 });
    let bytes = Buffer.alloc(0), finished = false;
    const done = result => { if (!finished) { finished = true; socket.destroy(); resolve({ ...result, responseReceived: bytes.length > 0, receivedBytes: bytes.length }); } };
    socket.once(encrypted ? 'secureConnect' : 'connect', () => socket.write(Buffer.concat([length, request])));
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 65537) return done({ answered: false, validResponse: false });
      if (bytes.length >= 2 && bytes.length >= bytes.readUInt16BE(0) + 2) done(parseDnsAnswer(bytes.subarray(2, bytes.readUInt16BE(0) + 2), { id, question }));
    });
    socket.once('end', () => done({ answered: false })); socket.once('error', () => done({ answered: false })); socket.setTimeout(2000, () => done({ answered: false }));
  });
  return { udpTxt, tcpDns: await tcp(false), alternateTlsDns: await tcp(true) };
}
try {
  let result;
  if (config.tamperCa) {
    const child = spawnSync(process.execPath, [process.argv[1], JSON.stringify({ ...config, tamperCa: false })], {
      env: { ...process.env, NODE_OPTIONS: '--use-bundled-ca', NODE_EXTRA_CA_CERTS: '/dev/null', SSL_CERT_FILE: '/dev/null' }, timeout: 18000,
    });
    if (child.status !== 0) throw new Error('CA probe failed');
    result = JSON.parse(child.stdout.toString());
  }
  else if (config.scan) result = await scan();
  else if (config.protocols) result = await protocols();
  else {
    const response = await fetch(config.url, { headers: config.headers ?? {}, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const credentialReflected = matches(bytes);
    let acknowledgment, policyDenied = false;
    try {
      const body = JSON.parse(bytes.toString('utf8'));
      policyDenied = response.status === 403 && body.error === 'egress_denied';
      // Allowlist fields; never print arbitrary upstream headers/body to an API job log.
      if (body.fixture === 'rodeo-security') acknowledgment = {
        fixture: body.fixture, runId: body.runId === config.runId ? body.runId : null,
        authenticated: body.authenticated === true, version: Number.isInteger(body.version) ? body.version : null,
        internalHeaders: body.internalHeaders !== false,
      };
    } catch {}
    result = { status: response.status, credentialReflected, policyDenied, cookieRemoved: !response.headers.has('set-cookie'), acknowledgment };
  }
  console.log(JSON.stringify(result));
} catch { console.log(JSON.stringify({ status: 0, transportFailure: true })); }
