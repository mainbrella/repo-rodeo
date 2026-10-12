import { setTimeout as pause } from 'node:timers/promises';
import type { Check } from './experiment-result.ts';
import type { CleanupResult, Preview, ProviderName, Sandbox } from './providers/interface.ts';
import { previewStatus } from './preview.ts';

export interface PreviewRound {
  at: string;
  authenticated: number;
  withoutPreviewHeaders: number;
  liveControl?: number;
}
export interface RevocationProbe {
  sandbox: Sandbox;
  credentialTransport?: 'header' | 'bearer-url';
  beforeCleanup?: PreviewRound;
  rounds: PreviewRound[];
}
export function classifyPreviewStatus(status: number): 'accessible' | 'denied' | 'absent' | 'unavailable' | 'inconclusive' {
  if (status >= 200 && status < 300) return 'accessible';
  if ([401, 403].includes(status)) return 'denied';
  if ([404, 410].includes(status)) return 'absent';
  if ([502, 503, 504].includes(status)) return 'unavailable';
  return 'inconclusive';
}
export function assessPreviewTokenInvalidation(retainedStatus: number, freshStatus: number): Check {
  return [401, 403].includes(retainedStatus) && freshStatus === 200
    ? { status: 'verified', detail: 'After source restart, the retained token returned HTTP 401/403 while a fresh token returned HTTP 200 for the same preview URL.' }
    : { status: retainedStatus === 200 && freshStatus === 200 ? 'failed' : 'inconclusive', detail: 'Token invalidation requires HTTP 401/403 with the retained token and HTTP 200 with a fresh token at the same URL; route absence, gateway errors and network failures are inconclusive.' };
}

// The provider parameter remains for compatibility with historical callers. The
// evidence requirements and HTTP interpretation are identical for every provider.
export function assessPreviewRevocation(_provider: ProviderName, cleanup: CleanupResult | null, probes: RevocationProbe[]): Check {
  if (!probes.length) return { status: 'not-exercised', detail: 'No previews issued.' };
  const absent = probes.every(probe => cleanup?.sandboxes.some(record => record.absent &&
    record.sandbox.id === probe.sandbox.id && record.sandbox.generation === probe.sandbox.generation));
  if (!absent) return { status: 'inconclusive', detail: 'Exact API-confirmed sandbox absence is missing. Preview observations do not establish resource deletion.' };
  if (probes.some(probe => probe.rounds.some(round =>
    [round.authenticated, round.withoutPreviewHeaders].some(status => classifyPreviewStatus(status) === 'accessible')))) {
    return { status: 'failed', detail: 'A retained preview returned a successful HTTP response after API-confirmed sandbox deletion.' };
  }
  const complete = probes.every(probe => probe.beforeCleanup?.authenticated === 200 && probe.rounds.length >= 3 && probe.rounds.every(round =>
    [round.authenticated, round.withoutPreviewHeaders].every(status => ['denied', 'absent'].includes(classifyPreviewStatus(status))) &&
    (round.liveControl === undefined || round.liveControl === 200)));
  return complete
    ? { status: 'verified', detail: `${probes.length} previews worked with the retained credential before cleanup; after exact API-confirmed sandbox absence, three rounds per URL with and without preview headers returned HTTP 401/403 (access denied) or 404/410 (route absent). For bearer-URL previews, omitting headers still retains the URL credential. This does not establish independent token invalidation or physical storage deletion.` }
    : { status: 'inconclusive', detail: 'API sandbox absence and preview HTTP observations are recorded separately. Missing pre-cleanup access, fewer than three matched probes, gateway errors (including HTTP 502), a failing live control, and network failures cannot confirm the preview access transition or independent token invalidation.' };
}

export async function probePreviewRevocation(_provider: ProviderName, previews: { sandbox: Sandbox; preview: Preview }[],
  request: typeof previewStatus = previewStatus,
  options: { beforeCleanup?: RevocationProbe[]; rounds?: number; intervalMs?: number; liveControl?: Preview } = {}): Promise<RevocationProbe[]> {
  const probes: RevocationProbe[] = previews.map(({ sandbox, preview }) => ({ sandbox,
    credentialTransport: Object.keys(preview.headers ?? {}).length ? 'header' : 'bearer-url',
    ...(options.beforeCleanup?.find(probe => probe.sandbox.id === sandbox.id && probe.sandbox.generation === sandbox.generation)?.rounds[0]
      ? { beforeCleanup: options.beforeCleanup.find(probe => probe.sandbox.id === sandbox.id && probe.sandbox.generation === sandbox.generation)!.rounds[0] } : {}), rounds: [] }));
  const status = async (preview: Preview, authenticated: boolean) => {
    try { return await request(preview.url, '/repo-rodeo-bug', authenticated ? preview.headers : undefined); }
    catch { return 0; }
  };
  for (let round = 0; round < (options.rounds ?? 3) && previews.length; round++) {
    if (round) await pause(options.intervalMs ?? 2000);
    const liveControl = options.liveControl ? await status(options.liveControl, true) : undefined;
    for (const [index, { preview }] of previews.entries()) {
      const [authenticated, withoutPreviewHeaders] = await Promise.all([status(preview, true), status(preview, false)]);
      probes[index].rounds.push({ at: new Date().toISOString(), authenticated, withoutPreviewHeaders,
        ...(liveControl === undefined ? {} : { liveControl }) });
    }
  }
  return probes;
}
