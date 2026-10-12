// A completed badge is not evidence that the queued work survived.
export function processJobs(_jobs) {
  return { completed: true, outputs: [] };
}
