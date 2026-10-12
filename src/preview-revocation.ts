import { setTimeout as pause } from 'node:timers/promises';
import type { Check } from './experiment-result.ts';
import type { CleanupResult, Preview, ProviderName, Sandbox } from './providers/interface.ts';
import { previewStatus } from './preview.ts';

export interface RevocationProbe {
  sandbox: Sandbox;
  rounds: { at: string; authenticated: number; unauthenticated?: number }[];
}

export function assessPreviewRevocation(provider: ProviderName, cleanup: CleanupResult | null, probes: RevocationProbe[]): Check {
  if (!probes.length) return { status: 'not-exercised', detail: 'No previews issued.' };
  if (provider === 'e2b') {
    // A 502 alone could be a live sandbox with a broken application. Require
    // confirmed ownership reconciliation and absence of every preview's exact
    // sandbox, plus repeated denial with both the retained token and no token.
    const absent = cleanup?.confirmed && probes.every(probe => cleanup.sandboxes.some(record =>
      record.absent && record.sandbox.id === probe.sandbox.id && record.sandbox.generation === probe.sandbox.generation));
    const denied = probes.every(probe => probe.rounds.length >= 3 && probe.rounds.every(round =>
      [404, 410, 502].includes(round.authenticated) && [404, 410, 502].includes(round.unauthenticated ?? 0)));
    return absent && denied
      ? { status: 'verified', detail: `${probes.length} E2B preview sandboxes were confirmed absent by the API; three probes per URL with and without the retained traffic token returned only HTTP 404/410/502. This confirms application access ended, not a separately revoked token.` }
      : { status: 'failed', detail: 'E2B preview cleanup requires exact API-confirmed sandbox absence and three HTTP 404/410/502 probes with and without the retained traffic token; network failures are inconclusive.' };
  }
  return probes.every(probe => probe.rounds.length > 0 && probe.rounds.every(round => [404, 410].includes(round.authenticated)))
    ? { status: 'verified', detail: `${probes.length} preview URLs returned HTTP 404/410 after cleanup.` }
    : { status: 'failed', detail: 'A preview did not confirm revocation with HTTP 404/410; network failures are inconclusive.' };
}

export async function probePreviewRevocation(provider: ProviderName, previews: { sandbox: Sandbox; preview: Preview }[],
  request: typeof previewStatus = previewStatus): Promise<RevocationProbe[]> {
  const probes: RevocationProbe[] = previews.map(({ sandbox }) => ({ sandbox, rounds: [] }));
  const status = async (preview: Preview, authenticated: boolean) => {
    try { return await request(preview.url, '/repo-rodeo-bug', authenticated ? preview.headers : undefined); }
    catch { return 0; }
  };
  for (let round = 0; round < (provider === 'e2b' ? 3 : 1) && previews.length; round++) {
    if (round) await pause(2000);
    for (const [index, { preview }] of previews.entries()) {
      const authenticated = await status(preview, true);
      const unauthenticated = provider === 'e2b' ? await status(preview, false) : undefined;
      probes[index].rounds.push({ at: new Date().toISOString(), authenticated, ...(unauthenticated === undefined ? {} : { unauthenticated }) });
    }
  }
  return probes;
}
