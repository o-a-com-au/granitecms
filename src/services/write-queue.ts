// The single in-process write queue: all disk and git mutations go
// through enqueue(), one job at a time (constraint 6). Ordering only -
// no domain knowledge of what "clean" means for a failed job. That is
// each job's own responsibility (see drafts.ts, publish.ts).
//
// In-memory only, does not survive restart: the API only reports
// success after a write (and commit, where applicable) completes, so an
// in-flight request during a crash simply fails and the caller retries.

let tail: Promise<unknown> = Promise.resolve();

export function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const result = tail.then(job, job);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
