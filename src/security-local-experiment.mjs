import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Mainbrella } from '../../backend/sdk/javascript/index.js';
import { createRelay, pinnedRequest } from '../../backend/services/egress-relay.mjs';
import { assessTcpDns } from '../../backend/scripts/security-local-dns.mjs';
import { securityUpstream } from '../fixtures/security/upstream.mjs';
import { assertAcknowledgment, assertNoCredentialLeak, verifyLocalSecurity } from './security-verifier.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const backend = resolve(repository, '../backend');
const requireBackend = createRequire(join(backend, 'package.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 10000 }).trim();
const identity = value => ({ id: value.id, createdAt: value.createdAt });

async function bounded(promise, ms = 30000, signal) {
  let timer, interrupt;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('qualification_timeout')), ms);
      interrupt = () => reject(new Error('qualification_interrupted'));
      signal?.addEventListener('abort', interrupt, { once: true });
      if (signal?.aborted) interrupt();
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', interrupt); }
}
async function listen(server) {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return server.address().port;
}
async function migrate(db, directory) {
  for (const file of (await readdir(join(backend, directory))).filter(name => name.endsWith('.sql')).sort()) {
    const parser = "import json,sqlite3,sys; source=open(sys.argv[1]).read(); statements=[]; pending=''\nfor char in source:\n pending+=char\n if char==';' and sqlite3.complete_statement(pending): statements.append(pending); pending=''\nprint(json.dumps(statements))";
    const statements = JSON.parse(execFileSync('python3', ['-c', parser, join(backend, directory, file)], { encoding: 'utf8', timeout: 10000 }));
    if (statements.length) await db.batch(statements.map(statement => db.prepare(statement)));
  }
}

// Test-only RPC hooks live in these temporary bundles. Customer HTTP handlers
// and native outbound entrypoints are imported unchanged from the backend.
const apiSource = `import api, {ContainerAccount} from './worker/index.ts';
export {AppState,AccountActivity,BuildWorkflow} from './worker/index.ts';
export class QualificationAccount extends ContainerAccount {
  async vaultRecords(){return [...(await this.ctx.storage.list({prefix:'vault:'})).values()];}
  setSecurity(name,value){this.controller.security.env[name]=value;}
}
export default {...api,fetch(request,env,ctx){const url=new URL(request.url);if(url.hostname.endsWith('.localhost')){const headers=new Headers(request.headers);headers.set('host',url.host);request=new Request(request,{headers});}return api.fetch(request,env,ctx);}};`;
const runtimeSource = `import {UserContainer} from './containers/user-container.js';
export {EgressOutbound,PrivateServiceOutbound} from './containers/user-container.js';
export class QualificationContainer extends UserContainer {
  async fence(){const metadata=await this.ctx.storage.get('builderMachine');metadata.telemetryId=crypto.randomUUID();await this.ctx.storage.put('builderMachine',metadata);}
  async reinstall(){await this.security.install(await this.ctx.storage.get('builderMachine'));}
  setSecurity(value){this.security.env.EGRESS_POLICIES_ENABLED=value;}
}
export default {fetch(){return new Response(null,{status:404});}};`;

