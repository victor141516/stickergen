export class InProcessQueue {
  constructor({ concurrency = 2, maxPending = 100, onError = console.error } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.maxPending = Math.max(1, Number(maxPending) || 1);
    this.onError = onError;
    this.pending = [];
    this.active = 0;
  }

  get size() {
    return this.pending.length + this.active;
  }

  enqueue(job) {
    if (this.size >= this.maxPending) return false;
    this.pending.push(job);
    this.pump();
    return true;
  }

  pump() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      this.active += 1;
      Promise.resolve()
        .then(job)
        .catch((error) => this.onError("in-process queue job failed", error))
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }
}
