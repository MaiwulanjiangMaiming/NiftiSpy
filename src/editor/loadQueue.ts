/** A single queued volume load, ordered by priority then dispatch time. */
export interface LoadJob {
  webviewId: string;
  priority: number;
  isRemote: boolean;
  abortController: AbortController;
  execute: () => Promise<void>;
}

/**
 * Bounded priority queue: remote and local loads have independent concurrency
 * limits so a slow SSH transfer cannot starve local files.
 */
export class LoadQueue {
  private queue: LoadJob[] = [];
  private activeRemote = 0;
  private activeLocal = 0;
  private maxRemote = 3;
  private maxLocal = 2;

  enqueue(job: LoadJob): void {
    // Binary insert — O(log n) instead of O(n log n) sort
    let lo = 0,
      hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.queue[mid].priority > job.priority) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, job);
    this.processNext();
  }

  promote(webviewId: string): void {
    const idx = this.queue.findIndex((j) => j.webviewId === webviewId);
    if (idx >= 0) {
      this.queue[idx].priority = 100;
      // Re-insert in sorted position
      const job = this.queue.splice(idx, 1)[0];
      let lo = 0,
        hi = this.queue.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.queue[mid].priority > job.priority) lo = mid + 1;
        else hi = mid;
      }
      this.queue.splice(lo, 0, job);
    }
  }

  cancel(webviewId: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (webviewId === '__all__' || this.queue[i].webviewId === webviewId) {
        this.queue[i].abortController.abort();
        this.queue.splice(i, 1);
      }
    }
  }

  private processNext(): void {
    while (this.queue.length > 0) {
      const remoteOk = this.activeRemote < this.maxRemote;
      const localOk = this.activeLocal < this.maxLocal;
      if (!remoteOk && !localOk) break;

      const idx = this.queue.findIndex((j) => {
        if (j.abortController.signal.aborted) return false;
        return j.isRemote ? remoteOk : localOk;
      });
      if (idx < 0) break;

      const job = this.queue.splice(idx, 1)[0];
      if (job.isRemote) this.activeRemote++;
      else this.activeLocal++;
      job.execute().finally(() => {
        if (job.isRemote) this.activeRemote--;
        else this.activeLocal--;
        this.processNext();
      });
    }
  }
}
