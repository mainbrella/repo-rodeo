// Versioned runner contract. Modes describe mechanisms, not interchangeable
// performance claims. An adapter may implement only a subset of these modes.
export type ProviderName = 'mainbrella' | 'e2b' | 'daytona';
export type ExperimentMode = 'saved-workspace' | 'filesystem-fork' | 'memory-fork' | 'volume' | 'warm-pool';
export type Preservation = 'filesystem' | 'filesystem+memory';
export interface Feature {
  status: 'supported' | 'unsupported' | 'not-implemented';
  reason: string;
}
export interface Capabilities {
  modes: Record<ExperimentMode, Feature>;
  previews: boolean;
  managedJobs: boolean;
  jobReattachment: boolean;
  apiVersion: string | null;
  resources: { id: string; cpuVcpu: number; memoryMiB: number; diskGB: number }[];
}
export interface Operation {
  // Stable within a run; persist the key and exact body before network I/O.
  name: string;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface Sandbox { id: string; generation: string }
export interface Receipt {
  operationId: string;
  requestedAt: string;
  completedAt: string;
  rawEvidencePath: string;
}
export interface PreparedState {
  id: string;
  mode: ExperimentMode;
  preservation: Preservation;
  source: Sandbox;
  bytes: number | null;
  receipt: Receipt;
}
export interface ProcessProbe {
  nonce: string | null;
  pid: number | null;
  serverReachable: boolean;
  observedAt: string;
}
export interface Execution {
  id: string;
  status: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  stdout: string;
  stderr: string;
  cursor: number;
}
export interface Preview { id: string; url: string; expiresAt: string | null }
export interface WorkspaceUsage {
  saved: number;
  reservedBytes: number;
  savesThisMonth: number;
  captureBytesThisMonth: number;
  retainedCaptureBytes: number;
}
export interface Inventory {
  sandboxes: Sandbox[];
  activeContainers: number;
  containerLimits: { maxContainers: number } | null;
  workspaces: { id: string }[];
  workspaceUsage: WorkspaceUsage;
  workspaceLimits: {
    maxSaved: number; maxReservedBytes: number; maxSavesPerMonth: number;
    maxCaptureBytesPerMonth: number; maxRetainedCaptureBytes: number;
  } | null;
}
export interface CleanupResult {
  confirmed: boolean;
  sandboxes: { sandbox: Sandbox; absent: boolean }[];
  workspaces: { id: string; absent: boolean }[];
  physicalStorage: 'not-measured';
  errors: string[];
}
export interface ProviderAdapter {
  readonly name: ProviderName;
  capabilities(): Promise<Capabilities>;
  inventory(): Promise<Inventory>;
  create(request: Operation & { image: string; size: string }): Promise<{ sandbox: Sandbox; receipt: Receipt }>;
  upload(sandbox: Sandbox, request: Operation & { path: string; bytes: Buffer }): Promise<void>;
  execute(sandbox: Sandbox, request: Operation & { argv: string[]; cwd?: string; env?: Record<string, string> }): Promise<Execution>;
  startJob(sandbox: Sandbox, request: Operation & { argv: string[]; cwd?: string; env?: Record<string, string> }): Promise<Execution>;
  getJob(sandbox: Sandbox, id: string): Promise<Execution>;
  readEvents(sandbox: Sandbox, id: string, cursor: number, until?: string): Promise<{ text: string; cursor: number }>;
  capture(sandbox: Sandbox, request: Operation & { mode: ExperimentMode; dropResponseAfterHeaders?: boolean }): Promise<PreparedState>;
  spawn(prepared: PreparedState, request: Operation): Promise<{ sandbox: Sandbox; receipt: Receipt }>;
  preview(sandbox: Sandbox, request: Operation & { port: number }): Promise<Preview>;
  revokePreview(sandbox: Sandbox, preview: Preview, request: Operation): Promise<void>;
  cleanup(): Promise<CleanupResult>;
}
