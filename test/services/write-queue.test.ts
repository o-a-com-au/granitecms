import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { enqueue } from '../../src/services/write-queue.ts';

test('C1: two writes submitted concurrently to the queue are applied strictly one at a time', async () => {
  const events: string[] = [];

  const jobA = enqueue(async () => {
    events.push('a-start');
    await delay(20);
    events.push('a-end');
  });

  const jobB = enqueue(async () => {
    events.push('b-start');
    await delay(1);
    events.push('b-end');
  });

  await Promise.all([jobA, jobB]);

  assert.deepEqual(events, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('a queue job that throws does not wedge the queue for subsequent jobs', async () => {
  const failing = enqueue(async () => {
    throw new Error('deliberate failure');
  });

  const following = enqueue(async () => 'still runs');

  await assert.rejects(failing, /deliberate failure/);
  assert.equal(await following, 'still runs');
});
