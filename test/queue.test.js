import assert from "node:assert/strict";
import test from "node:test";
import { InProcessQueue } from "../src/queue.js";

test("in-process queue respects concurrency and drains jobs", async () => {
  let running = 0;
  let peak = 0;
  let completed = 0;
  const queue = new InProcessQueue({ concurrency: 2, maxPending: 10 });
  const jobs = Array.from({ length: 5 }, () => queue.enqueue(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running -= 1;
    completed += 1;
  }));
  assert.ok(jobs.every(Boolean));
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (completed === 5) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });
  assert.equal(peak, 2);
  assert.equal(queue.size, 0);
});
