import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { ProcessResult } from './verifier.ts';

export async function execute(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdout: string; stderr: string; timeoutMs: number; signal: AbortSignal },
): Promise<ProcessResult> {
  options.signal.throwIfAborted();
  const child = spawn(executable, args, { cwd: options.cwd, env: options.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const streams = Promise.all([
    pipeline(child.stdout, createWriteStream(options.stdout, { flags: 'wx' })),
    pipeline(child.stderr, createWriteStream(options.stderr, { flags: 'wx' })),
  ]);
  // Observe stream failures immediately, then await them after the child closes.
  void streams.catch(() => {});
  let timedOut = false;
  const kill = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs);
  options.signal.addEventListener('abort', kill, { once: true });
  try {
    const outcome = await new Promise<ProcessResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal, timedOut }));
    });
    await streams;
    return outcome;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', kill);
    kill();
  }
}
