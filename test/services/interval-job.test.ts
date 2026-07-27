import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startIntervalJob } from '../../src/services/interval-job.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls until predicate() is true or capMs elapses, rather than a
// single fixed sleep - avoids CI flakiness from picking an exact
// timing, while still bounding worst-case test duration.
async function waitUntil(predicate: () => boolean, capMs: number, stepMs = 5): Promise<void> {
  const deadline = Date.now() + capMs;
  while (!predicate() && Date.now() < deadline) {
    await sleep(stepMs);
  }
}

test('startIntervalJob calls the job repeatedly on the given interval', async () => {
  let count = 0;
  const handle = startIntervalJob(async () => { count += 1; }, 20, () => {});
  try {
    await waitUntil(() => count >= 2, 500);
    assert.ok(count >= 2, `expected at least 2 ticks, got ${count}`);
  } finally {
    handle.stop();
  }
});

test('stop() actually clears the timer - no further ticks happen after stopping', async () => {
  let count = 0;
  const handle = startIntervalJob(async () => { count += 1; }, 20, () => {});
  await waitUntil(() => count >= 1, 500);
  handle.stop();
  const countAtStop = count;
  await sleep(100);
  assert.equal(count, countAtStop, 'no further ticks may happen after stop()');
});

test('a job that always rejects still invokes onError, and no unhandled rejection escapes', async () => {
  const errors: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);

  const handle = startIntervalJob(async () => { throw new Error('job always fails'); }, 20, (error) => {
    errors.push(error);
  });
  try {
    await waitUntil(() => errors.length >= 1, 500);
    assert.ok(errors.length >= 1, 'onError must be invoked when the job rejects');
    assert.equal((errors[0] as Error).message, 'job always fails');
    // Give any would-be unhandled rejection a moment to surface before
    // asserting its absence.
    await sleep(50);
    assert.equal(unhandled.length, 0, 'no unhandled rejection may escape a failing job');
  } finally {
    handle.stop();
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});
