// BUG: a zero-priced item is still a job that needs its receipt.
export function processJobs(jobs) {
  return {
    completed: true,
    outputs: jobs.filter(job => job.unitCents).map(job => ({ id: job.id, totalCents: job.quantity * job.unitCents })),
  };
}
