export function processJobs(jobs) {
  return {
    completed: true,
    outputs: jobs.map(job => ({ id: job.id, totalCents: job.quantity * job.unitCents })),
  };
}
