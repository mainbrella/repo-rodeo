import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export interface WorkerJob { id: string; quantity: number; unitCents: number }
export interface WorkerOutput { id: string; totalCents: number }
export interface WorkerProbe {
  nonce: string; pid: number; node: string; preparationId: string | null;
  phase: string; pending: number; outputCount: number; marker: string | null;
  inputFingerprint: string | null; stateFingerprint: string;
}
export interface WorkerResponse extends WorkerProbe { claimedCompleted: boolean; outputs: WorkerOutput[] }
export interface WorkerLedger { preparationId: string; jobs: WorkerJob[]; expected: WorkerOutput[]; fingerprint: string }
export function makeWorkerLedger(seed: number, preparationId: string): WorkerLedger {
  const jobs: WorkerJob[] = [
    { id: `job-${seed}-a`, quantity: 2, unitCents: 125 },
    { id: `job-${seed}-b`, quantity: 1, unitCents: 0 },
    { id: `job-${seed}-c`, quantity: 3, unitCents: 475 },
    { id: `job-${seed}-d`, quantity: 4, unitCents: 0 },
    { id: `job-${seed}-e`, quantity: 0, unitCents: 825 },
  ];
  // Rotate inputs across repetitions; expected results are computed outside guests.
  jobs.push(...jobs.splice(0, Math.abs(seed) % jobs.length));
  return { preparationId, jobs, expected: jobs.map(job => ({ id: job.id, totalCents: job.quantity * job.unitCents })),
    fingerprint: createHash('sha256').update(JSON.stringify(jobs)).digest('hex') };
}
export function verifyWorker(ledger: WorkerLedger, before: WorkerProbe, after: WorkerResponse) {
  const expectedIds = ledger.expected.map(output => output.id).sort();
  const outputs = Array.isArray(after.outputs) ? after.outputs : [];
  const actualIds = outputs.map(output => output.id);
  const missingIds = expectedIds.filter(id => !actualIds.includes(id));
  const duplicateIds = [...new Set(actualIds.filter((id, index) => actualIds.indexOf(id) !== index))];
  const unexpectedIds = [...new Set(actualIds.filter(id => !expectedIds.includes(id)))];
  const stateRetained = before.preparationId === ledger.preparationId && before.inputFingerprint === ledger.fingerprint &&
    before.pending === ledger.jobs.length && before.phase === 'paused' &&
    after.preparationId === ledger.preparationId && after.inputFingerprint === ledger.fingerprint &&
    before.nonce === after.nonce && before.pid === after.pid;
  const normalized = (values: WorkerOutput[]) => values.map(({ id, totalCents }) => ({ id, totalCents })).sort((a, b) => a.id.localeCompare(b.id));
  const exactOutputs = isDeepStrictEqual(normalized(outputs), normalized(ledger.expected));
  const status = !stateRetained ? 'reproduction-lost' : exactOutputs && after.claimedCompleted && after.phase === 'completed' ? 'passed' : 'rejected';
  return { status, stateRetained, exactOutputs, expectedCount: ledger.expected.length, actualCount: outputs.length,
    missingIds, duplicateIds, unexpectedIds, claimedCompleted: after.claimedCompleted };
}
