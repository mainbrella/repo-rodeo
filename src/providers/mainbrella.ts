import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, chmod, rename, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  Capabilities, CleanupResult, Execution, ExperimentMode, Inventory, Operation,
  PreparedState, Preview, ProviderAdapter, Receipt, Sandbox, WorkspaceUsage,
} from './interface.ts';

type Options = { apiUrl: string; apiKey: string; directory: string; fetch?: typeof globalThis.fetch; pollIntervalMs?: number };
type Journal = {
  name: string; method: string; path: string; body?: unknown; bodyText?: string; bodyHash: string; key: string;
  createdAt: string; retentionMs: number; attempts: number; attemptEvidence?: { at: string; status?: number; responseBody?: string; error?: string }[]; responseStatus?: number;
  responseAt?: string; responseBody?: string; responseLostAfterHeaders?: boolean;
  rejected?: boolean; error?: string; upload?: { file: string; size: number; sha256: string };
};
const CREATE_RETENTION = 24 * 60 * 60 * 1000;
const JOB_RETENTION = 60 * 60 * 1000;
const TERMINAL = new Set(['succeeded', 'completed', 'failed', 'cancelled', 'canceled', 'timed_out', 'timeout', 'output_limit', 'interrupted']);
const json = (value: unknown) => JSON.stringify(value);
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const safeError = (message: string) => new Error(message);
function nonnegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw safeError(`Mainbrella returned an invalid ${label}`);
  return value;
}
function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function expectedRetention(method: string, path: string): number {
  return method === 'POST' && /^\/containers\/executions\?/.test(path) ? JOB_RETENTION : CREATE_RETENTION;
}

export class MainbrellaAdapter implements ProviderAdapter {
  readonly name = 'mainbrella' as const;
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly directory: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly pollIntervalMs: number;
  private readonly opsDir: string;
  private readonly bytesDir: string;
  private readonly ownedDir: string;
  private readonly receiptsDir: string;