export async function qualifyLocalSecurity({ image, output }) {
  assert.ok(image && output, 'Explicit existing image and new output directory required');
  output = resolve(output);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  const work = await mkdtemp(join(tmpdir(), 'rodeo-security-'));
  const runId = randomUUID(), suffix = randomBytes(6).toString('hex');
  const apiName = `rodeo-security-api-${suffix}`, runtimeName = `rodeo-security-runtime-${suffix}`;
  const report = { schemaVersion: 1, experiment: 'mainbrella-egress-vault', target: 'isolated-local-api-runtime-relay-tls', runId,
    startedAt: new Date().toISOString(), ok: false, releaseQualified: false, checks: {}, errors: [],
    budget: { maxStarts: 2, captures: 0 }, startsRequested: 0, stage: 'preflight',
    limitations: [
      'Synthetic local prepaid accounts; no production credentials, remote bindings, deployments or billing proof.',
      'Public DNS policy is real relay code with fixture answers; authorized public IPs map to loopback TLS upstreams.',
      'Worker-to-relay HTTPS is bridged to authenticated loopback HTTP; remote relay TLS is not exercised.',
      'The credential scan covers /workspace, /tmp, self environment and argv; no complete image or snapshot scan.',
      'RPC changes exercise account configuration and runtime incarnation fencing; no provider crash or deployed rollback proof.',
    ],
    pending: ['deployed API/runtime/relay transport and DNS/TLS', 'IPv6, alternate ports, raw UDP and full bypass matrix',
      'guest CA tampering', 'snapshot/fork/resume and secret absence from captures', 'expiry and actual provider recovery',
      'SSH, browser terminal and preview WebSockets', 'runtime downgrade and deployment gate withdrawal'],
    cleanup: { completed: false, remainingContainers: null, remainingSecrets: null, remainingDockerContainers: null, errors: [] } };
  const credentials = [], servers = [], waits = [];
  const persist = async () => {
    const bytes = JSON.stringify(report, null, 2) + '\n'; assertNoCredentialLeak(bytes, credentials);
    await writeFile(join(output, 'result.json.tmp'), bytes, { mode: 0o600 });
    await rename(join(output, 'result.json.tmp'), join(output, 'result.json'));
  };
  const abort = new AbortController();
  const onSigint = () => { report.interruptedBy = 'SIGINT'; abort.abort(); };
  const onSigterm = () => { report.interruptedBy = 'SIGTERM'; abort.abort(); };
  process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm);
  const timer = setTimeout(() => { report.errors.push('workload_deadline'); abort.abort(); }, 300000);
  let mf, clients = [], cleanupClients = [], accountStub, runtimeStub, config, sequence = 0;
  const phase = async (stage, action) => { abort.signal.throwIfAborted(); report.stage = stage; console.log(`Security: ${stage}`); await persist(); await bounded(action(), 90000, abort.signal); await persist(); };
  const denial = async (action, status) => {
    await assert.rejects(action(), error => error.status === status, `Expected HTTP ${status} denial`);
  };
  try {
    const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = requireBackend('miniflare');
    const { build } = requireBackend('esbuild');
    const details = JSON.parse(docker(['image', 'inspect', image]))[0];
    assert.equal(details.Os, 'linux');
    report.image = { supplied: image, id: details.Id, architecture: details.Architecture };
    report.versions = { node: process.version, docker: docker(['version', '--format', '{{.Server.Version}}']) };
    for (const name of ['wrangler', 'miniflare', 'workerd']) report.versions[name] = JSON.parse(await readFile(join(backend, 'node_modules', name, 'package.json'), 'utf8')).version;
    report.revisions = Object.fromEntries([['runner', repository], ['backend', backend]].map(([name, cwd]) => [name, {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
      dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim(),
    }]));
    report.inputHashes = {};
    const retain = async (name, bytes) => {
      assertNoCredentialLeak(bytes, credentials);
      const destination = join(output, 'inputs', name); await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }); report.inputHashes[name] = hash(bytes);
    };
    for (const file of ['src/security-local-experiment.mjs', 'src/security-verifier.ts', 'fixtures/security/probe.mjs', 'fixtures/security/upstream.mjs', 'tests/security-verifier.test.ts', 'tests/security-upstream.test.ts', 'package.json', 'package-lock.json']) await retain(file, await readFile(join(repository, file)));
    for (const file of ['package-lock.json', 'sdk/javascript/index.js', 'services/egress-relay.mjs', 'scripts/security-local-dns.mjs']) await retain(`backend/${file}`, await readFile(join(backend, file)));
    const disposable = () => { const value = randomBytes(32).toString('hex'); credentials.push(value); return value; };
    const token = disposable(), rotated = disposable(), relayToken = disposable(), encryptionKey = randomBytes(32).toString('base64');
    credentials.push(encryptionKey);
    const upstream = securityUpstream(runId); upstream.rotate(token); report.upstreamEvents = upstream.events;
    const openssl = args => execFileSync('openssl', args, { stdio: 'ignore', timeout: 10000 });
    const file = name => join(work, name);
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('ca.key'), '-out', file('ca.pem'), '-days', '1', '-subj', '/CN=Rodeo disposable CA']);
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('server.key'), '-out', file('server.csr'), '-subj', '/CN=api.example.com']);
    await writeFile(file('extensions'), 'basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:*.example.com\n');
    openssl(['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-CAcreateserial', '-out', file('server.pem'), '-days', '1', '-extfile', file('extensions')]);
    const tls = https.createServer({ key: await readFile(file('server.key')), cert: await readFile(file('server.pem')) }, upstream.handle);
    const plain = http.createServer(upstream.handle); servers.push(tls, plain);
    const tlsPort = await listen(tls), httpPort = await listen(plain), ca = await readFile(file('ca.pem'));
    const dnsQueries = []; report.dnsQueries = dnsQueries;
    const relay = createRelay({ token: relayToken, resolver: async hostname => {
      dnsQueries.push(hostname);
      if (hostname === 'mixed.example.com') return [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }];
      return [{ address: hostname === 'cidr.example.com' ? '8.8.8.8' : '93.184.216.34', family: 4 }];
    }, transport: (target, checked, options, bytes, signal) => {
      assert.deepEqual(checked, { address: '93.184.216.34', family: 4 });
      const localTarget = new URL(target); localTarget.port = String(target.protocol === 'https:' ? tlsPort : httpPort);
      return pinnedRequest(localTarget, { address: '127.0.0.1', family: 4 }, { ...options, ca }, bytes, signal);
    } });
    servers.push(relay); const relayPort = await listen(relay);
    const apiConfig = JSON.parse(await readFile(join(backend, 'wrangler.jsonc'), 'utf8'));
    const runtimeConfig = JSON.parse(await readFile(join(backend, 'wrangler.containers.jsonc'), 'utf8'));
    const bundles = await Promise.all([apiSource, runtimeSource].map(async (source, at) => {
      const outfile = file(`bundle-${at}.mjs`);
      await build({ stdin: { contents: source, resolveDir: backend, sourcefile: `security-${at}.js` }, outfile,
        bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*', 'node:*'], logLevel: 'silent' });
      const bytes = await readFile(outfile); await retain(`bundle-${at}.mjs`, bytes); return bytes.toString('utf8');
    }));
    const portProbe = http.createServer(); const apiPort = await listen(portProbe);
    await new Promise(done => portProbe.close(done));
    const bindings = { LOCAL_DEV: 'true', LOCAL_PREVIEW_PORT: String(apiPort), PREVIEWS_ENABLED: 'true', PREVIEW_DOMAIN: 'localhost',
      EGRESS_POLICIES_ENABLED: 'true', SECRETS_VAULT_ENABLED: 'true', EGRESS_RELAY_URL: 'https://relay.example.com/v1/egress',
      EGRESS_RELAY_TOKEN: relayToken, SECRETS_ENCRYPTION_KEY: encryptionKey, BUILD_ENABLED: 'false', ACTIVITY_WEBSOCKET_ENABLED: 'false' };
    const outboundService = async request => {
      report.outboundRequests ??= []; report.outboundRequests.push({ url: request.url, method: request.method });
      assert.equal(request.url, bindings.EGRESS_RELAY_URL, 'Unexpected Worker outbound request');
      const response = await fetch(`http://127.0.0.1:${relayPort}/v1/egress`, { method: 'POST', headers: request.headers, body: await request.arrayBuffer(), signal: AbortSignal.timeout(30000) });
      report.outboundRequests.at(-1).status = response.status;
      return response;
    };
    config = { host: '127.0.0.1', port: apiPort, cf: false, log: new Log(LogLevel.ERROR), telemetry: { enabled: false },
      d1Persist: file('d1'), durableObjectsPersist: file('do'), r2Persist: file('r2'), workers: [
        { name: apiName, modules: true, script: bundles[0], compatibilityDate: apiConfig.compatibility_date, compatibilityFlags: apiConfig.compatibility_flags,
          bindings, d1Databases: { DB: 'security-accounts', PREVIEW_ROUTES: 'security-previews' }, r2Buckets: { BUCKET: 'security-storage' },
          workflows: { BUILD_WORKFLOW: { name: 'security-build', className: 'BuildWorkflow' } }, outboundService,
          durableObjects: { ACCOUNT_ACTIVITY: { className: 'AccountActivity', useSQLite: true }, CONTAINER_ACCOUNT: { className: 'QualificationAccount', useSQLite: true }, USER_CONTAINER: { className: 'QualificationContainer', scriptName: runtimeName } } },
        { name: runtimeName, modules: true, script: bundles[1], compatibilityDate: runtimeConfig.compatibility_date, compatibilityFlags: runtimeConfig.compatibility_flags,
          bindings, outboundService, durableObjects: { ACCOUNT_ACTIVITY: { className: 'AccountActivity', scriptName: apiName }, CONTAINER_ACCOUNT: { className: 'QualificationAccount', scriptName: apiName },
            USER_CONTAINER: { className: 'QualificationContainer', useSQLite: true, container: { images: [{ name: 'terminal', image: details.Id }] } } } },
      ] };
    const hooks = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, new Set(process.listeners(signal))]));
    mf = new Miniflare(convertV4MiniflareOptions(config));
    for (const [signal, prior] of hooks) for (const handler of process.listeners(signal)) if (!prior.has(handler)) process.off(signal, handler);
    const baseUrl = (await bounded(mf.ready, 45000, abort.signal)).origin; report.apiOrigin = baseUrl;
    await phase('disposable-accounts', async () => {
      await migrate(await mf.getD1Database('DB', apiName), 'migrations');
      await migrate(await mf.getD1Database('PREVIEW_ROUTES', apiName), 'preview-migrations');
      const db = await mf.getD1Database('DB', apiName), accounts = await mf.getDurableObjectNamespace('CONTAINER_ACCOUNT', apiName);
      for (let at = 0; at < 2; at++) {
        const userId = `security_${suffix}_${at}`, key = `mb_${disposable()}`, customerId = `cus_security_${suffix}_${at}`;
        credentials.push(key);
        await db.prepare('INSERT INTO users(id,email,name) VALUES(?,?,?)').bind(userId, `${userId}@example.invalid`, 'Rodeo disposable security fixture').run();
        await db.prepare('INSERT INTO api_keys(id,user_id,name,token_hash,prefix,created_at) VALUES(?,?,?,?,?,?)').bind(randomUUID(), userId, 'Disposable local security', hash(key), key.slice(0, 11), new Date().toISOString()).run();
        await db.prepare('INSERT INTO prepaid_accounts(user_id,stripe_customer_id,created_at) VALUES(?,?,?)').bind(userId, customerId, Date.now()).run();
        const stub = accounts.get(accounts.idFromName(`account:${userId}`));
        const funding = await stub.fetch('http://local/billing/funding', { method: 'POST', headers: { 'x-mainbrella-user': userId }, body: JSON.stringify({ id: `pi_security_${suffix}_${at}`, customerId, amountCents: 5000, refundedCents: 0, disputed: false, createdAt: Date.now(), kind: 'topup' }) });
        assert.equal(funding.status, 200);
        const fetcher = async (url, options = {}) => {
          assert.equal(new URL(url).origin, baseUrl);
          const response = await fetch(url, { ...options, signal: AbortSignal.any([abort.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(60000)]) });
          const bytes = Buffer.from(await response.arrayBuffer()); assertNoCredentialLeak(bytes, credentials);
          report.receipts ??= []; report.receipts.push({ sequence: ++sequence, method: options.method ?? 'GET', path: new URL(url).pathname, status: response.status });
          return new Response(bytes, { status: response.status, headers: response.headers });
        };
        clients.push({ userId, client: new Mainbrella({ apiKey: key, baseUrl, fetch: fetcher, timeoutMs: 60000 }) });
        cleanupClients.push(new Mainbrella({ apiKey: key, baseUrl, timeoutMs: 10000 }));
        if (at === 0) accountStub = stub;
      }
    });
    const client = clients[0].client, other = clients[1].client;
    const selection = { catalogId: 'node', size: 'lite', networkPolicy: { allow: ['*.example.com'], deny: ['denied.example.com', '8.8.8.0/24'] } };
    let secret, restricted, online;
    const guestConfig = extra => ({ runId, credentials: [token, rotated].flatMap(value => [value, Buffer.from(value).toString('base64')]).map(value => ({ length: value.length, sha256: hash(value) })), ...extra });
    const probe = async (sandbox, extra) => {
      const job = await sandbox.commands.start(['node', '/workspace/security-probe.mjs', JSON.stringify(guestConfig(extra))], { timeoutMs: 20000 });
      const result = await job.wait({ timeoutMs: 30000, pollIntervalMs: 50 });
      assert.equal(result.exitCode, 0, 'Guest probe did not complete'); assert.equal(result.outputTruncated, false, 'Guest output was truncated');
      assertNoCredentialLeak(result.stdout + result.stderr, credentials); return JSON.parse(result.stdout);
    };
    const upload = async sandbox => {
      await sandbox.files.write('/workspace/security-probe.mjs', await readFile(join(repository, 'fixtures/security/probe.mjs')));
      await sandbox.files.write('/workspace/dns.mjs', await readFile(join(backend, 'scripts/security-local-dns.mjs')));
    };
    await phase('vault-and-admission', async () => {
      const caps = await client.capabilities(); assert.equal(caps.networking.egressPolicies, true, 'Enabled policy discovery'); assert.equal(caps.secrets.vault, true, 'Enabled vault discovery'); report.checks.enabledDiscovery = true;
      secret = await client.secrets.create({ name: `Rodeo ${runId}`, value: token, hostname: 'api.example.com', header: 'authorization', prefix: 'Bearer ' });
      const records = await accountStub.vaultRecords(); assert.equal(records.length, 1);
      assertNoCredentialLeak(JSON.stringify(records), [token]); assert.ok(records[0].ciphertext && records[0].iv);
      const key = await crypto.subtle.importKey('raw', Buffer.from(encryptionKey, 'base64'), 'AES-GCM', false, ['decrypt']);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(records[0].iv, 'base64'),
        additionalData: Buffer.from(`${clients[0].userId}:${secret.id}`) }, key, Buffer.from(records[0].ciphertext, 'base64'));
      assert.equal(Buffer.from(decrypted).toString(), token); report.checks.vaultCiphertext = true;
      const listed = await client.secrets.list(); assert.deepEqual(listed.secrets, [secret]);
      assert.deepEqual(Object.keys(secret).sort(), ['createdAt', 'header', 'hostname', 'id', 'name', 'prefix', 'updatedAt']); report.checks.metadataOnly = true;
      assert.deepEqual((await other.secrets.list()).secrets, []);
      await denial(() => other.secrets.rotate(secret.id, rotated), 404);
      const before = (await client.list()).usage.starts;
      await denial(() => other.create({ ...selection, secretBindings: [secret.id] }), 404); report.checks.crossAccountIsolation = true;
      await denial(() => client.request('/containers', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { ...selection, internet: true } }), 400);
      assert.equal((await client.list()).usage.starts, before); assert.equal((await other.list()).usage.starts, 0); report.checks.invalidSelectionDoesNotStart = true;
    });
    await phase('online-positive-controls', async () => {
      report.startsRequested++; report.onlineKey = randomUUID(); await persist();
      online = await client.create({ catalogId: 'node', size: 'lite', idempotencyKey: report.onlineKey, waitTimeoutMs: 60000, pollIntervalMs: 50 });
      report.online = identity(online); await upload(online);
      report.onlineProtocols = await probe(online, { protocols: true });
      assert.equal(report.onlineProtocols.udpTxt, true, 'Online UDP DNS control is unreachable');
      assert.equal(report.onlineProtocols.tcpDns.validResponse, true, 'Online TCP DNS control is indeterminate');
      assert.equal(report.onlineProtocols.tcpDns.answered, true, 'Online TCP DNS control has no answer');
      await online.kill();
    });
    await phase('native-restricted-guest', async () => {
      report.startsRequested++; report.restrictedKey = randomUUID(); await persist();
      restricted = await client.create({ ...selection, secretBindings: [secret.id], idempotencyKey: report.restrictedKey, waitTimeoutMs: 60000, pollIntervalMs: 50 });
      report.restricted = identity(restricted); assert.equal(restricted.internet, false);
      const replay = await client.create({ ...selection, secretBindings: [secret.id], idempotencyKey: report.restrictedKey, waitTimeoutMs: 10000, pollIntervalMs: 50 });
      assert.deepEqual(identity(replay), identity(restricted)); report.checks.sameKeyReplay = true;
      const namespace = await mf.getDurableObjectNamespace('USER_CONTAINER', runtimeName);
      const machineName = restricted.id === 'small' ? `user:${clients[0].userId}` : `user:${clients[0].userId}:slot:${restricted.id.slice(1)}`;
      runtimeStub = namespace.get(namespace.idFromName(machineName));
      await upload(restricted);
      report.offlineProtocols = await probe(restricted, { protocols: true });
      assert.equal(assessTcpDns(report.onlineProtocols.tcpDns, report.offlineProtocols.tcpDns), 'denied'); report.checks.publicTcpDnsDenial = true;
      assert.equal(report.offlineProtocols.udpTxt, false); report.checks.publicUdpDnsDenial = true;
      const plain = await probe(restricted, { url: 'http://api.example.com/public' }); report.httpProbe = plain;
      assert.equal(plain.status, 200); assertAcknowledgment(plain.acknowledgment, runId, false, 1); report.checks.allowedHttp = true;
      const ack = await probe(restricted, { url: 'https://api.example.com/auth', headers: { authorization: 'guest-spoof', 'x-egress-id': 'c999', 'x-mainbrella-user': 'victim' } });
      assert.equal(ack.status, 200); assert.equal(ack.cookieRemoved, true); assertAcknowledgment(ack.acknowledgment, runId, true, 1);
      report.checks.allowedHttps = true; report.checks.guestHeaderSpoofing = true;
      for (const [name, urls] of [
        ['domainDenial', ['https://denied.example.com/public', 'https://unlisted.example.org/public']],
        ['cidrDenial', ['https://cidr.example.com/public']], ['mixedDnsDenial', ['https://mixed.example.com/public']],
        ['redirectDenial', ['https://api.example.com/redirect']],
        ['reflectionDenial', ['https://api.example.com/reflect', 'https://api.example.com/reflect-header', 'https://api.example.com/reflect-base64']],
      ]) {
        for (const url of urls) { const reply = await probe(restricted, { url }); assert.equal(reply.status, 403, `${name} did not deny`); assert.equal(reply.credentialReflected, false); }
        report.checks[name] = true;
      }
      assert.ok(!dnsQueries.includes('denied.example.com') && !dnsQueries.includes('unlisted.example.org'), 'Denied host reached relay DNS');
    });
    await phase('rotation-and-incarnation-fencing', async () => {
      const slow = async action => {
        const wait = upstream.hold(); waits.push(wait);
        const pending = probe(restricted, { url: 'https://api.example.com/slow' });
        void pending.catch(() => {});
        try { await bounded(wait.received, 15000, abort.signal); await action(); }
        finally { try { wait.release(); } catch {} }
        assert.equal((await pending).status, 403, 'Superseded response was released');
      };
      await slow(async () => { await client.secrets.rotate(secret.id, rotated); upstream.rotate(rotated); }); report.checks.rotationDuringRequest = true;
      const reply = await probe(restricted, { url: 'https://api.example.com/auth' });
      assert.equal(reply.status, 200); assertAcknowledgment(reply.acknowledgment, runId, true, 2); report.checks.rotation = true;
      await slow(() => runtimeStub.fence()); report.checks.incarnationDuringRequest = true;
      await runtimeStub.reinstall(); assert.equal((await probe(restricted, { url: 'https://api.example.com/auth' })).status, 200);
      for (const [name, enabled, disabled] of [['EGRESS_POLICIES_ENABLED', 'true', 'false'], ['EGRESS_RELAY_TOKEN', relayToken, ''], ['SECRETS_ENCRYPTION_KEY', encryptionKey, '']]) {
        await accountStub.setSecurity(name, disabled);
        try {
          const denied = await probe(restricted, { url: 'https://api.example.com/auth' });
          assert.ok([403, 502].includes(denied.status), 'Missing configuration released a credentialed response');
          await denial(() => client.create({ ...selection, secretBindings: [secret.id], idempotencyKey: randomUUID() }), 503);
        } finally { await accountStub.setSecurity(name, enabled); }
      }
      await runtimeStub.setSecurity('false');
      try { assert.equal((await probe(restricted, { url: 'https://api.example.com/auth' })).status, 403); }
      finally { await runtimeStub.setSecurity('true'); }
      report.checks.configurationWithdrawal = true;
      const scan = await probe(restricted, { scan: true });
      assert.equal(scan.credentialsFound, false); assert.deepEqual(scan.skipped, []); assert.ok(scan.scannedBytes > 0);
      report.guestCredentialScan = scan; report.checks.guestCredentialScan = true;
      await restricted.files.write('/workspace/security-preview.mjs', Buffer.from(`import{createServer}from'node:http';createServer((q,s)=>s.end('rodeo-security-preview')).listen(3000,'0.0.0.0');`));
      await restricted.commands.start(['node', '/workspace/security-preview.mjs'], { timeoutMs: 60000 });
      const link = await restricted.previews.create(3000, { ttlSeconds: 60 });
      let connected = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        const reply = await mf.dispatchFetch(link.url, { headers: { Host: new URL(link.url).host } });
        if (reply.status === 200 && await reply.text() === 'rodeo-security-preview') { connected = true; break; }
        await new Promise(done => setTimeout(done, 100));
      }
      assert.equal(connected, true); await restricted.previews.revoke(link.id); report.checks.protectedPreview = true;
      await slow(() => client.secrets.delete(secret.id)); report.checks.deletionDuringRequest = true;
      assert.equal((await probe(restricted, { url: 'https://api.example.com/auth' })).status, 403); report.checks.deletedBindingDenial = true;
      assert.deepEqual((await client.secrets.list()).secrets, []);
      assert.equal((await client.list()).usage.starts, 2); assert.equal((await other.list()).usage.starts, 0); report.checks.exactStartBudget = true;
      await restricted.kill();
    });
    await phase('disabled-api-gates', async () => {
      config.workers[0].bindings = { ...config.workers[0].bindings, EGRESS_POLICIES_ENABLED: 'false', SECRETS_VAULT_ENABLED: 'false' };
      await mf.setOptions(convertV4MiniflareOptions(config));
      const caps = await client.capabilities(); assert.equal(caps.networking.egressPolicies, false); assert.equal(caps.secrets.vault, false);
      await denial(() => client.secrets.create({ name: 'disabled', value: token, hostname: 'api.example.com', header: 'authorization' }), 503);
      assert.deepEqual((await client.secrets.list()).secrets, []); report.checks.disabledDiscovery = true;
    });
    report.upstreamEvents = upstream.events;
  } catch (error) {
    report.errors.push(error?.status ? `HTTP ${error.status}: ${error.code ?? 'api_error'}` : 'qualification_failed');
    // Keep assertion messages only after scanning them; no arbitrary API bodies.
    if (error instanceof Error) { const message = error.message; try { assertNoCredentialLeak(message, credentials); report.failure = { stage: report.stage, name: error.name, message }; } catch {} }
  } finally {
    clearTimeout(timer); report.stage = 'cleanup'; await persist();
    for (const wait of waits) { try { wait.release(); } catch {} }
    if (mf) {
      for (const client of cleanupClients) try {
        // Each account/key was created exclusively in this run's isolated D1.
        // Recover accepted requests from its inventory, then fence exact identities.
        for (const value of (await client.list()).containers) await client.connect(identity(value)).kill();
        for (const secret of (await client.secrets.list()).secrets) await client.secrets.delete(secret.id);
      } catch { report.cleanup.errors.push('api_cleanup_failed'); }
      try {
        report.cleanup.remainingContainers = 0; report.cleanup.remainingSecrets = 0;
        for (const client of cleanupClients) { report.cleanup.remainingContainers += (await client.list()).containers.length; report.cleanup.remainingSecrets += (await client.secrets.list()).secrets.length; }
      } catch { report.cleanup.remainingContainers = null; report.cleanup.remainingSecrets = null; report.cleanup.errors.push('api_inventory_failed'); }
      try { await bounded(mf.dispose(), 20000); } catch { report.cleanup.errors.push('runtime_dispose_failed'); }
    }
    for (const server of servers.reverse()) { server.closeAllConnections(); await bounded(new Promise(done => server.close(done)), 5000).catch(() => report.cleanup.errors.push('fixture_shutdown_failed')); }
    try {
      const owned = docker(['ps', '-a', '--format', '{{.ID}}\t{{.Names}}']).split('\n').filter(line => line.split('\t')[1]?.startsWith(`workerd-${runtimeName}-`)).map(line => line.split('\t')[0]);
      if (owned.length) docker(['rm', '-f', ...owned]);
      report.cleanup.remainingDockerContainers = docker(['ps', '-a', '--format', '{{.Names}}']).split('\n').filter(name => name.startsWith(`workerd-${runtimeName}-`));
    } catch { report.cleanup.errors.push('docker_cleanup_failed'); }
    await rm(work, { recursive: true, force: true });
    report.cleanup.completed = report.cleanup.errors.length === 0 && report.cleanup.remainingContainers === 0
      && report.cleanup.remainingSecrets === 0 && report.cleanup.remainingDockerContainers?.length === 0;
    report.finishedAt = new Date().toISOString(); report.stage = 'completed'; report.ok = verifyLocalSecurity(report); await persist();
    await writeFile(join(output, 'result.sha256'), hash(await readFile(join(output, 'result.json'))) + '  result.json\n', { flag: 'wx', mode: 0o600 });
    process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { image: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('npm run qualify:security:local -- --image <existing-local-image> --output <new-directory>\nUses isolated local D1/Workers and two sequential native Docker starts. Requires ../backend/node_modules, Docker, Python 3 and OpenSSL.');
    else {
      const report = await qualifyLocalSecurity(values);
      console.log(JSON.stringify({ output: values.output, ok: report.ok, releaseQualified: report.releaseQualified, checks: report.checks, errors: report.errors, failure: report.failure, cleanup: report.cleanup }, null, 2));
      process.exitCode = report.interruptedBy === 'SIGINT' ? 130 : report.interruptedBy === 'SIGTERM' ? 143 : report.ok ? 0 : 1;
    }
  } catch { console.error('Security qualification could not start; use --help and a new output directory.'); process.exitCode = 1; }
}
