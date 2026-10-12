import type { Capabilities, CleanupResult, ExperimentMode, ProviderName, WorkspaceUsage } from './providers/interface.ts';
import type { Verification } from './verifier.ts';

export interface Check {
  status: 'verified' | 'failed' | 'not-exercised' | 'unsupported';
  detail: string;
}
export interface ProviderControl {
  id: string;
  expected: 'reproduced' | 'passed';
  patchSha256: string | null;
  sourceHashes: Record<string, string>;
  verification: Verification | null;
}
// All provider commands (including unavailable adapters) emit this contract.
// Raw URLs, provider responses, commands and browser traces stay in private/.
export interface ExperimentResult {
  schemaVersion: 2;
  runId: string;
  provider: ProviderName;
  mode: ExperimentMode;
  status: 'complete' | 'failed' | 'unsupported';
  scope: 'local-api' | 'cloud-api' | 'not-run';
  startedAt: string;
  finishedAt: string;
  seed: number;
  capabilities: Capabilities | null;
  source: {
    kind: 'standalone' | 'web-checkout';
    commit: string | null;
    archiveSha256: string | null;
    inputHashes: Record<string, string>;
    integrity: boolean;
  };
  environment: {
    host: { node: string; platform: string; arch: string; playwright: string | null };
    guest: { node: string; npm: string } | null;
    requested: { image: string; size: string; cpuVcpu?: number; memoryMiB?: number; diskGB?: number };
    observedResourceLimits: null;
    model: null;
    billing: 'not-measured';
  };
  controls: ProviderControl[];
  checks: {
    filesystem: Check;
    processes: Check;
    isolation: Check;
    jobReattachment: Check;
    captureIdempotency: Check;
    previewRevocation: Check;
  };
  storage: {
    captureBytes: number | null;
    before: WorkspaceUsage | null;
    afterCapture: WorkspaceUsage | null;
    afterCleanup: WorkspaceUsage | null;
  };
  cleanup: CleanupResult | null;
  measurements: { elapsedMs: number; comparableBenchmark: false; costs: null };
  errors: string[];
  evidence: { privateDirectory: 'private'; files: Record<string, string>; publicObservations: Record<string, string> };
}

// Defense in depth for errors from browsers/OSes. The public result is assembled
// from explicit fields, never by recursively copying a provider response.
export function redact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[redacted]');
    return text.replace(/https?:\/\/[^\s"<>]+/gi, '[redacted-url]')
      .replace(/\bmb_[A-Za-z0-9_-]+/g, '[redacted-key]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]));
  }
  return value;
}
