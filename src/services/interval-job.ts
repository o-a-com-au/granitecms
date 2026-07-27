// A small, checkpoint-agnostic scheduler primitive - not coupled to
// git or any specific job, reusable for any future recurring
// background work.
export interface IntervalJobHandle {
  stop: () => void;
}

export function startIntervalJob(
  job: () => Promise<unknown>,
  intervalMs: number,
  onError: (error: unknown) => void,
): IntervalJobHandle {
  const timer = setInterval(() => {
    job().catch(onError);
  }, intervalMs);
  // Must not itself keep a process (or a test) alive - the listening
  // socket is what should be process-life-sustaining, not this timer.
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
