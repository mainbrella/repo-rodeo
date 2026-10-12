// Deliberately volatile: inputs, pending jobs and receipts are never written to disk.
// The host verifier is the only durable owner of the expected job ledger.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const nonce = randomUUID();
let preparationId = null;
let jobs = [];
let inputFingerprint = null;
let outputs = [];
let phase = 'empty';
let marker = null;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const probe = () => ({
  nonce, pid: process.pid, node: process.versions.node, preparationId,
  phase, pending: jobs.length, outputCount: outputs.length, marker,
  inputFingerprint, stateFingerprint: hash({ preparationId, jobs, outputs, phase, marker }),
});
const server = createServer(async (request, response) => {
  const reply = (status, value) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  try {
    if (request.method === 'GET' && request.url === '/probe') return reply(200, probe());
    if (request.method !== 'POST') return reply(404, { error: 'Unknown route' });
    let body = '';
    for await (const part of request) {
      body += part;
      if (body.length > 64_000) return reply(413, { error: 'Request too large' });
    }
    const value = JSON.parse(body || '{}');
    if (request.url === '/prepare') {
      if (phase !== 'empty' || preparationId) return reply(409, { error: 'Already prepared' });
      if (typeof value.preparationId !== 'string' || !Array.isArray(value.jobs) || !value.jobs.length ||
          value.jobs.some(job => typeof job.id !== 'string' || !Number.isSafeInteger(job.quantity) ||
            !Number.isSafeInteger(job.unitCents) || job.quantity < 0 || job.unitCents < 0)) {
        return reply(400, { error: 'Invalid jobs' });
      }
      preparationId = value.preparationId;
      jobs = value.jobs.map(({ id, quantity, unitCents }) => ({ id, quantity, unitCents }));
      inputFingerprint = hash(jobs);
      phase = 'paused';
      return reply(200, probe());
    }
    if (request.url === '/marker') {
      if (typeof value.marker !== 'string') return reply(400, { error: 'Invalid marker' });
      marker = value.marker;
      return reply(200, probe());
    }
    if (request.url === '/resume') {
      if (!['empty', 'paused'].includes(phase)) return reply(409, { error: 'Already resumed' });
      // This explicit checkpoint makes a disk patch loadable without a restart.
      // It is not transparent hot replacement of an already executing function.
      const path = pathToFileURL(resolve(process.env.WORKER_PROCESSOR || 'processor.mjs'));
      const { processJobs } = await import(`${path.href}?resume=${randomUUID()}`);
      const result = await processJobs(structuredClone(jobs));
      outputs = result.outputs;
      jobs = [];
      phase = result.completed ? 'completed' : 'failed';
      return reply(200, { ...probe(), claimedCompleted: result.completed, outputs });
    }
    return reply(404, { error: 'Unknown route' });
  } catch {
    return reply(500, { error: 'Worker operation failed' });
  }
});
server.listen(Number(process.env.PORT || 5173), process.env.HOST || '0.0.0.0', () => {
  // Inputs and outputs deliberately do not appear in stdout.
  console.log(JSON.stringify({ ready: true, nonce, pid: process.pid, port: server.address().port }));
});
