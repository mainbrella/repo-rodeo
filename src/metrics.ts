import { appendFile } from 'node:fs/promises';

export function eventRecorder(path: string) {
  const started = performance.now();
  return async (event: string, details: Record<string, unknown> = {}) => {
    await appendFile(path, `${JSON.stringify({
      timestamp: new Date().toISOString(), elapsedMs: performance.now() - started, event, ...details,
    })}\n`);
  };
}
