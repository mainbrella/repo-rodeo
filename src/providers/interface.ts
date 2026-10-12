// Contract for the next milestone. No cloud adapter is implemented or qualified
// by the local experiment. Report observed semantics rather than a shared pass flag.
export type Preservation = 'filesystem' | 'filesystem+memory';

export interface Operation {
  // Persist before making the request; retries of uncertain responses must reuse it.
  idempotencyKey: string;
  timeoutMs: number;
}
export interface Sandbox {
  id: string;
  generation: string;
}
export interface Receipt {
  operationId: string;
  requestedAt: string;
  completedAt: string;
  rawEvidencePath: string;
}
export interface PreparedState {
  id: string;
  preservation: Preservation;
  source: Sandbox;
  receipt: Receipt;
}
export interface ProcessProbe {
  nonce: string | null;
  pid: number | null;
  serverReachable: boolean;
  observedAt: string;
}
export interface ProviderAdapter {
  readonly name: 'e2b' | 'daytona' | 'mainbrella';
  capabilities(): Promise<{
    captureModes: { mode: Preservation; requiresStop: boolean; sandboxClass: string }[];
    filesystemFork: boolean;
    resumePreservation: Preservation | 'unsupported';
    evidencePath: string;
  }>;
  create(request: Operation & {
    sourceCommit: string;
    image: string;
    region: string;
    resources: { cpu: number; memoryMiB: number; diskGiB: number };
    lifetimeMs: number;
  }): Promise<{ sandbox: Sandbox; receipt: Receipt }>;
  execute(sandbox: Sandbox, request: Operation & {
    executable: string; args: string[]; cwd: string;
  }): Promise<{
    exitCode: number | null; stdoutPath: string; stderrPath: string; receipt: Receipt;
  }>;
  capture(sandbox: Sandbox, request: Operation & { mode: Preservation }): Promise<PreparedState>;
  spawn(prepared: PreparedState, request: Operation & { lifetimeMs: number }): Promise<{ sandbox: Sandbox; receipt: Receipt }>;
  preview(sandbox: Sandbox, request: Operation & { port: number }): Promise<{ url: string; expiresAt: string | null; receipt: Receipt }>;
  stop(sandbox: Sandbox, request: Operation): Promise<{ preservation: Preservation; receipt: Receipt }>;
  resume(sandbox: Sandbox, request: Operation): Promise<{ sandbox: Sandbox; receipt: Receipt }>;
  destroy(sandbox: Sandbox, request: Operation): Promise<{ confirmed: boolean; receipt: Receipt }>;
}
