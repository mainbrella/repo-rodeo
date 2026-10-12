import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Sandbox as CloudSandbox, CommandExitError, type CommandHandle } from 'e2b';
import type { Capabilities, CleanupResult, Execution, Inventory, Operation, PreparedState, Preview, ProviderAdapter, Receipt, Sandbox } from './interface.ts';

type Options = { apiUrl: string; apiKey: string; directory: string; sdk?: typeof CloudSandbox };
type State = { sandboxes: Sandbox[]; snapshots: string[]; forks: Record<string, Sandbox[]> };
type Journal = { name: string; kind: string; request: unknown; startedAt: string;
  status: 'pending' | 'complete' | 'rejected' | 'uncertain'; response?: any; completedAt?: string; error?: string };
type Job = { sandbox: Sandbox; pid: number; stdout: string; stderr: string; result: string };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const lifetimeMs = 30 * 60_000;
const guestPath = '/opt/rodeo-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const emptyState = (): State => ({ sandboxes: [], snapshots: [], forks: {} });

export class E2BAdapter implements ProviderAdapter {
  readonly name = 'e2b' as const;
  private readonly directory: string;
  private readonly sdk: typeof CloudSandbox;
  private readonly apiKey: string;
  private ready?: Promise<void>;
  private runLabel = '';
  private readonly clients = new Map<string, CloudSandbox>();
  private readonly handles = new Map<string, CommandHandle>();

