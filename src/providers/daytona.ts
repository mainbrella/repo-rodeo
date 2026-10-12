import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Daytona, type Sandbox as CloudSandbox, type Snapshot } from '@daytona/sdk';
import { redact } from '../experiment-result.ts';
import type { Capabilities, CleanupResult, Execution, Inventory, Operation, PreparedState, Preview, ProviderAdapter, Receipt, Sandbox } from './interface.ts';

type Options = { apiUrl: string; apiKey: string; directory: string; sdk?: Daytona; fetch?: typeof fetch };
type State = { sandboxes: Sandbox[]; snapshots: string[] };
type Journal = { name: string; kind: string; request: unknown; startedAt: string;
  status: 'pending' | 'complete' | 'rejected' | 'uncertain'; response?: unknown; completedAt?: string; error?: string;
  providerError?: { code: string | null; message: string } };
type Job = { sandbox: Sandbox; sessionId: string; commandId: string };
type SnapshotLifecycle = {
  operationId: string; name: string; source: Sandbox;
  phase: 'stopping' | 'submitting' | 'waiting' | 'restarting' | 'complete' | 'uncertain' | 'rejected';
  submission: 'not-attempted' | 'pending' | 'acknowledged' | 'uncertain' | 'rejected';
  submissionHttpStatus?: number;
  observation?: { id: string | null; state: string; observedAt: string };
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const guestPath = '/opt/rodeo-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const seconds = (op: Operation) => Math.max(1, Math.ceil(op.timeoutMs / 1000));
const emptyState = (): State => ({ sandboxes: [], snapshots: [] });

export class DaytonaAdapter implements ProviderAdapter {
  readonly name = 'daytona' as const;
  private readonly directory: string;
  private readonly sdk: Daytona;
  private readonly apiKey: string;
  private readonly fetch: typeof fetch;
  private ready?: Promise<void>;
  private runLabel = '';
  private readonly clients = new Map<string, CloudSandbox>();

  constructor(options: Options) {
    if (options.apiUrl !== 'https://app.daytona.io/api') throw new Error('The Daytona adapter requires https://app.daytona.io/api');
    this.directory = resolve(options.directory);
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? fetch;
    this.sdk = options.sdk ?? new Daytona({ apiKey: options.apiKey, apiUrl: options.apiUrl, requestTimeoutMs: 30_000, otelEnabled: false });
  }
  private command(argv: string[], env?: Record<string, string>, cwd?: string) {
    // The default image's toolbox runs as daytona even when create(user: root)
    // reports root. Its passwordless sudo is needed for the shared /workspace.
    const command = ['sudo', '-n', '/usr/bin/env', ...Object.entries({ PATH: guestPath, ...env }).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid guest environment variable');
      return `${key}=${value}`;
    }), ...argv].map(quote).join(' ');
    return cwd ? `cd ${quote(cwd)} && ${command}` : command;
  }
  private async atomic(file: string, contents: string | Buffer) {
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
    const parent = await open(dirname(file), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
  private async json(file: string, value: unknown) { await this.atomic(file, JSON.stringify(value) + '\n'); }
  private async initialize(allowBind: boolean) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    for (const name of ['operations', 'owned', 'receipts', 'uploads']) await mkdir(join(this.directory, name), { mode: 0o700, recursive: true });
    const file = join(this.directory, 'daytona-credential.json');
    let binding: { schemaVersion: number; credentialHash: string; runLabel: string } | undefined;
    try {
      binding = JSON.parse(await readFile(file, 'utf8'));
      if (!binding || binding.schemaVersion !== 1 || binding.credentialHash !== hash(this.apiKey) ||
          typeof binding.runLabel !== 'string' || !/^[a-f0-9-]{36}$/.test(binding.runLabel))
        throw new Error('Daytona recovery credential differs from this run or its binding is invalid');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!allowBind || (await readdir(join(this.directory, 'operations'))).length || (await readdir(join(this.directory, 'owned'))).length)
        throw new Error('Daytona recovery has no credential binding; existing journals cannot be adopted');
    }
    await this.listSandboxes();
    if (!binding) {
      binding = { schemaVersion: 1, credentialHash: hash(this.apiKey), runLabel: randomUUID() };
      await this.json(file, binding);
    }
    this.runLabel = binding.runLabel;
  }
  private async init(allowBind = true, refresh = false) {
    if (!this.ready || refresh) this.ready = this.initialize(allowBind);
    await this.ready;
  }
  private stateFile() { return join(this.directory, 'owned', 'daytona.json'); }
  private async state(): Promise<State> {
    try {
      const value = JSON.parse(await readFile(this.stateFile(), 'utf8'));
      const validSandbox = (s: Sandbox) => s && typeof s.id === 'string' && s.generation === s.id;
      if (!value || !Array.isArray(value.sandboxes) || !Array.isArray(value.snapshots) ||
          !value.sandboxes.every(validSandbox) || !value.snapshots.every((s: unknown) => typeof s === 'string')) throw new Error('Daytona ownership journal is malformed');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(); throw error; }
  }
  private async saveSandbox(client: CloudSandbox): Promise<Sandbox> {
    const sandbox = { id: client.id, generation: client.id };
    this.clients.set(sandbox.id, client);
    const state = await this.state();
    if (!state.sandboxes.some(s => s.id === sandbox.id)) state.sandboxes.push(sandbox);
    await this.json(this.stateFile(), state);
    await this.json(join(this.directory, 'receipts', `sandbox-${sandbox.id}.json`), {
      id: client.id, name: client.name, organizationId: client.organizationId, snapshot: client.snapshot,
      sandboxClass: client.sandboxClass, cpu: client.cpu, memoryGiB: client.memory, diskGiB: client.disk,
      public: client.public, state: client.state, user: client.user, autoDestroyAt: client.autoDestroyAt,
    });
    return sandbox;
  }
  private opFile(name: string) { return join(this.directory, 'operations', `${hash(name).slice(0, 32)}.json`); }
  private async mutation<T>(op: Operation, kind: string, request: unknown, action: () => Promise<T>): Promise<T> {
    await this.init();
    op.signal?.throwIfAborted();
    const file = this.opFile(op.name);
    let record: Journal;
    try {
      record = JSON.parse(await readFile(file, 'utf8'));
      if (!record || record.name !== op.name || record.kind !== kind || JSON.stringify(record.request) !== JSON.stringify(request))
        throw new Error('Daytona operation journal changed or is malformed');
      if (record.status === 'complete') return record.response as T;
      throw new Error('Daytona operation was already attempted; reconcile it instead of replaying a non-idempotent request');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      record = { name: op.name, kind, request, startedAt: new Date().toISOString(), status: 'pending' };
      await this.json(file, record);
    }
    try {
      const result = await action();
      record.status = 'complete'; record.response = result; record.completedAt = new Date().toISOString();
      await this.json(file, record);
      return result;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      // A timeout response can follow admission. Never classify it as rejection.
      record.status = status && status >= 400 && status < 500 && status !== 408 ? 'rejected' : 'uncertain';
      record.error = `Daytona ${kind} failed${status ? ` with HTTP ${status}` : ''}`;
      record.providerError = { code: (error as { code?: string }).code ?? null,
        message: String(redact(error instanceof Error ? error.message : String(error), [this.apiKey])) };
      await this.json(file, record);
      throw new Error(record.error);
    }
  }
  private async receipt(op: Operation): Promise<Receipt> {
    const record: Journal = JSON.parse(await readFile(this.opFile(op.name), 'utf8'));
    return { operationId: op.name, requestedAt: record.startedAt, completedAt: record.completedAt ?? '', rawEvidencePath: this.opFile(op.name) };
  }
  private async listSandboxes() {
    const result: CloudSandbox[] = [];
    for await (const sandbox of this.sdk.list()) if (sandbox.state !== 'destroyed') result.push(sandbox);
    return result;
  }
  private async listSnapshots() {
    const result: Snapshot[] = [];
    for (let page = 1; ; page++) {
      const items = await this.sdk.snapshot.list({ page, limit: 100 });
      result.push(...items.items);
      if (page >= items.totalPages) return result;
    }
  }
  private async apiRequest(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, timeoutMs = 30_000) {
    return this.fetch(`https://app.daytona.io/api${path}`, {
      method, redirect: 'error', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))), ...(signal ? [signal] : [])]),
    });
  }
  private async snapshotPermissions() {
    const response = await this.apiRequest('/api-keys/current');
    if (!response.ok) throw new Error(`Daytona permission preflight failed with HTTP ${response.status}; provisioning was not attempted`);
    const metadata = await response.json() as { permissions?: unknown };
    if (!Array.isArray(metadata.permissions) || !metadata.permissions.every(p => typeof p === 'string'))
      throw new Error('Daytona permission preflight returned invalid scopes; provisioning was not attempted');
    const permissions = metadata.permissions as string[];
    const required = ['write:sandboxes', 'delete:sandboxes', 'write:snapshots', 'delete:snapshots'];
    const missing = required.filter(permission => !permissions.includes(permission));
    await this.json(join(this.directory, 'receipts', `permissions-${randomUUID()}.json`), {
      observedAt: new Date().toISOString(), required, permissions: metadata.permissions, missing,
    });
    if (missing.length) throw new Error(`Daytona saved-workspace requires ${missing.join(', ')}; provisioning was not attempted`);
  }
  private snapshotFile(operationId: string) { return join(this.directory, 'owned', `snapshot-${hash(operationId)}.json`); }
  private async observeSnapshot(operationId: string, name: string, operation?: Operation) {
    if (name !== `rodeo-${this.runLabel}-prepared`) throw new Error('Daytona snapshot name is not owned by this run');
    let observation: NonNullable<SnapshotLifecycle['observation']>;
    try {
      let snapshot: Snapshot;
      if (operation) {
        const response = await this.apiRequest(`/snapshots/${encodeURIComponent(name)}`, 'GET', undefined, operation.signal, Math.min(30_000, operation.timeoutMs));
        if (!response.ok) throw Object.assign(new Error(`Daytona snapshot lookup failed with HTTP ${response.status}`), { statusCode: response.status });
        snapshot = await response.json() as Snapshot;
      } else snapshot = await this.sdk.snapshot.get(name);
      if (!snapshot || snapshot.name !== name || typeof snapshot.id !== 'string' || typeof snapshot.state !== 'string')
        throw new Error('Daytona snapshot lookup returned an invalid identity or state');
      const state = await this.state();
      if (!state.snapshots.includes(snapshot.id)) { state.snapshots.push(snapshot.id); await this.json(this.stateFile(), state); }
      observation = { id: snapshot.id, state: snapshot.state, observedAt: new Date().toISOString() };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      observation = { id: null, state: 'absent', observedAt: new Date().toISOString() };
    }
    await this.json(join(this.directory, 'receipts', `snapshot-observation-${randomUUID()}.json`), { operationId, name, ...observation });
    return observation;
  }
  private async client(sandbox: Sandbox) {
    await this.init();
    if (sandbox.id !== sandbox.generation || !(await this.state()).sandboxes.some(s => s.id === sandbox.id)) throw new Error('Daytona sandbox is not owned by this run');
    let client = this.clients.get(sandbox.id);
    if (!client) { client = await this.sdk.get(sandbox.id); this.clients.set(sandbox.id, client); }
    return client;
  }
  async capabilities(): Promise<Capabilities> {
    await this.init();
    return { apiVersion: 'daytona-sdk-0.223.1', resources: [{ id: 'default' }], previews: true, managedJobs: true, jobReattachment: true,
      modes: { 'saved-workspace': { status: 'supported', reason: 'One persistent container filesystem snapshot, restored into three new sandboxes; subject to account enablement' },
        'filesystem-fork': { status: 'unsupported', reason: 'Daytona container sandboxes do not support native forks; use the explicit saved-workspace snapshot mode' },
        'memory-fork': { status: 'not-implemented', reason: 'Daytona VM memory forks are a separate sandbox class; this adapter implements container filesystem snapshots' },
        volume: { status: 'not-implemented', reason: 'Volume experiments are not implemented' },
        'warm-pool': { status: 'not-implemented', reason: 'Warm pool experiments are not implemented' } } };
  }
  async inventory(): Promise<Inventory> {
    await this.init();
    const [sandboxes, snapshots] = await Promise.all([this.listSandboxes(), this.listSnapshots()]);
    await this.json(join(this.directory, 'receipts', `inventory-${randomUUID()}.json`), {
      at: new Date().toISOString(), sandboxes: sandboxes.map(s => ({ id: s.id, name: s.name, labels: s.labels, state: s.state })), snapshots,
    });
    return { sandboxes: sandboxes.map(s => ({ id: s.id, generation: s.id })), activeContainers: sandboxes.filter(s => s.state === 'started').length,
      containerLimits: null, workspaces: snapshots.map(s => ({ id: s.id })), workspaceLimits: null, workspaceUsage: null };
  }
  private createParams(name: string) {
    return { name: `rodeo-${this.runLabel}-${hash(name).slice(0, 12)}`, user: 'root', language: 'typescript', public: false,
      ttlMinutes: 30, autoStopInterval: 30, autoDeleteInterval: -1, labels: { repo_rodeo_run: this.runLabel, repo_rodeo_operation: name } };
  }
  async create(request: Operation & { image: string; size: string }) {
    if (request.size !== 'default' || request.image !== 'default') throw new Error('Daytona uses its default container snapshot; select --size default');
    await this.init();
    request.signal?.throwIfAborted();
    await this.snapshotPermissions();
    const params = this.createParams(request.name);
    const sandbox = await this.mutation(request, 'create', params, async () => {
      const client = await this.sdk.create(params, { timeout: seconds(request) });
      const owned = await this.saveSandbox(client);
      if (client.sandboxClass && client.sandboxClass !== 'container') throw new Error('Daytona default snapshot is not a container');
      return owned;
    });
    return { sandbox, receipt: await this.receipt(request) };
  }
  async upload(sandbox: Sandbox, request: Operation & { path: string; bytes: Buffer }) {
    await this.init();
    const file = join(this.directory, 'uploads', `${hash(request.bytes)}.bin`);
    await this.atomic(file, request.bytes);
    await this.mutation(request, 'upload', { sandbox, path: request.path, size: request.bytes.length, sha256: hash(request.bytes), file }, async () => {
      const client = await this.client(sandbox);
      const staging = `/tmp/rodeo-upload-${hash(request.bytes)}`;
      await client.fs.uploadFile(file, staging, seconds(request));
      const install = await client.process.executeCommand(this.command(['/bin/sh', '-c',
        `mkdir -p ${quote(dirname(request.path))} && cp ${quote(staging)} ${quote(request.path)} && rm ${quote(staging)}`]), undefined, undefined, seconds(request));
      if (install.exitCode !== 0) throw new Error('Daytona upload could not be installed');
      return { uploaded: true };
    });
  }
  async execute(sandbox: Sandbox, request: Operation & { argv: string[]; cwd?: string; env?: Record<string, string> }): Promise<Execution> {
    return this.mutation(request, 'execute', { sandbox, argv: request.argv, cwd: request.cwd, env: request.env }, async () => {
      const client = await this.client(sandbox);
      const result = await client.process.executeCommand(this.command(request.argv, request.env), request.cwd, undefined, seconds(request));
      return { id: request.name, status: result.exitCode === 0 ? 'succeeded' : 'failed', exitCode: result.exitCode,
        timedOut: false, outputTruncated: false, stdout: result.result, stderr: '', cursor: Buffer.byteLength(result.result) };
    });
  }
  async capture(sandbox: Sandbox, request: Operation & { mode: PreparedState['mode']; dropResponseAfterHeaders?: boolean }): Promise<PreparedState> {
    if (request.dropResponseAfterHeaders) throw new Error('Daytona capture has no documented keyed replay contract');
    if (request.mode !== 'saved-workspace') throw new Error('Unsupported Daytona capture mode');
    await this.init();
    request.signal?.throwIfAborted();
    await this.snapshotPermissions();
    const name = `rodeo-${this.runLabel}-prepared`;
    const value = await this.mutation(request, 'snapshot', { sandbox, mode: request.mode, name }, async () => {
      const client = await this.client(sandbox);
      const deadline = Date.now() + request.timeoutMs;
      const remaining = () => {
        request.signal?.throwIfAborted();
        const time = deadline - Date.now();
        if (time <= 0) throw new Error('Daytona snapshot deadline exceeded; reconcile the persisted name without resubmitting');
        return time;
      };
      const lifecycle: SnapshotLifecycle = { operationId: request.name, name, source: sandbox, phase: 'stopping', submission: 'not-attempted' };
      const persist = () => this.json(this.snapshotFile(request.name), lifecycle);
      await persist();
      // Container snapshots require a stopped source. TTL still bounds retention;
      // immediate auto-delete would destroy it before capture could begin.
      try {
        await client.stop(Math.ceil(remaining() / 1000));
        this.clients.delete(sandbox.id); // Stopping rotates the standard preview token.
        remaining();
        lifecycle.phase = 'submitting'; lifecycle.submission = 'pending'; await persist();
        // Submit once using the SDK's public REST endpoint. The SDK's convenience
        // method also waits on sandbox state; observation here uses the exact name.
        try {
          const response = await this.apiRequest(`/sandbox/${encodeURIComponent(sandbox.id)}/snapshot`, 'POST', { name }, request.signal, Math.min(30_000, remaining()));
          lifecycle.submissionHttpStatus = response.status;
          await response.body?.cancel().catch(() => {});
          if (response.status >= 400 && response.status < 500 && response.status !== 408) {
            lifecycle.submission = 'rejected'; lifecycle.phase = 'rejected'; await persist();
            throw Object.assign(new Error('Daytona snapshot submission rejected'), { statusCode: response.status });
          }
          lifecycle.submission = response.ok ? 'acknowledged' : 'uncertain';
        } catch (error) {
          if (lifecycle.submission === 'rejected') throw error;
          lifecycle.submission = 'uncertain';
        }
        lifecycle.phase = 'waiting'; await persist();
        while (true) {
          remaining();
          lifecycle.observation = await this.observeSnapshot(request.name, name, { ...request, timeoutMs: remaining() }); await persist();
          remaining();
          if (lifecycle.observation.state === 'active') break;
          if (['error', 'build_failed', 'removing'].includes(lifecycle.observation.state))
            throw new Error(`Daytona snapshot entered ${lifecycle.observation.state}`);
          await pause(Math.min(1000, remaining()), undefined, { signal: request.signal });
        }
        lifecycle.phase = 'restarting'; await persist();
        await this.sdk.start(client, Math.ceil(remaining() / 1000));
        lifecycle.phase = 'complete'; await persist();
        return { id: lifecycle.observation.id! };
      } catch (error) {
        if (lifecycle.phase !== 'rejected') {
          lifecycle.phase = 'uncertain'; await persist();
          // A read/restart failure after submission cannot prove rejection.
          throw new Error('Daytona snapshot could not complete; reconcile its persisted name', { cause: error });
        }
        throw error;
      }
    });
    return { id: value.id, mode: request.mode, source: sandbox, preservation: 'filesystem', bytes: null, receipt: await this.receipt(request) };
  }
  async spawn(prepared: PreparedState, request: Operation) {
    await this.init();
    if (prepared.mode !== 'saved-workspace' || !(await this.state()).snapshots.includes(prepared.id)) throw new Error('Daytona snapshot is not owned by this run');
    const params = { ...this.createParams(request.name), snapshot: prepared.id };
    const sandbox = await this.mutation(request, 'spawn', params, async () => {
      return this.saveSandbox(await this.sdk.create(params, { timeout: seconds(request) }));
    });
    return { sandbox, receipt: await this.receipt(request) };
  }
  async preview(sandbox: Sandbox, request: Operation & { port: number }): Promise<Preview> {
    const client = await this.client(sandbox);
    await client.refreshData();
    if (client.public !== false) throw new Error('Daytona preview is not protected against unauthenticated traffic');
    const link = await client.getPreviewLink(request.port);
    if (!link.token) throw new Error('Daytona did not return a protected preview token');
    return { id: `preview-${sandbox.id}`, url: link.url, expiresAt: client.autoDestroyAt ?? null,
      headers: { 'x-daytona-preview-token': link.token, 'X-Daytona-Skip-Preview-Warning': 'true' } };
  }
  async revokePreview(_sandbox: Sandbox, _preview: Preview, _request: Operation) {
    // Standard preview tokens cannot be revoked separately. Delete their sandbox.
  }
  private jobFile(id: string) { return join(this.directory, 'owned', `job-${hash(id)}.json`); }
  async startJob(sandbox: Sandbox, request: Operation & { argv: string[]; cwd?: string; env?: Record<string, string> }): Promise<Execution> {
    return this.mutation(request, 'job', { sandbox, argv: request.argv, cwd: request.cwd, env: request.env }, async () => {
      const client = await this.client(sandbox); const sessionId = randomUUID();
      await client.process.createSession(sessionId);
      const result = await client.process.executeSessionCommand(sessionId, { command: this.command(
        ['timeout', '--signal=TERM', '--kill-after=5', String(seconds(request)), ...request.argv], request.env, request.cwd),
        runAsync: true, suppressInputEcho: true }, seconds(request));
      if (!result.cmdId) throw new Error('Daytona did not return a managed command ID');
      const id = `${sessionId}:${result.cmdId}`;
      await this.json(this.jobFile(id), { sandbox, sessionId, commandId: result.cmdId });
      return { id, status: 'running', exitCode: null, timedOut: false, outputTruncated: false, stdout: '', stderr: '', cursor: 0 };
    });
  }
  private async job(sandbox: Sandbox, id: string): Promise<Job> {
    const record: Job = JSON.parse(await readFile(this.jobFile(id), 'utf8'));
    if (record.sandbox?.id !== sandbox.id || record.sandbox.generation !== sandbox.generation ||
        typeof record.sessionId !== 'string' || typeof record.commandId !== 'string' || id !== `${record.sessionId}:${record.commandId}`)
      throw new Error('Daytona job ownership journal is malformed');
    return record;
  }
  async getJob(sandbox: Sandbox, id: string): Promise<Execution> {
    const client = await this.client(sandbox); const job = await this.job(sandbox, id);
    const command = await client.process.getSessionCommand(job.sessionId, job.commandId);
    const logs = await client.process.getSessionCommandLogs(job.sessionId, job.commandId);
    const stdout = logs.stdout ?? logs.output ?? ''; const stderr = logs.stderr ?? '';
    const exitCode = typeof command.exitCode === 'number' ? command.exitCode : null;
    const timedOut = exitCode === 124;
    return { id, status: exitCode === null ? 'running' : exitCode === 0 ? 'succeeded' : timedOut ? 'timed_out' : 'failed', exitCode,
      timedOut, outputTruncated: false, stdout, stderr, cursor: Buffer.byteLength(stdout) };
  }
  async readEvents(sandbox: Sandbox, id: string, cursor: number, until?: string) {
    const deadline = Date.now() + 30_000;
    let record: Execution;
    do {
      record = await this.getJob(sandbox, id);
      if (!until || record.stdout.includes(until)) break;
      if (Date.now() >= deadline) throw new Error('Daytona session output did not reach the requested observation');
      await pause(100);
    } while (true);
    const bytes = Buffer.from(record.stdout);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > bytes.length) throw new Error('Invalid Daytona retained stdout cursor');
    return { text: bytes.subarray(cursor).toString(), cursor: bytes.length };
  }
  async cleanup(): Promise<CleanupResult> {
    const errors: string[] = [];
    const snapshotObservations: NonNullable<CleanupResult['snapshotObservations']> = [];
    let state: State;
    try { await this.init(false, true); state = await this.state(); }
    catch { return { confirmed: false, sandboxes: [], workspaces: [], physicalStorage: 'not-measured', errors: ['Daytona cleanup credential or ownership could not be validated'] }; }
    try {
      const names = new Set<string>();
      for (const file of await readdir(join(this.directory, 'operations'))) {
        if (!file.endsWith('.json')) continue;
        const record: Journal = JSON.parse(await readFile(join(this.directory, 'operations', file), 'utf8'));
        if (!record || typeof record.kind !== 'string' || !['pending', 'complete', 'rejected', 'uncertain'].includes(record.status)) throw new Error('Malformed journal');
        if (['create', 'spawn', 'snapshot'].includes(record.kind) && ['pending', 'uncertain'].includes(record.status))
          errors.push(`Daytona operation ${record.name} remains uncertain; it was not reissued`);
        const request = record.request as { name?: string };
        if (['create', 'spawn'].includes(record.kind) && request?.name?.startsWith(`rodeo-${this.runLabel}-`)) names.add(request.name);
        if (record.kind === 'snapshot') {
          if (request?.name !== `rodeo-${this.runLabel}-prepared`) throw new Error('Malformed snapshot ownership');
          const observation = await this.observeSnapshot(record.name, request.name);
          snapshotObservations.push({ operationId: record.name, name: request.name, ...observation });
        }
      }
      // Exact-name observations can add an admitted snapshot after a lost response.
      state = await this.state();
      for (const sandbox of await this.listSandboxes()) if ((sandbox.labels.repo_rodeo_run === this.runLabel || names.has(sandbox.name)) && !state.sandboxes.some(s => s.id === sandbox.id))
        state.sandboxes.push({ id: sandbox.id, generation: sandbox.id });
      for (const snapshot of await this.listSnapshots()) if (snapshotObservations.some(s => s.name === snapshot.name) && !state.snapshots.includes(snapshot.id)) state.snapshots.push(snapshot.id);
      await this.json(this.stateFile(), state);
    } catch { errors.push('Daytona resource reconciliation or operation journals could not be read'); }
    // Remove restored branches before their prepared source.
    for (const sandbox of [...state.sandboxes].reverse()) {
      try { await this.sdk.delete(await this.sdk.get(sandbox.id), 60, true); }
      catch (error) { await this.json(join(this.directory, 'receipts', `delete-${sandbox.id}-${randomUUID()}.json`), {
        id: sandbox.id, error: 'Daytona sandbox deletion or lookup failed', statusCode: (error as { statusCode?: number }).statusCode ?? null,
      }); } // Inventory below determines absence even after a lost delete response.
    }
    for (const id of state.snapshots) {
      try { await this.sdk.snapshot.delete(id); }
      catch (error) { await this.json(join(this.directory, 'receipts', `delete-snapshot-${id}-${randomUUID()}.json`), {
        id, error: 'Daytona snapshot deletion failed', statusCode: (error as { statusCode?: number }).statusCode ?? null,
        message: String(redact(error instanceof Error ? error.message : String(error), [this.apiKey])),
      }); }
    }
    let inventory: Inventory | null = null;
    try {
      const deadline = Date.now() + 30_000;
      do {
        inventory = await this.inventory();
        if (!state.sandboxes.some(s => inventory!.sandboxes.some(i => i.id === s.id)) &&
            !state.snapshots.some(id => inventory!.workspaces.some(i => i.id === id))) break;
        if (Date.now() >= deadline) break;
        await pause(1000);
      } while (true);
    } catch { errors.push('Daytona cleanup inventory could not be verified'); }
    const sandboxes = state.sandboxes.map(sandbox => ({ sandbox, absent: !!inventory && !inventory.sandboxes.some(s => s.id === sandbox.id) }));
    const workspaces = state.snapshots.map(id => ({ id, absent: !!inventory && !inventory.workspaces.some(s => s.id === id) }));
    if ([...sandboxes, ...workspaces].some(s => !s.absent)) errors.push('One or more Daytona resources remain');
    return { confirmed: !!inventory && errors.length === 0, sandboxes, workspaces, physicalStorage: 'not-measured', errors, snapshotObservations };
  }
}