  constructor(options: Options) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.directory = resolve(options.directory);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.opsDir = join(this.directory, 'operations');
    this.bytesDir = join(this.directory, 'uploads');
    this.ownedDir = join(this.directory, 'owned');
    this.receiptsDir = join(this.directory, 'receipts');
  }

  private async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await Promise.all([this.opsDir, this.bytesDir, this.ownedDir, this.receiptsDir].map(async p => {
      await mkdir(p, { recursive: true, mode: 0o700 }); await chmod(p, 0o700);
    }));
  }
  private opFile(name: string) { return join(this.opsDir, `${hash(name).slice(0, 32)}.json`); }
  private ownedFile(kind: string, id: string) { return join(this.ownedDir, `${kind}-${hash(id).slice(0, 32)}.json`); }
  private async saveOwned(kind: string, identity: object, id: string) {
    await writeFile(this.ownedFile(kind, id), json(identity) + '\n', { mode: 0o600 });
    await chmod(this.ownedFile(kind, id), 0o600);
  }
  private async records(): Promise<Journal[]> {
    await this.init();
    const files = await readdir(this.opsDir);
    const result: Journal[] = [];
    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const record = JSON.parse(await readFile(join(this.opsDir, file), 'utf8')) as Journal;
        await this.validateRecord(record, true);
        result.push(record);
      }
      catch { throw safeError('Mainbrella operation journal is unreadable; refusing recovery without its saved identity'); }
    }
    return result;
  }
  private async putRecord(record: Journal) {
    const file = this.opFile(record.name);
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(json(record) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
    await chmod(file, 0o600);
  }
  private async validateRecord(value: unknown, checkUploadFile: boolean): Promise<Journal> {
    const r = value as Journal;
    if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !r.name ||
        typeof r.method !== 'string' || typeof r.path !== 'string' || !r.path.startsWith('/') ||
        typeof r.key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.key) ||
        !validTimestamp(r.createdAt) || !Number.isSafeInteger(r.retentionMs) || r.retentionMs !== expectedRetention(r.method, r.path) ||
        !Number.isSafeInteger(r.attempts) || r.attempts < 0 || !/^[a-f0-9]{64}$/.test(r.bodyHash))
      throw safeError('Mainbrella operation journal has invalid identity or retention metadata');
    const hasUpload = r.upload !== undefined;
    if (hasUpload) {
      const upload = r.upload!;
      const expectedPrefix = `${this.bytesDir}/`;
      if (!upload || typeof upload.file !== 'string' || !resolve(upload.file).startsWith(expectedPrefix) ||
          !Number.isSafeInteger(upload.size) || upload.size < 0 || !/^[a-f0-9]{64}$/.test(upload.sha256) || upload.sha256 !== r.bodyHash ||
          r.body !== undefined || r.bodyText !== undefined)
        throw safeError('Mainbrella operation journal has invalid upload fingerprint metadata');
      if (checkUploadFile) {
        try {
          const bytes = await readFile(upload.file);
          if (bytes.length !== upload.size || hash(bytes) !== upload.sha256) throw safeError('Mainbrella saved upload bytes failed integrity validation');
        } catch { throw safeError('Mainbrella saved upload bytes are missing or unreadable'); }
      }
    } else {
      const bodyText = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : json(r.body);
      if (typeof r.bodyText !== 'string' || r.bodyText !== bodyText || hash(bodyText) !== r.bodyHash)
        throw safeError('Mainbrella operation journal request body failed integrity validation');
    }
    return r;
  }
  private async prepare(op: Operation, method: string, path: string, body?: unknown, retentionMs = CREATE_RETENTION, upload?: Journal['upload'], enforceRetention = true) {
    await this.init();
    const bodyText = body === undefined ? '' : Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : json(body);
    const bodyHash = hash(bodyText);
    if (retentionMs !== expectedRetention(method, path)) throw safeError(`operation ${op.name} has an invalid retention policy`);
    const file = this.opFile(op.name);
    let rec: Journal;
    let created = false;
    try { rec = JSON.parse(await readFile(file, 'utf8')) as Journal; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw safeError(`operation ${op.name} journal is unreadable; refusing to make a new key`);
      created = true;
      rec = { name: op.name, method, path, ...(body === undefined || Buffer.isBuffer(body) ? {} : { body }),
        ...(!Buffer.isBuffer(body) ? { bodyText: bodyText as string } : {}), bodyHash,
        key: randomUUID(), createdAt: new Date().toISOString(), retentionMs, attempts: 0, attemptEvidence: [], ...(upload ? { upload } : {}) };
      await this.putRecord(rec); // durable before any network call
    }
    await this.validateRecord(rec, !created && upload !== undefined);
    if (rec.name !== op.name || rec.method !== method || rec.path !== path || rec.bodyHash !== bodyHash ||
        (upload && (rec.upload?.sha256 !== upload.sha256 || rec.upload.size !== upload.size)))
      throw safeError(`operation ${op.name} was already recorded with different request data`);
    if (enforceRetention && Date.now() - Date.parse(rec.createdAt) >= rec.retentionMs)
      throw safeError(`operation ${op.name} is outside its idempotency retention window`);
    return rec;
  }
  private async request(op: Operation, method: string, path: string, body?: unknown, cfg: {
    keyed?: boolean; retry?: boolean; retentionMs?: number; headers?: Record<string, string>;
    raw?: boolean; dropResponseAfterHeaders?: boolean; upload?: Journal['upload'];
  } = {}): Promise<{ data: any; response: Response }> {
    const keyed = cfg.keyed ?? false;
    const rec = await this.prepare(op, method, path, body, cfg.retentionMs ?? (method === 'POST' && path.includes('/executions') ? JOB_RETENTION : CREATE_RETENTION), cfg.upload, keyed);
    const maxAttempts = cfg.retry ? 3 : 1;
    let dropPending = cfg.dropResponseAfterHeaders === true && rec.responseLostAfterHeaders !== true;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, ...(cfg.headers ?? {}) };
      let requestBody: BodyInit | undefined;
      if (body !== undefined) {
        if (Buffer.isBuffer(body)) {
          requestBody = new Uint8Array(body);
          headers['content-type'] ??= 'application/octet-stream';
          headers['content-length'] ??= String(body.length);
        }
        else { headers['content-type'] ??= 'application/json'; requestBody = rec.bodyText ?? (typeof body === 'string' ? body : json(body)); }
      }
      if (keyed) headers['Idempotency-Key'] = rec.key;
      rec.attempts++; rec.attemptEvidence ??= []; rec.attemptEvidence.push({ at: new Date().toISOString() }); await this.putRecord(rec);
      let response: Response;
      try {
        response = await this.fetcher(`${this.apiUrl}${path}`, {
          method, headers, body: requestBody, redirect: 'error',
          signal: op.signal ? AbortSignal.any([op.signal, AbortSignal.timeout(op.timeoutMs)]) : AbortSignal.timeout(op.timeoutMs),
        });
      } catch {
        rec.error = 'transport-error'; rec.attemptEvidence.at(-1)!.error = 'transport-error'; await this.putRecord(rec);
        if (cfg.retry && attempt + 1 < maxAttempts) continue;
        throw safeError(`Mainbrella ${method} request failed`);
      }
      {
        rec.responseStatus = response.status;
        rec.responseAt = new Date().toISOString();
        rec.attemptEvidence!.at(-1)!.status = response.status;
        if (dropPending && response.ok) rec.responseLostAfterHeaders = true;
        // Persist admission evidence before consuming the body.
        await this.putRecord(rec);
      }
      if (dropPending && response.ok) {
        dropPending = false;
        if (rec) { rec.responseLostAfterHeaders = true; rec.error = 'body-discarded-after-success-headers'; await this.putRecord(rec); }
        await response.body?.cancel().catch(() => {});
        if (attempt + 1 < maxAttempts) continue;
        throw safeError('MainBrella response body intentionally discarded after successful headers');
      }
      let text = '';
      try { text = await response.text(); } catch {
        rec.responseLostAfterHeaders = response.ok; rec.error = 'response-body-read-error'; rec.attemptEvidence!.at(-1)!.error = 'response-body-read-error'; await this.putRecord(rec);
        if (cfg.retry && attempt + 1 < maxAttempts) continue;
        throw safeError(`Mainbrella ${method} response could not be read`);
      }
      rec.responseBody = text; rec.attemptEvidence!.at(-1)!.responseBody = text;
      rec.error = response.status >= 500 && cfg.retry && attempt + 1 < maxAttempts ? 'server-5xx-retry' : undefined;
      rec.rejected = !response.ok && response.status < 500; await this.putRecord(rec);
      let data: any;
      try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
      if (!response.ok) {
        if (response.status >= 500 && cfg.retry && attempt + 1 < maxAttempts) continue;
        throw safeError(`Mainbrella request failed with HTTP ${response.status}`);
      }
      return { data, response };
    }
    throw safeError('Mainbrella request failed');
  }
  private q(sandbox: Sandbox, extra: Record<string, string> = {}) {
    const q = new URLSearchParams({ id: sandbox.id, createdAt: sandbox.generation, ...extra }); return `?${q}`;
  }
  private async receipt(op: Operation, data: unknown): Promise<Receipt> {
    const file = join(this.receiptsDir, `${randomUUID()}.json`);
    const completedAt = new Date().toISOString();
    await writeFile(file, json({ operationId: op.name, completedAt, response: data }) + '\n', { mode: 0o600 });
    await chmod(file, 0o600);
    const rec = (await this.records()).find(r => r.name === op.name);
    return { operationId: op.name, requestedAt: rec?.createdAt ?? completedAt, completedAt, rawEvidencePath: file };
  }

  async capabilities(): Promise<Capabilities> {
    const { data } = await this.request({ name: 'capabilities', timeoutMs: 10000 }, 'GET', '/capabilities');
    const p = data.persistence ?? {};
    if (!Array.isArray(data.resources)) throw safeError('Mainbrella capability resources are missing or malformed');
    const resources = data.resources.map((r: any) => {
      if (!r || typeof r.id !== 'string' || !r.id) throw safeError('Mainbrella capability resource identity is malformed');
      const cpuVcpu = nonnegative(r.cpuVcpu, 'resource CPU');
      const memoryMiB = nonnegative(r.memoryMiB, 'resource memory');
      const diskGB = nonnegative(r.diskGB, 'resource disk');
      if (cpuVcpu === 0 || memoryMiB === 0 || diskGB === 0) throw safeError('Mainbrella capability resource measurements must be positive');
      return { id: r.id, cpuVcpu, memoryMiB, diskGB };
    });
    const modes: Capabilities['modes'] = {
      'saved-workspace': { status: p.snapshots === true && p.workspaces === true ? 'supported' : 'unsupported', reason: 'requires snapshots and workspaces capabilities' },
      'filesystem-fork': { status: p.filesystemFork ? 'not-implemented' : 'unsupported', reason: p.filesystemFork ? 'advertised by provider; adapter implementation pending' : 'provider does not advertise filesystem fork' },
      'memory-fork': { status: p.memory ? 'not-implemented' : 'unsupported', reason: p.memory ? 'advertised by provider; adapter implementation pending' : 'provider does not advertise memory preservation' },
      volume: { status: p.volumes ? 'not-implemented' : 'unsupported', reason: 'volume lifecycle is not implemented by this adapter' },
      'warm-pool': { status: data.pools?.managed ? 'not-implemented' : 'unsupported', reason: 'managed pool lifecycle is not implemented by this adapter' },
    };
    return { modes, previews: data.previews?.supported === true, managedJobs: data.execution?.background === true,
      jobReattachment: data.execution?.reconnect === true, apiVersion: typeof data.apiVersion === 'string' ? data.apiVersion : null,
      resources };
  }
  async inventory(): Promise<Inventory> {
    const [containers, workspaces] = await Promise.all([
      this.request({ name: 'inventory-containers', timeoutMs: 15000 }, 'GET', '/containers'),
      this.request({ name: 'inventory-workspaces', timeoutMs: 15000 }, 'GET', '/workspaces'),
    ]);
    if (!Array.isArray(containers.data.containers) || !Array.isArray(workspaces.data.workspaces) || !workspaces.data.usage)
      throw safeError('Mainbrella inventory response is incomplete');
    let activeContainers = 0;
    const sandboxes: Sandbox[] = containers.data.containers.map((x: any) => {
      if (!x || typeof x.id !== 'string' || typeof x.createdAt !== 'string' || !['starting', 'running', 'stopped'].includes(x.status))
        throw safeError('Mainbrella container inventory identity is malformed');
      if (x.status === 'starting' || x.status === 'running') activeContainers++;
      return { id: x.id, generation: x.createdAt };
    });
    const workspacesList = workspaces.data.workspaces;
    const u = workspaces.data.usage;
    const usage: WorkspaceUsage = { saved: nonnegative(u.saved, 'workspace usage.saved'), reservedBytes: nonnegative(u.reservedBytes, 'workspace usage.reservedBytes'),
      savesThisMonth: nonnegative(u.savesThisMonth, 'workspace usage.savesThisMonth'), captureBytesThisMonth: nonnegative(u.captureBytesThisMonth, 'workspace usage.captureBytesThisMonth'),
      retainedCaptureBytes: nonnegative(u.retainedCaptureBytes, 'workspace usage.retainedCaptureBytes') };
    const l = workspaces.data.limits;
    const workspaceLimits = l == null ? null : { maxSaved: nonnegative(l.maxSaved, 'workspace limit maxSaved'),
      maxReservedBytes: nonnegative(l.maxReservedBytes, 'workspace limit maxReservedBytes'), maxSavesPerMonth: nonnegative(l.maxSavesPerMonth, 'workspace limit maxSavesPerMonth'),
      maxCaptureBytesPerMonth: nonnegative(l.maxCaptureBytesPerMonth, 'workspace limit maxCaptureBytesPerMonth'),
      maxRetainedCaptureBytes: nonnegative(l.maxRetainedCaptureBytes, 'workspace limit maxRetainedCaptureBytes') };
    const limits = containers.data.limits ?? {};
    return { sandboxes, activeContainers,
      containerLimits: limits.maxContainers == null ? null : { maxContainers: nonnegative(limits.maxContainers, 'container limit maxContainers') },
      workspaces: workspacesList.map((x: any) => {
        if (!x || typeof x.id !== 'string') throw safeError('Mainbrella workspace inventory identity is malformed');
        return { id: x.id };
      }), workspaceUsage: usage, workspaceLimits };
  }
  async create(request: Operation & { image: string; size: string }): Promise<{ sandbox: Sandbox; receipt: Receipt }> {
    const body = { catalogId: request.image, size: request.size };
    const { data: first } = await this.request(request, 'POST', '/containers', body, { keyed: true, retry: true });
    const { sandbox, data } = await this.pollCreation(request, body, first);
    return { sandbox, receipt: await this.receipt(request, data) };
  }
  private async pollCreation(op: Operation, body: unknown, initial: any): Promise<{ sandbox: Sandbox; data: any }> {
    const deadline = Date.now() + Math.min(op.timeoutMs, 30000);
    let data = initial;
    while (Date.now() < deadline) {
      const creation = data.creation ?? {};
      if (creation.containerId && creation.createdAt) {
        const sandbox = { id: String(creation.containerId), generation: String(creation.createdAt) };
        await this.saveOwned('sandbox', sandbox, `${sandbox.id}\0${sandbox.generation}`);
        const matching = (data.containers ?? []).find((x: any) => x.id === sandbox.id && x.createdAt === sandbox.generation);
        if (creation.status === 'running' && matching?.status === 'running') return { sandbox, data };
      }
      if (op.signal?.aborted) throw safeError('Mainbrella creation was cancelled');
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs || 250));
      const replay = await this.request(op, 'POST', '/containers', body, { keyed: true, retry: true });
      data = replay.data;
    }
    throw safeError('Mainbrella creation readiness timed out');
  }
  async upload(sandbox: Sandbox, request: Operation & { path: string; bytes: Buffer }): Promise<void> {
    const digest = hash(request.bytes); const file = join(this.bytesDir, `${hash(request.name).slice(0, 32)}.bin`);
    const path = `/containers/files/transfer${this.q(sandbox, { path: request.path, size: String(request.bytes.length) })}`;
    await this.prepare(request, 'PUT', path, request.bytes, CREATE_RETENTION, { file, size: request.bytes.length, sha256: digest }, false);
    await this.init(); await writeFile(file, request.bytes, { mode: 0o600 }); await chmod(file, 0o600);
    await this.request(request, 'PUT', path, request.bytes, { upload: { file, size: request.bytes.length, sha256: digest } });
  }
  private async submitJob(sandbox: Sandbox, request: Operation & { argv: string[]; cwd?: string; env?: Record<string, string> }) {
    const body = { argv: request.argv, ...(request.cwd ? { cwd: request.cwd } : {}), ...(request.env ? { env: request.env } : {}), timeoutMs: request.timeoutMs };
    const { data } = await this.request(request, 'POST', `/containers/executions${this.q(sandbox)}`, body,
      { keyed: true, retry: true, retentionMs: JOB_RETENTION });
    const e = data.execution ?? data;
    if (!e.id) throw safeError('Mainbrella did not return a managed execution ID');
    await this.saveOwned('job', { sandbox, id: String(e.id) }, String(e.id));
    return this.execution(e);
  }
  async execute(sandbox: Sandbox, request: Operation & { argv: string[]; cwd?: string; env?: Record<string, string> }): Promise<Execution> {
    const started = await this.submitJob(sandbox, request);
    return this.waitJob(sandbox, started.id, request);
  }
  async startJob(sandbox: Sandbox, request: Operation & { argv: string[]; cwd?: string; env?: Record<string, string> }): Promise<Execution> { return this.submitJob(sandbox, request); }
  async getJob(sandbox: Sandbox, id: string): Promise<Execution> {
    const { data } = await this.request({ name: `job-poll-${id}`, timeoutMs: 30000 }, 'GET', `/containers/executions/${encodeURIComponent(id)}${this.q(sandbox)}`);
    return this.execution(data.execution ?? data);
  }
  private execution(e: any): Execution {
    return { id: String(e.id), status: String(e.status), exitCode: e.exitCode == null ? null : Number(e.exitCode),
      timedOut: e.timedOut === true || ['timed_out', 'timeout'].includes(e.status), outputTruncated: e.outputTruncated === true,
      stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), cursor: Number(e.cursor ?? 0) };
  }
  private async waitJob(sandbox: Sandbox, id: string, op: Operation): Promise<Execution> {
    const end = Date.now() + Math.min(op.timeoutMs + 30000, 960000);
    while (Date.now() < end) {
      if (op.signal?.aborted) throw safeError('Mainbrella managed execution wait was cancelled');
      const result = await this.getJob(sandbox, id);
      if (TERMINAL.has(result.status)) return result;
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }
    throw safeError('Mainbrella managed execution polling timed out');
  }
  async readEvents(sandbox: Sandbox, id: string, cursor: number, until?: string): Promise<{ text: string; cursor: number }> {
    const path = `/containers/executions/${encodeURIComponent(id)}/events${this.q(sandbox, { cursor: String(cursor) })}`;
    const op = { name: `events-${id}-${cursor}`, timeoutMs: 30000 };
    const rec = await this.prepare(op, 'GET', path);
    rec.attempts++; rec.attemptEvidence ??= []; rec.attemptEvidence.push({ at: new Date().toISOString() }); await this.putRecord(rec);
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiUrl}${path}`, { headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'text/event-stream' },
        redirect: 'error', signal: AbortSignal.timeout(op.timeoutMs) });
    } catch {
      rec.error = 'transport-error'; rec.attemptEvidence.at(-1)!.error = 'transport-error'; await this.putRecord(rec);
      throw safeError('Mainbrella event stream request failed');
    }
    rec.responseStatus = response.status; rec.responseAt = new Date().toISOString(); rec.attemptEvidence.at(-1)!.status = response.status; await this.putRecord(rec);
    if (!response.ok || !response.body) throw safeError(`Mainbrella event stream failed with HTTP ${response.status}`);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ''; let max = cursor;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        const chunk = decoder.decode(value, { stream: true }); text += chunk;
        const events = text.split(/\r?\n\r?\n/);
        for (const event of events.slice(0, -1)) {
          const match = event.match(/(?:^|\r?\n)id:\s*(\d+)(?:\r?\n|$)/);
          if (match) max = Math.max(max, Number(match[1]));
        }
        if (until && text.includes(until)) break;
      }
    } catch {
      rec.error = 'event-stream-read-error'; rec.attemptEvidence.at(-1)!.error = 'event-stream-read-error'; await this.putRecord(rec);
      throw safeError('Mainbrella event stream ended before the requested read completed');
    } finally { await reader.cancel().catch(() => {}); }
    rec.responseBody = text; rec.attemptEvidence.at(-1)!.responseBody = text; rec.error = undefined; await this.putRecord(rec);
    return { text, cursor: max };
  }
  async capture(sandbox: Sandbox, request: Operation & { mode: ExperimentMode; dropResponseAfterHeaders?: boolean }): Promise<PreparedState> {
    if (request.mode !== 'saved-workspace') throw safeError('Mainbrella adapter only implements saved-workspace capture');
    const body = { id: sandbox.id, createdAt: sandbox.generation, name: request.name, stop: false };
    const { data } = await this.request(request, 'POST', '/workspaces', body, { keyed: true, retry: true, dropResponseAfterHeaders: request.dropResponseAfterHeaders });
    const w = data.workspace ?? data;
    if (!w.id) throw safeError('Mainbrella capture response did not include a workspace ID');
    await this.saveOwned('workspace', { id: String(w.id), source: sandbox }, String(w.id));
    const receipt = await this.receipt(request, data);
    return { id: String(w.id), mode: request.mode, preservation: 'filesystem', source: sandbox, bytes: w.bytes == null ? null : Number(w.bytes), receipt };
  }
  async spawn(prepared: PreparedState, request: Operation): Promise<{ sandbox: Sandbox; receipt: Receipt }> {
    const body = { workspaceId: prepared.id };
    const { data: first } = await this.request(request, 'POST', '/containers', body, { keyed: true, retry: true });
    const { sandbox, data } = await this.pollCreation(request, body, first);
    return { sandbox, receipt: await this.receipt(request, data) };
  }
  async preview(sandbox: Sandbox, request: Operation & { port: number }): Promise<Preview> {
    const path = `/containers/previews${this.q(sandbox)}`;
    const body = { port: request.port, ttlSeconds: 3600 };
    const existing = await this.prepare(request, 'POST', path, body, CREATE_RETENTION, undefined, false);
    if (existing.attempts > 0) throw safeError(`preview operation ${request.name} was already attempted; issue a new operation only after reconciliation`);
    const { data } = await this.request(request, 'POST', path, body);
    const p = data.preview ?? data;
    if (!p.id || !p.url) throw safeError('Mainbrella preview response was incomplete');
    await this.saveOwned('preview', { sandbox, id: String(p.id), url: String(p.url), expiresAt: p.expiresAt ?? null }, String(p.id));
    return { id: String(p.id), url: String(p.url), expiresAt: p.expiresAt == null ? null : new Date(Number(p.expiresAt)).toISOString() };
  }
  async revokePreview(sandbox: Sandbox, preview: Preview, request: Operation): Promise<void> {
    const path = `/containers/previews${this.q(sandbox, { previewId: preview.id })}`;
    await this.request(request, 'DELETE', path);
  }

  async cleanup(): Promise<CleanupResult> {
    await this.init();
    const sandboxes = new Map<string, Sandbox>();
    const workspaces = new Set<string>();
    const previews: { sandbox: Sandbox; id: string }[] = [];
    const errors: string[] = [];
    const workspaceDeleteFailures = new Set<string>();
    const records: Journal[] = [];
    for (const file of await readdir(this.opsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const record = JSON.parse(await readFile(join(this.opsDir, file), 'utf8')) as Journal;
        await this.validateRecord(record, true);
        records.push(record);
      }
      catch { errors.push('An operation journal could not be read; its resource identity remains unresolved.'); }
    }
    const addSandbox = (x: any) => {
      const id = x?.creation?.containerId ?? x?.containerId ?? x?.sandbox?.id ?? x?.id;
      const generation = x?.creation?.createdAt ?? x?.createdAt ?? x?.sandbox?.generation ?? x?.generation;
      if (typeof id === 'string' && typeof generation === 'string') sandboxes.set(`${id}\0${generation}`, { id, generation });
    };
    for (const file of await readdir(this.ownedDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const value = JSON.parse(await readFile(join(this.ownedDir, file), 'utf8'));
        if (file.startsWith('sandbox-')) addSandbox(value);
        if (file.startsWith('workspace-') && typeof value.id === 'string') workspaces.add(value.id);
        if (file.startsWith('preview-') && value.sandbox && value.id) previews.push(value);
      } catch { errors.push('An ownership journal could not be read.'); }
    }
    for (const rec of records) {
      if (rec.method !== 'POST' || !rec.key || !['/containers', '/workspaces'].includes(rec.path)) continue;
      let data: any;
      if (rec.responseBody) { try { data = JSON.parse(rec.responseBody); } catch { /* retain and reconcile */ } }
      const isCreation = rec.path === '/containers';
      const identity = (value: any) => isCreation
        ? Boolean(value?.creation?.containerId && value?.creation?.createdAt)
        : Boolean(value?.workspace?.id ?? value?.id);
      if (!identity(data)) {
        for (const attempt of [...(rec.attemptEvidence ?? [])].reverse()) {
          if (!attempt.responseBody) continue;
          try {
            const earlier = JSON.parse(attempt.responseBody);
            if (identity(earlier)) { data = earlier; break; }
          } catch { /* inspect older immutable attempt evidence */ }
        }
      }
      const startStatus = isCreation ? data?.creation?.status : undefined;
      const historicalUncertainty = rec.responseLostAfterHeaders === true || (rec.attemptEvidence ?? []).some(a =>
        (a.status != null && a.status >= 200 && a.status < 300 && !a.responseBody) || (!a.status && a.error === 'transport-error'));
      const shouldReplay = !rec.responseBody || (rec.responseStatus ?? 0) >= 500 || rec.responseStatus === 409 ||
        ((rec.responseStatus ?? 0) >= 200 && (rec.responseStatus ?? 0) < 300 && (!identity(data) || startStatus === 'starting')) ||
        (isCreation && startStatus === 'starting') || (!identity(data) && historicalUncertainty);
      if (shouldReplay && (!rec.rejected || rec.responseStatus === 409 || historicalUncertainty || (isCreation && startStatus === 'starting'))) {
        if (Date.now() - Date.parse(rec.createdAt) >= rec.retentionMs) {
          errors.push(`Operation ${rec.name} is unresolved beyond its provider idempotency window.`);
        } else {
          const deadline = Date.now() + 30000;
          do {
            try {
              const replay = await this.request({ name: rec.name, timeoutMs: 30000 }, rec.method, rec.path, rec.body,
                { keyed: true, retry: true, retentionMs: rec.retentionMs });
              data = replay.data;
            } catch { errors.push(`Could not reconcile operation ${rec.name}.`); break; }
            if (identity(data) && !(isCreation && data?.creation?.status === 'starting')) break;
            if (Date.now() >= deadline) { errors.push(`Operation ${rec.name} returned no resolved resource identity.`); break; }
            await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs || 250));
          } while (Date.now() < deadline);
        }
      } else if (shouldReplay && rec.rejected && rec.responseStatus !== 409) {
        // A definite validation/quota rejection did not admit a resource.
        continue;
      }
      if (rec.path === '/containers' && data) addSandbox(data);
      if (rec.path === '/workspaces' && data) {
        const id = data.workspace?.id ?? data.id;
        if (typeof id === 'string') workspaces.add(id);
      }
      if ((rec.responseStatus ?? 0) >= 200 && (rec.responseStatus ?? 0) < 300 && !identity(data))
        errors.push(`Successful operation ${rec.name} has no recoverable resource identity.`);
    }
    for (const p of previews) {
      try { await this.request({ name: `cleanup-preview-${p.id}`, timeoutMs: 20000 }, 'DELETE',
        `/containers/previews${this.q(p.sandbox, { previewId: p.id })}`); } catch { /* deletion of the generation revokes its grants */ }
    }
    for (const id of workspaces) {
      try { await this.request({ name: `cleanup-workspace-${id}`, timeoutMs: 30000 }, 'DELETE', `/workspaces/${encodeURIComponent(id)}`); }
      catch { workspaceDeleteFailures.add(id); }
    }
    for (const sandbox of sandboxes.values()) {
      try { await this.request({ name: `cleanup-sandbox-${hash(`${sandbox.id}\0${sandbox.generation}`).slice(0, 20)}`, timeoutMs: 30000 }, 'DELETE', `/containers${this.q(sandbox)}`); }
      catch { /* exact inventory below decides whether it is already absent */ }
    }
    let after: Inventory | null = null;
    try { after = await this.inventory(); } catch { errors.push('Could not verify cleanup against provider inventory.'); }
    const sandboxResults = [...sandboxes.values()].map(sandbox => ({ sandbox,
      absent: after ? !after.sandboxes.some(x => x.id === sandbox.id && x.generation === sandbox.generation) : false }));
    const workspaceResults = [...workspaces].map(id => ({ id, absent: after ? !after.workspaces.some(x => x.id === id) : false }));
    if (sandboxResults.some(x => !x.absent)) errors.push('One or more owned container generations remain in inventory.');
    if (workspaceResults.some(x => !x.absent && workspaceDeleteFailures.has(x.id))) errors.push('One or more owned workspaces remain in inventory.');
    return { confirmed: !!after && errors.length === 0 && sandboxResults.every(x => x.absent) && workspaceResults.every(x => x.absent),
      sandboxes: sandboxResults, workspaces: workspaceResults, physicalStorage: 'not-measured', errors };
  }
}