  constructor(options: Options) {
    if (options.apiUrl !== 'https://api.e2b.dev') throw new Error('The E2B adapter requires https://api.e2b.dev');
    this.directory = resolve(options.directory);
    this.apiKey = options.apiKey;
    this.sdk = options.sdk ?? CloudSandbox;
  }
  private config(op?: Operation) {
    return { apiKey: this.apiKey, retries: 0, requestTimeoutMs: Math.min(op?.timeoutMs ?? 30_000, 180_000), ...(op?.signal ? { signal: op.signal } : {}) };
  }
  private command(argv: string[], env?: Record<string, string>) {
    // E2B's login shell initializes its template's Node installation after envs
    // are applied. Set PATH at command invocation so child processes inherit it.
    return ['/usr/bin/env', `PATH=${env?.PATH ?? guestPath}`, ...argv].map(quote).join(' ');
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
    const file = join(this.directory, 'e2b-credential.json');
    let binding: { schemaVersion: number; credentialHash: string; runLabel: string } | undefined;
    try {
      binding = JSON.parse(await readFile(file, 'utf8'));
      if (!binding || binding.schemaVersion !== 1 || binding.credentialHash !== hash(this.apiKey) ||
          typeof binding.runLabel !== 'string' || !/^[a-f0-9-]{36}$/.test(binding.runLabel))
        throw new Error('E2B recovery credential differs from this run or its binding is invalid');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!allowBind || (await readdir(join(this.directory, 'operations'))).length || (await readdir(join(this.directory, 'owned'))).length)
        throw new Error('E2B recovery has no credential binding; existing journals cannot be adopted');
    }
    // The public API does not expose team identity to API keys. Pin the exact
    // authenticated credential instead of treating another team's empty list as proof.
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
  private stateFile() { return join(this.directory, 'owned', 'e2b.json'); }
  private async state(): Promise<State> {
    try {
      const value = JSON.parse(await readFile(this.stateFile(), 'utf8'));
      if (!value || !Array.isArray(value.sandboxes) || !Array.isArray(value.snapshots) || !value.forks ||
          value.sandboxes.some((s: Sandbox) => typeof s.id !== 'string' || s.generation !== s.id) ||
          value.snapshots.some((s: unknown) => typeof s !== 'string')) throw new Error('E2B ownership journal is malformed');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(); throw error; }
  }
  private async saveSandbox(client: CloudSandbox): Promise<Sandbox> {
    const sandbox = { id: client.sandboxId, generation: client.sandboxId };
    this.clients.set(sandbox.id, client);
    const state = await this.state();
    if (!state.sandboxes.some(s => s.id === sandbox.id)) state.sandboxes.push(sandbox);
    await this.json(this.stateFile(), state);
    return sandbox;
  }
  private opFile(name: string) { return join(this.directory, 'operations', `${hash(name).slice(0, 32)}.json`); }
  private async mutation<T>(op: Operation, kind: string, request: unknown, action: () => Promise<T>): Promise<T> {
    await this.init();
    const file = this.opFile(op.name);
    let record: Journal;
    try {
      record = JSON.parse(await readFile(file, 'utf8'));
      if (!record || record.name !== op.name || record.kind !== kind || JSON.stringify(record.request) !== JSON.stringify(request))
        throw new Error('E2B operation journal changed or is malformed');
      if (record.status === 'complete') return record.response as T;
      throw new Error('E2B operation was already attempted; reconcile it instead of replaying a non-idempotent request');
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
      record.status = status && status >= 400 && status < 500 ? 'rejected' : 'uncertain';
      record.error = `E2B ${kind} failed${status ? ` with HTTP ${status}` : ''}`;
      if (String((error as Error).message).includes('snapshot_filesystem_only_disabled')) record.error += ': filesystem-only snapshots are disabled for this project';
      await this.json(file, record);
      throw new Error(record.error);
    }
  }
  private async receipt(op: Operation): Promise<Receipt> {
    const record: Journal = JSON.parse(await readFile(this.opFile(op.name), 'utf8'));
    return { operationId: op.name, requestedAt: record.startedAt, completedAt: record.completedAt ?? '', rawEvidencePath: this.opFile(op.name) };
  }
  private async listSandboxes() {
    const paginator = this.sdk.list({ ...this.config(), query: { state: ['running', 'paused'] } });
    const result = [];
    while (paginator.hasNext) result.push(...await paginator.nextItems());
    return result;
  }
  private async listSnapshots() {
    const paginator = this.sdk.listSnapshots(this.config());
    const result = [];
    while (paginator.hasNext) result.push(...await paginator.nextItems());
    return result;
  }
  private async client(sandbox: Sandbox) {
    await this.init();
    if (sandbox.id !== sandbox.generation || !(await this.state()).sandboxes.some(s => s.id === sandbox.id)) throw new Error('E2B sandbox is not owned by this run');
    let client = this.clients.get(sandbox.id);
    if (!client) { client = await this.sdk.connect(sandbox.id, this.config()); this.clients.set(sandbox.id, client); }
    return client;
  }
  async capabilities(): Promise<Capabilities> {
    await this.init();
    return { apiVersion: 'e2b-sdk-2.55.0', resources: [{ id: 'base' }], previews: true, managedJobs: true, jobReattachment: true,
      modes: { 'saved-workspace': { status: 'supported', reason: 'E2B persistent filesystem-only snapshot; requires project enablement, checked by the capture API' },
        'memory-fork': { status: 'supported', reason: 'Native E2B fork(count: 3) captures one filesystem and memory snapshot' },
        'filesystem-fork': { status: 'unsupported', reason: 'Native E2B forks preserve memory; use the explicit saved-workspace snapshot path for filesystem-only restores' },
        volume: { status: 'not-implemented', reason: 'Volume experiments are not implemented' },
        'warm-pool': { status: 'not-implemented', reason: 'Warm pool experiments are not implemented' } } };
  }
  async inventory(): Promise<Inventory> {
    await this.init();
    const [sandboxes, snapshots] = await Promise.all([this.listSandboxes(), this.listSnapshots()]);
    await this.json(join(this.directory, 'receipts', `inventory-${randomUUID()}.json`), { at: new Date().toISOString(), sandboxes, snapshots });
    return { sandboxes: sandboxes.map(s => ({ id: s.sandboxId, generation: s.sandboxId })), activeContainers: sandboxes.filter(s => s.state === 'running').length,
      containerLimits: null, workspaces: snapshots.map(s => ({ id: s.snapshotId })), workspaceLimits: null, workspaceUsage: null };
  }
  async create(request: Operation & { image: string; size: string }) {
    if (request.size !== 'base') throw new Error('E2B uses its base template resource configuration; select --size base');
    const sandbox = await this.mutation(request, 'create', { template: 'base', lifetimeMs }, async () => {
      const client = await this.sdk.create('base', { ...this.config(request), timeoutMs: lifetimeMs, lifecycle: { onTimeout: 'kill' },
        network: { allowPublicTraffic: false }, metadata: { repo_rodeo_run: this.runLabel, repo_rodeo_operation: request.name } });
      const owned = await this.saveSandbox(client);
      await this.json(join(this.directory, 'receipts', 'source-info.json'), await client.getInfo(this.config(request)));
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
      await client.files.write(request.path, new Uint8Array(request.bytes).buffer, { ...this.config(request), user: 'root' });
      return { uploaded: true };
    });
  }
  async execute(sandbox: Sandbox, request: Operation & { argv: string[]; cwd?: string; env?: Record<string, string> }): Promise<Execution> {
    return this.mutation(request, 'execute', { sandbox, argv: request.argv, cwd: request.cwd, env: request.env }, async () => {
      const client = await this.client(sandbox);
      try {
        const result = await client.commands.run(this.command(request.argv, request.env), { ...this.config(request), user: 'root',
          cwd: request.cwd, envs: { PATH: guestPath, ...request.env }, timeoutMs: request.timeoutMs });
        return { id: request.name, status: 'succeeded', exitCode: result.exitCode, timedOut: false, outputTruncated: false, stdout: result.stdout, stderr: result.stderr, cursor: Buffer.byteLength(result.stdout) };
      } catch (error) {
        if (!(error instanceof CommandExitError)) throw error;
        return { id: '', status: 'failed', exitCode: error.exitCode, timedOut: false, outputTruncated: false, stdout: error.stdout, stderr: error.stderr, cursor: Buffer.byteLength(error.stdout) };
      }
    });
  }
  async capture(sandbox: Sandbox, request: Operation & { mode: PreparedState['mode']; dropResponseAfterHeaders?: boolean }): Promise<PreparedState> {
    if (request.dropResponseAfterHeaders) throw new Error('E2B capture has no documented keyed replay contract');
    const value = await this.mutation(request, request.mode === 'memory-fork' ? 'fork' : 'snapshot', { sandbox, mode: request.mode }, async () => {
      const client = await this.client(sandbox);
      if (request.mode === 'memory-fork') {
        const results = await client.fork({ ...this.config(request), count: 3, timeoutMs: lifetimeMs });
        const branches: Sandbox[] = [];
        for (const result of results) if (!(result instanceof Error)) branches.push(await this.saveSandbox(result));
        const id = `fork-${sandbox.id}`;
        const state = await this.state(); state.forks[id] = branches; await this.json(this.stateFile(), state);
        return { id, preservation: 'filesystem+memory' as const, count: branches.length, attempted: results.length };
      }
      if (request.mode !== 'saved-workspace') throw new Error('Unsupported E2B capture mode');
      const snapshot = await client.createSnapshot({ ...this.config(request), name: `rodeo-${this.runLabel}`, mode: 'filesystem' });
      const state = await this.state(); state.snapshots.push(snapshot.snapshotId); await this.json(this.stateFile(), state);
      return { id: snapshot.snapshotId, preservation: 'filesystem' as const };
    });
    if ('count' in value && value.count !== 3) throw new Error(`E2B created ${value.count} of three requested forks; cleaning up the successful forks`);
    return { id: value.id, mode: request.mode, source: sandbox, preservation: value.preservation, bytes: null, receipt: await this.receipt(request) };
  }
  async spawn(prepared: PreparedState, request: Operation) {
    const sandbox = await this.mutation(request, 'spawn', { preparedId: prepared.id, mode: prepared.mode }, async () => {
      if (prepared.mode === 'memory-fork') {
        const state = await this.state();
        const branch = state.forks[prepared.id]?.shift();
        if (!branch) throw new Error('E2B fork batch has no unassigned branch');
        await this.json(this.stateFile(), state);
        return branch;
      }
      const client = await this.sdk.create(prepared.id, { ...this.config(request), timeoutMs: lifetimeMs, lifecycle: { onTimeout: 'kill' },
        network: { allowPublicTraffic: false }, metadata: { repo_rodeo_run: this.runLabel, repo_rodeo_operation: request.name } });
      return this.saveSandbox(client);
    });
    return { sandbox, receipt: await this.receipt(request) };
  }
  async preview(sandbox: Sandbox, request: Operation & { port: number }): Promise<Preview> {
    const client = await this.client(sandbox);
    if (!client.trafficAccessToken) throw new Error('E2B did not return a protected traffic token');
    const info = await client.getInfo(this.config(request));
    if (info.network?.allowPublicTraffic !== false) throw new Error('E2B preview is not protected against unauthenticated traffic');
    return { id: `preview-${sandbox.id}`, url: `https://${client.getHost(request.port)}`, expiresAt: info.endAt.toISOString(),
      headers: { 'e2b-traffic-access-token': client.trafficAccessToken } };
  }
  async revokePreview(_sandbox: Sandbox, _preview: Preview, _request: Operation) {
    // E2B port access ends when cleanup kills the sandbox. There is no separately
    // issued preview grant to revoke through the SDK.
  }
  private jobFile(id: string) { return join(this.directory, 'owned', `job-${hash(id)}.json`); }
  async startJob(sandbox: Sandbox, request: Operation & { argv: string[]; cwd?: string; env?: Record<string, string> }): Promise<Execution> {
    return this.mutation(request, 'job', { sandbox, argv: request.argv, cwd: request.cwd, env: request.env }, async () => {
      const id = randomUUID();
      const base = `/workspace/rodeo-jobs/${id}`;
      const program = `const fs=require('node:fs');const cp=require('node:child_process');const base=process.argv[1];fs.mkdirSync(require('node:path').dirname(base),{recursive:true});fs.writeFileSync(base+'.stdout','');fs.writeFileSync(base+'.stderr','');const child=cp.spawn(JSON.parse(process.argv[2])[0],JSON.parse(process.argv[2]).slice(1),{stdio:['ignore','pipe','pipe']});for(const [stream,suffix] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',b=>{fs.appendFileSync(base+'.'+suffix,b);process[suffix].write(b)});child.on('error',()=>{fs.writeFileSync(base+'.result',JSON.stringify({exitCode:127}));process.exit(127)});child.on('close',(code,signal)=>{fs.writeFileSync(base+'.result',JSON.stringify({exitCode:code??1,signal}));process.exit(code??1)});`;
      const client = await this.client(sandbox);
      const handle = await client.commands.run(this.command(['node', '-e', program, base, JSON.stringify(request.argv)], request.env), {
        ...this.config(request), background: true, user: 'root', cwd: request.cwd, envs: { PATH: guestPath, ...request.env }, timeoutMs: request.timeoutMs,
      });
      await this.json(this.jobFile(id), { sandbox, pid: handle.pid, stdout: `${base}.stdout`, stderr: `${base}.stderr`, result: `${base}.result` });
      this.handles.set(id, handle);
      return { id, status: 'running', exitCode: null, timedOut: false, outputTruncated: false, stdout: '', stderr: '', cursor: 0 };
    });
  }
  private async job(sandbox: Sandbox, id: string): Promise<Job> {
    const record: Job = JSON.parse(await readFile(this.jobFile(id), 'utf8'));
    if (record.sandbox.id !== sandbox.id || record.sandbox.generation !== sandbox.generation || !Number.isInteger(record.pid)) throw new Error('E2B job ownership journal is malformed');
    return record;
  }
  async getJob(sandbox: Sandbox, id: string): Promise<Execution> {
    const client = await this.client(sandbox); const job = await this.job(sandbox, id);
    if (!this.handles.has(id)) {
      const handle = await client.commands.connect(job.pid, { ...this.config(), timeoutMs: 30_000 });
      this.handles.set(id, handle);
      void handle.wait().catch(() => {});
    }
    const opts = { ...this.config(), user: 'root' };
    const [stdout, stderr] = await Promise.all([client.files.read(job.stdout, opts), client.files.read(job.stderr, opts)]);
    const done = await client.files.exists(job.result, opts);
    const exitCode = done ? JSON.parse(await client.files.read(job.result, opts)).exitCode as number : null;
    return { id, status: done ? exitCode === 0 ? 'succeeded' : 'failed' : 'running', exitCode,
      timedOut: false, outputTruncated: false, stdout, stderr, cursor: Buffer.byteLength(stdout) };
  }
  async readEvents(sandbox: Sandbox, id: string, cursor: number, until?: string) {
    const client = await this.client(sandbox); const job = await this.job(sandbox, id);
    let stdout = '';
    const deadline = Date.now() + 30_000;
    do {
      stdout = await client.files.read(job.stdout, { ...this.config(), user: 'root' });
      if (!until || stdout.includes(until)) break;
      if (Date.now() >= deadline) throw new Error('E2B command output did not reach the requested observation');
      await pause(100);
    } while (true);
    if (until) {
      const handle = this.handles.get(id);
      if (!handle) throw new Error('E2B command has no stream to disconnect');
      await handle.disconnect(); this.handles.delete(id);
    }
    const bytes = Buffer.from(stdout);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > bytes.length) throw new Error('Invalid E2B durable stdout cursor');
    return { text: bytes.subarray(cursor).toString(), cursor: bytes.length };
  }
  async cleanup(): Promise<CleanupResult> {
    const errors: string[] = [];
    let state: State;
    try { await this.init(false, true); state = await this.state(); }
    catch { return { confirmed: false, sandboxes: [], workspaces: [], physicalStorage: 'not-measured', errors: ['E2B cleanup credential or ownership could not be validated'] }; }
    try {
      for (const sandbox of await this.listSandboxes()) if (sandbox.metadata.repo_rodeo_run === this.runLabel && !state.sandboxes.some(s => s.id === sandbox.sandboxId))
        state.sandboxes.push({ id: sandbox.sandboxId, generation: sandbox.sandboxId });
      for (const snapshot of await this.listSnapshots()) if (snapshot.names.some(name => name.includes(`rodeo-${this.runLabel}`)) && !state.snapshots.includes(snapshot.snapshotId)) state.snapshots.push(snapshot.snapshotId);
      await this.json(this.stateFile(), state);
    } catch { errors.push('E2B resource reconciliation could not read inventory'); }
    for (const file of await readdir(join(this.directory, 'operations'))) {
      if (!file.endsWith('.json')) continue;
      try {
        const record: Journal = JSON.parse(await readFile(join(this.directory, 'operations', file), 'utf8'));
        if (!record || typeof record.kind !== 'string' || !['pending', 'complete', 'rejected', 'uncertain'].includes(record.status)) throw new Error('Malformed journal');
        if (['create', 'fork', 'snapshot', 'spawn'].includes(record.kind) && ['pending', 'uncertain'].includes(record.status))
          errors.push(`E2B operation ${record.name} remains uncertain; it was not reissued`);
      } catch { errors.push('An E2B operation journal could not be read'); }
    }
    for (const sandbox of state.sandboxes) { try { await this.sdk.kill(sandbox.id, this.config()); } catch { /* inventory below confirms absence */ } }
    for (const id of state.snapshots) { try { await this.sdk.deleteSnapshot(id, this.config()); } catch { /* inventory below confirms absence */ } }
    let inventory: Inventory | null = null;
    try { inventory = await this.inventory(); } catch { errors.push('E2B cleanup inventory could not be verified'); }
    const sandboxes = state.sandboxes.map(sandbox => ({ sandbox, absent: !!inventory && !inventory.sandboxes.some(s => s.id === sandbox.id) }));
    const workspaces = state.snapshots.map(id => ({ id, absent: !!inventory && !inventory.workspaces.some(s => s.id === id) }));
    if ([...sandboxes, ...workspaces].some(s => !s.absent)) errors.push('One or more E2B resources remain');
    return { confirmed: !!inventory && errors.length === 0, sandboxes, workspaces, physicalStorage: 'not-measured', errors };
  }
}
