import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { Mainbrella } from '../../backend/sdk/javascript/index.js';
import { assessTcpDns } from '../../backend/scripts/security-local-dns.mjs';
import { assertAcknowledgment, assertNoCredentialLeak } from './security-verifier.ts';
import { ownsSecurityResource, verifyProductionSecurity } from './security-production-verifier.ts';

const repository = fileURLToPath(new URL('../', import.meta.url)), backend = resolve(repository, '../backend');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = value => ({ id: value.id, createdAt: value.createdAt });
const delay = ms => new Promise(done => setTimeout(done, ms));

export async function qualifyProductionSecurity({ output, infrastructure, account, secondaryAccount }) {
  assert.ok(output && infrastructure && account && secondaryAccount && account !== secondaryAccount, 'Explicit output, private infrastructure file and two distinct account IDs required');
  const privateFile = resolve(infrastructure);
  assert.equal((await stat(privateFile)).mode & 0o077, 0, 'Infrastructure credentials must be private');
  const settings = JSON.parse(await readFile(privateFile, 'utf8'));
  const upstreamOrigin = new URL(settings.ackOrigin).origin;
  assert.ok(upstreamOrigin.startsWith('https://') && new URL(upstreamOrigin).hostname.endsWith('.workers.dev'), 'Use the dedicated Cloudflare acknowledgment service');
  assert.match(settings.ackControlToken ?? '', /^[a-f0-9]{64}$/);
  const local = parseEnv(await readFile(join(backend, '.env'), 'utf8'));
  // Import only these two API keys. Never source .env or pass keys into guests.
  const keys = [process.env.MAINBRELLA_API_KEY ?? local.MAINBRELLA_API_KEY, process.env.MAINBRELLA_API_KEY2 ?? local.MAINBRELLA_API_KEY2];
  const token = randomBytes(32).toString('hex'), rotated = randomBytes(32).toString('hex');
  const credentials = [...keys, token, rotated, settings.ackControlToken, settings.relayToken, settings.encryptionKey].filter(Boolean);
  output = resolve(output); await mkdir(dirname(output), { recursive: true }); await mkdir(output, { mode: 0o700 });
  const runId = randomUUID(), name = `Rodeo security ${runId}`;
  const report = { schemaVersion: 1, experiment: 'mainbrella-egress-vault', target: 'restricted-production-api-runtime-relay-tls', runId,
    startedAt: new Date().toISOString(), ok: false, releaseQualified: false, stage: 'preflight', checks: {}, errors: [],
    accounts: { primary: account, secondary: secondaryAccount }, deployedVersions: settings.versions ?? {},
    budget: { maxStarts: 6, maxCaptures: 2, maxConcurrentGuests: 2, maxWorkloadMs: 720000 }, startsRequested: 0,
    upstreamOrigin, operations: [], identities: [], receipts: [],
    pending: ['IPv6 and full bypass matrix', 'complete image/snapshot credential scan beyond workspace',
      'expiry and provider recovery', 'SSH and browser terminal', 'deployed runtime downgrade and in-flight deployment withdrawal'],
    limitations: ['Private qualification account; passing this bounded canary does not authorize public release.',
      'Credential scan covers workspace, tmp, self environment and argv; snapshots are checked after restore.',
      'A trusted scoped upstream is required; reflection checks cover common encodings, not arbitrary transformations.'],
    cleanup: { completed: false, remainingOwnedContainers: null, remainingOwnedSecrets: null, remainingOwnedWorkspaces: null, upstreamAbsent: false, baselinePreserved: false, errors: [] } };
  const persist = async () => {
    const bytes = JSON.stringify(report, null, 2) + '\n'; assertNoCredentialLeak(bytes, credentials);
    await writeFile(join(output, 'result.json.tmp'), bytes, { mode: 0o600 }); await rename(join(output, 'result.json.tmp'), join(output, 'result.json'));
  };
  const abort = new AbortController();
  const signals = ['SIGINT', 'SIGTERM'].map(signal => {
    const handler = () => { report.interruptedBy = signal; abort.abort(); }; process.on(signal, handler); return [signal, handler];
  });
  const timer = setTimeout(() => { report.errors.push('workload_deadline'); abort.abort(); }, report.budget.maxWorkloadMs);
  let sequence = 0, baseline, baselineSecondary, baselineSecrets, baselineWorkspaces, secret;
  const clientFor = (apiKey, cleanup = false) => new Mainbrella({ apiKey, timeoutMs: cleanup ? 15000 : 60000, fetch: async (url, options = {}) => {
    assert.equal(new URL(url).origin, 'https://api.mainbrella.com');
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), ...(!cleanup ? [abort.signal] : [])]);
    const response = await fetch(url, { ...options, signal });
    const bytes = Buffer.from(await response.arrayBuffer()); assertNoCredentialLeak(bytes, credentials);
    report.receipts.push({ sequence: ++sequence, method: options.method ?? 'GET', path: new URL(url).pathname, status: response.status });
    return new Response(bytes, { status: response.status, headers: response.headers });
  } });
  const client = clientFor(keys[0]), other = clientFor(keys[1]), cleanupClient = clientFor(keys[0], true), cleanupOther = clientFor(keys[1], true);
  const control = async (method = 'GET', body, action = '') => {
    const response = await fetch(`${upstreamOrigin}/control/${runId}${action ? '/' + action : ''}`, { method, redirect: 'error',
      headers: { Authorization: `Bearer ${settings.ackControlToken}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
    const bytes = Buffer.from(await response.arrayBuffer()); assertNoCredentialLeak(bytes, credentials);
    assert.equal(response.status, 200, 'Upstream control request failed'); return JSON.parse(bytes.toString());
  };
  const phase = async (stage, action) => {
    abort.signal.throwIfAborted(); report.stage = stage; console.log(`Security: ${stage}`); await persist(); await action(); await persist();
  };
  const denial = (action, status) => assert.rejects(action(), error => error.status === status, `Expected HTTP ${status}`);
  const url = action => `${upstreamOrigin}/runs/${runId}/${action}`;
  const guestConfig = extra => ({ runId, credentials: [token, rotated].flatMap(value => [value, Buffer.from(value).toString('base64')])
    .map(value => ({ length: value.length, sha256: hash(value) })), ...extra });
  const upload = async sandbox => {
    await sandbox.files.write('/workspace/security-probe.mjs', await readFile(join(repository, 'fixtures/security/probe.mjs')));
    await sandbox.files.write('/workspace/dns.mjs', await readFile(join(backend, 'scripts/security-local-dns.mjs')));
  };
  const probe = async (sandbox, extra) => {
    const job = await sandbox.commands.start(['node', '/workspace/security-probe.mjs', JSON.stringify(guestConfig(extra))], { timeoutMs: 25000 });
    const result = await job.wait({ timeoutMs: 35000, pollIntervalMs: 250 });
    assert.equal(result.exitCode, 0, 'Guest probe did not complete'); assert.equal(result.outputTruncated, false);
    assertNoCredentialLeak(result.stdout + result.stderr, credentials); return JSON.parse(result.stdout);
  };
  const journalStart = async (kind, action) => {
    assert.ok(report.startsRequested < report.budget.maxStarts, 'Start budget exhausted');
    report.startsRequested++; const idempotencyKey = randomUUID(); report.operations.push({ kind, idempotencyKey }); await persist();
    const sandbox = await action({ idempotencyKey, waitTimeoutMs: 120000, pollIntervalMs: 1000 });
    report.identities.push(identity(sandbox)); report.operations.at(-1).identity = identity(sandbox);
    if (sandbox.workspaceId) report.operations.at(-1).workspaceId = sandbox.workspaceId;
    await persist(); return sandbox;
  };
  const scan = async sandbox => {
    const value = await probe(sandbox, { scan: true }); assert.equal(value.credentialsFound, false);
    assert.deepEqual(value.skipped, []); assert.ok(value.scannedBytes > 0); return value;
  };
  const slow = async (sandbox, action) => {
    const pending = probe(sandbox, { url: url('slow') }); void pending.catch(() => {});
    try {
      let held = false;
      for (let attempt = 0; attempt < 30; attempt++) { if ((await control()).pending) { held = true; break; } await delay(100); }
      assert.equal(held, true, 'Owned upstream never received the slow request'); await action();
    } finally { await control('POST', undefined, 'release'); }
    assert.equal((await pending).status, 403, 'Superseded response was released');
  };
  const wsAck = address => new Promise((done, reject) => {
    const socket = new WebSocket(address), timeout = setTimeout(() => { socket.close(); reject(new Error('preview_websocket_timeout')); }, 10000);
    socket.addEventListener('message', event => { clearTimeout(timeout); socket.close(); try { assert.equal(event.data, runId); done(); } catch (error) { reject(error); } }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); socket.close(); reject(new Error('preview_websocket_failed')); }, { once: true });
  });
  try {
    await phase('preflight-and-private-discovery', async () => {
      assert.equal((await client.request('/api-keys/me')).accountId, account);
      assert.equal((await other.request('/api-keys/me')).accountId, secondaryAccount);
      baseline = await client.list(); baselineSecondary = await other.list();
      baselineSecrets = (await client.secrets.list()).secrets; baselineWorkspaces = await client.workspaces.list();
      // Require empty guests so uncertain requests can be reconciled safely.
      assert.equal(baseline.containers.length, 0, 'Primary account already has containers'); assert.equal(baselineSecondary.containers.length, 0, 'Control account already has containers');
      assert.equal(baseline.active, true); assert.ok(baseline.limits.maxStartsPerMonth - baseline.usage.starts >= 6);
      assert.ok(baseline.limits.maxContainers >= 2); assert.ok(baseline.usage.availableComputeUnitHours > 0);
      assert.ok(baselineWorkspaces.limits && baselineWorkspaces.limits.maxSavesPerMonth - baselineWorkspaces.usage.savesThisMonth >= 2, 'Two snapshot captures require budget');
      report.baseline = { starts: baseline.usage.starts, secondaryStarts: baselineSecondary.usage.starts,
        saves: baselineWorkspaces.usage.savesThisMonth, secrets: baselineSecrets.map(value => value.id), workspaces: baselineWorkspaces.workspaces.map(value => value.id) };
      const caps = await client.capabilities(), negative = await other.capabilities();
      for (const service of ['api', 'runtime', 'relay', 'ack']) assert.match(report.deployedVersions[service] ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, 'Pin all four deployed versions before starting guests');
      const anonymous = await (await fetch('https://api.mainbrella.com/capabilities', { signal: AbortSignal.timeout(10000) })).json();
      for (const c of [negative, anonymous]) { assert.equal(c.networking.egressPolicies, false); assert.equal(c.secrets.vault, false); }
      assert.equal(caps.networking.egressPolicies, true); assert.equal(caps.secrets.vault, true);
      assert.equal(caps.persistence.filesystemFork, true); assert.equal(caps.persistence.filesystemAfterStop, true);
      await denial(() => other.secrets.create({ name, value: token, hostname: new URL(upstreamOrigin).hostname, header: 'authorization' }), 503);
      await denial(() => other.request('/containers', { method: 'POST', body: { catalogId: 'node', size: 'lite', networkPolicy: { allow: [new URL(upstreamOrigin).hostname] } } }), 503);
      report.checks.accountAllowlist = true;
      report.revisions = Object.fromEntries([['runner', repository], ['backend', backend]].map(([key, cwd]) => [key, { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim() }]));
      report.inputHashes = {};
      for (const path of ['src/security-production-experiment.mjs', 'src/security-production-verifier.ts', 'src/security-verifier.ts', 'fixtures/security/probe.mjs', 'package-lock.json']) {
        const bytes = await readFile(join(repository, path)); const destination = join(output, 'inputs', path); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes, { mode: 0o600 }); report.inputHashes[path] = hash(bytes);
      }
      assert.deepEqual(await control('POST', { value: token }), { configured: true, version: 1 });
    });
    await phase('online-positive-controls', async () => {
      const online = await journalStart('online', options => client.create({ catalogId: 'node', size: 'lite', name, ...options })); await upload(online);
      report.imageDigest = online.imageDigest;
      report.onlineProtocols = await probe(online, { protocols: true });
      assert.equal(report.onlineProtocols.udpTxt, true);
      for (const value of [report.onlineProtocols.tcpDns, report.onlineProtocols.alternateTlsDns]) { assert.equal(value.validResponse, true); assert.equal(value.answered, true); }
      const publicReply = await probe(online, { url: url('public') }); assert.equal(publicReply.status, 200); assertAcknowledgment(publicReply.acknowledgment, runId, false, 1);
      assert.equal((await probe(online, { url: 'https://api.mainbrella.com/capabilities' })).status, 200);
      report.checks.onlineControls = true; await online.kill();
    });
    const selection = { catalogId: 'node', size: 'lite', name, networkPolicy: { allow: [new URL(upstreamOrigin).hostname], deny: ['api.mainbrella.com'] } };
    await phase('vault-metadata-and-admission', async () => {
      report.secretName = name; await persist();
      secret = await client.secrets.create({ name, value: token, hostname: new URL(upstreamOrigin).hostname, header: 'authorization', prefix: 'Bearer ' }); report.secretId = secret.id; await persist();
      assert.deepEqual(Object.keys(secret).sort(), ['createdAt', 'header', 'hostname', 'id', 'name', 'prefix', 'updatedAt']);
      assert.ok((await client.secrets.list()).secrets.some(value => value.id === secret.id)); report.checks.metadataOnly = true;
      assert.equal((await other.secrets.list()).secrets.some(value => value.id === secret.id), false);
      await denial(() => other.secrets.rotate(secret.id, rotated), 404); report.checks.crossAccountIsolation = true;
      const starts = (await client.list()).usage.starts;
      await denial(() => client.request('/containers', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { ...selection, internet: true } }), 400);
      assert.equal((await client.list()).usage.starts, starts); report.checks.invalidSelectionDoesNotStart = true;
    });
    let restricted;
    await phase('real-restricted-egress', async () => {
      restricted = await journalStart('restricted', options => client.create({ ...selection, secretBindings: [secret.id], ...options })); await upload(restricted);
      assert.equal(restricted.internet, false); assert.equal(restricted.imageDigest, report.imageDigest);
      const replay = await client.create({ ...selection, secretBindings: [secret.id], idempotencyKey: report.operations.at(-1).idempotencyKey });
      assert.deepEqual(identity(replay), identity(restricted)); report.checks.sameKeyReplay = true;
      report.offlineProtocols = await probe(restricted, { protocols: true });
      assert.equal(assessTcpDns(report.onlineProtocols.tcpDns, report.offlineProtocols.tcpDns), 'denied'); report.checks.publicTcpDnsDenial = true;
      assert.equal(report.offlineProtocols.udpTxt, false); report.checks.publicUdpDnsDenial = true;
      assert.equal(assessTcpDns(report.onlineProtocols.alternateTlsDns, report.offlineProtocols.alternateTlsDns), 'denied'); report.checks.alternatePortDenial = true;
      const ack = await probe(restricted, { url: url('auth'), headers: { authorization: 'guest-spoof', 'x-egress-id': 'c999', 'x-mainbrella-user': 'victim' } });
      assert.equal(ack.status, 200); assert.equal(ack.cookieRemoved, true); assertAcknowledgment(ack.acknowledgment, runId, true, 1);
      report.checks.allowedHttps = true; report.checks.guestHeaderSpoofing = true;
      const untrusted = await probe(restricted, { url: url('auth'), tamperCa: true }); assert.equal(untrusted.status, 0); assert.equal(untrusted.transportFailure, true); report.checks.caTampering = true;
      assert.equal((await probe(restricted, { url: 'https://api.mainbrella.com/capabilities' })).status, 403); report.checks.domainDenial = true;
      assert.equal((await probe(restricted, { url: url('redirect') })).status, 403); report.checks.redirectDenial = true;
      for (const action of ['reflect', 'reflect-base64', 'reflect-header']) { const reply = await probe(restricted, { url: url(action) }); assert.equal(reply.status, 403); assert.equal(reply.credentialReflected, false); }
      report.checks.reflectionDenial = true;
    });
    await phase('rotation-scans-and-previews', async () => {
      await slow(restricted, async () => { await client.secrets.rotate(secret.id, rotated); await control('PUT', { value: rotated }); }); report.checks.rotationDuringRequest = true;
      const ack = await probe(restricted, { url: url('auth') }); assert.equal(ack.status, 200); assertAcknowledgment(ack.acknowledgment, runId, true, 2); report.checks.rotation = true;
      report.guestCredentialScan = await scan(restricted); report.checks.guestCredentialScan = true;
      await restricted.files.write('/workspace/security-preview.mjs', Buffer.from(`import{createServer}from'node:http';import{createHash}from'node:crypto';const server=createServer((q,s)=>s.end('${runId}'));server.on('upgrade',(q,s)=>{const key=createHash('sha1').update(q.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');s.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+key+'\\r\\n\\r\\n');s.write(Buffer.concat([Buffer.from([129,36]),Buffer.from('${runId}')]));s.on('data',()=>s.end());});server.listen(3000,'0.0.0.0');`));
      await restricted.commands.start(['node', '/workspace/security-preview.mjs'], { timeoutMs: 120000 });
      const preview = await restricted.previews.create(3000, { ttlSeconds: 120 }); report.previewId = preview.id; await persist();
      try {
        let ready = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          const response = await fetch(preview.url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
          if (response.status === 200 && await response.text() === runId) { ready = true; break; } await delay(250);
        }
        assert.equal(ready, true); report.checks.protectedPreview = true;
        await wsAck(preview.url.replace('https:', 'wss:')); report.checks.previewWebSocket = true;
      } finally { await restricted.previews.revoke(preview.id); }
    });
    await phase('restricted-fork-and-stop-resume', async () => {
      await restricted.files.write('/workspace/security-marker', Buffer.from(runId));
      const fork = await journalStart('fork', options => restricted.fork({ name, ...options }));
      assert.equal(fork.internet, false); assert.deepEqual(fork.secretBindings, [secret.id]); assert.deepEqual(fork.networkPolicy, restricted.networkPolicy);
      assert.equal(Buffer.from(await fork.files.read('/workspace/security-marker')).toString(), runId);
      assertAcknowledgment((await probe(fork, { url: url('auth') })).acknowledgment, runId, true, 2); await scan(fork); report.checks.filesystemFork = true;
      const previous = restricted, stopKey = randomUUID(); report.operations.push({ kind: 'stop', idempotencyKey: stopKey, identity: identity(previous) }); await persist();
      await previous.stop({ idempotencyKey: stopKey });
      restricted = await journalStart('resume', options => previous.resume(options));
      assert.equal(restricted.id, previous.id); assert.notEqual(restricted.createdAt, previous.createdAt);
      assert.equal(restricted.internet, false); assert.deepEqual(restricted.secretBindings, [secret.id]); assert.deepEqual(restricted.networkPolicy, previous.networkPolicy);
      assert.equal(Buffer.from(await restricted.files.read('/workspace/security-marker')).toString(), runId);
      await denial(() => previous.files.read('/workspace/security-marker'), 409); report.checks.staleGeneration = true;
      assertAcknowledgment((await probe(restricted, { url: url('auth') })).acknowledgment, runId, true, 2);
      await scan(restricted); report.checks.stopResume = true; report.checks.snapshotCredentialScan = true;
      await fork.kill();
    });
    await phase('binding-deletion-and-explicit-denies', async () => {
      await slow(restricted, () => client.secrets.delete(secret.id)); report.checks.deletionDuringRequest = true;
      assert.equal((await probe(restricted, { url: url('auth') })).status, 403); report.checks.deletedBindingDenial = true; await restricted.kill();
      const empty = await journalStart('empty-allow', options => client.create({ catalogId: 'node', size: 'lite', name, networkPolicy: { allow: [] }, ...options })); await upload(empty);
      assert.equal((await probe(empty, { url: url('public') })).status, 403); report.checks.emptyAllowDenial = true; await empty.kill();
      const records = await lookup(new URL(upstreamOrigin).hostname, { all: true }); const denied = records.find(value => value.family === 4); assert.ok(denied, 'Owned host requires an IPv4 positive control');
      const cidr = await journalStart('cidr-deny', options => client.create({ catalogId: 'node', size: 'lite', name, networkPolicy: { allow: [denied.address + '/32'], deny: [denied.address + '/32'] }, ...options })); await upload(cidr);
      assert.equal((await probe(cidr, { url: `https://${denied.address}/` })).status, 403); report.checks.cidrDenial = true; await cidr.kill();
      report.startDelta = (await client.list()).usage.starts - baseline.usage.starts; report.secondaryStartDelta = (await other.list()).usage.starts - baselineSecondary.usage.starts;
      report.captureDelta = (await client.workspaces.list()).usage.savesThisMonth - baselineWorkspaces.usage.savesThisMonth;
      assert.equal(report.startDelta, 6); assert.equal(report.secondaryStartDelta, 0); assert.equal(report.captureDelta, 2); report.checks.exactStartBudget = true;
    });
  } catch (error) {
    report.errors.push(error?.status ? `HTTP ${error.status}: ${error.code ?? 'api_error'}` : 'qualification_failed');
    if (error instanceof Error) { try { assertNoCredentialLeak(error.message, credentials); report.failure = { stage: report.stage, name: error.name, message: error.message }; } catch {} }
  } finally {
    clearTimeout(timer); report.stage = 'cleanup'; await persist();
    try { await control('POST', undefined, 'release'); } catch { report.cleanup.errors.push('upstream_release_failed'); }
    if (baseline) try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const state = await cleanupClient.list();
        const owned = state.containers.filter(value => ownsSecurityResource(value, runId, report.identities));
        for (const value of owned) { try { await cleanupClient.connect(identity(value)).kill(); } catch (error) { if (![404, 409].includes(error.status)) throw error; } }
        if (!owned.length) break; await delay(1000);
      }
      for (const value of (await cleanupClient.secrets.list()).secrets) if (value.id === report.secretId || value.name === report.secretName) await cleanupClient.secrets.delete(value.id);
      for (const value of (await cleanupClient.workspaces.list()).workspaces) if (ownsSecurityResource(value, runId, report.identities)) await cleanupClient.workspaces.delete(value.id);
      const state = await cleanupClient.list(), negative = await cleanupOther.list(), secrets = (await cleanupClient.secrets.list()).secrets, workspaces = await cleanupClient.workspaces.list();
      report.cleanup.remainingOwnedContainers = state.containers.filter(value => ownsSecurityResource(value, runId, report.identities)).length;
      report.cleanup.remainingOwnedSecrets = secrets.filter(value => value.id === report.secretId || value.name === report.secretName).length;
      report.cleanup.remainingOwnedWorkspaces = workspaces.workspaces.filter(value => ownsSecurityResource(value, runId, report.identities)).length;
      report.cleanup.baselinePreserved = baselineSecrets.every(value => secrets.some(current => current.id === value.id)) && baselineWorkspaces.workspaces.every(value => workspaces.workspaces.some(current => current.id === value.id));
      report.startDelta = state.usage.starts - baseline.usage.starts; report.secondaryStartDelta = negative.usage.starts - baselineSecondary.usage.starts;
      report.captureDelta = workspaces.usage.savesThisMonth - baselineWorkspaces.usage.savesThisMonth;
    } catch { report.cleanup.errors.push('api_cleanup_or_inventory_failed'); }
    try { await control('DELETE'); report.cleanup.upstreamAbsent = (await control()).exists === false; } catch { report.cleanup.errors.push('upstream_cleanup_failed'); }
    report.cleanup.completed = report.cleanup.errors.length === 0 && report.cleanup.remainingOwnedContainers === 0 && report.cleanup.remainingOwnedSecrets === 0 && report.cleanup.remainingOwnedWorkspaces === 0 && report.cleanup.upstreamAbsent && report.cleanup.baselinePreserved;
    report.finishedAt = new Date().toISOString(); report.stage = 'completed'; report.ok = verifyProductionSecurity(report); await persist();
    await writeFile(join(output, 'result.sha256'), hash(await readFile(join(output, 'result.json'))) + '  result.json\n', { mode: 0o600 });
    for (const [signal, handler] of signals) process.off(signal, handler);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { output: { type: 'string' }, infrastructure: { type: 'string' }, account: { type: 'string' }, 'secondary-account': { type: 'string' } } });
    const report = await qualifyProductionSecurity({ output: values.output, infrastructure: values.infrastructure, account: values.account, secondaryAccount: values['secondary-account'] });
    console.log(JSON.stringify({ ok: report.ok, releaseQualified: report.releaseQualified, checksPassed: Object.values(report.checks).filter(Boolean).length, starts: report.startDelta, captures: report.captureDelta, cleanup: report.cleanup.completed, output: resolve(values.output) }));
    process.exitCode = report.interruptedBy === 'SIGINT' ? 130 : report.interruptedBy === 'SIGTERM' ? 143 : report.ok ? 0 : 1;
  } catch { console.error('Security production preflight failed; verify explicit inputs and private credential file.'); process.exitCode = 1; }
}
