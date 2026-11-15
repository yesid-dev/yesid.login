import { CLEANUP_LIMIT_MS, reportCleanupProgress } from './lifecycle.ts';
import type { ProcessEntry } from './owned-processes.ts';

type Request = { id: number; pid?: number };
type Pending = { request: Request; resolve(rows: ProcessEntry[]): void; reject(error: Error): void };

/** A timed-out host is terminal; sequence IDs also keep late replies out of later requests. */
export function createInventoryChannel(send: (request: Request) => void, limitMs = CLEANUP_LIMIT_MS) {
  let sequence = 0;
  let active: Pending | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure: Error | undefined;
  const queue: Pending[] = [];
  const fail = (error: Error) => {
    failure ??= error;
    clearTimeout(timer);
    active?.reject(failure); active = undefined;
    for (const pending of queue.splice(0)) pending.reject(failure);
  };
  const advance = () => {
    if (active || failure || !queue.length) return;
    active = queue.shift()!;
    reportCleanupProgress();
    timer = setTimeout(() => fail(new Error('Process inventory exceeded its deadline; host is unusable')), limitMs);
    try { send(active.request); } catch (error) { fail(new Error('Process inventory request failed', { cause: error })); }
  };
  return {
    fail,
    request(pid?: number): Promise<ProcessEntry[]> {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        queue.push({ request: { id: ++sequence, pid }, resolve, reject }); advance();
      });
    },
    accept(line: string) {
      if (failure) return;
      try {
        const reply = JSON.parse(line) as { id: number; rows: ProcessEntry[]; error?: boolean };
        if (!active || reply.id !== active.request.id) return;
        if (reply.error || !Array.isArray(reply.rows)) throw new Error('Invalid process metadata');
        clearTimeout(timer);
        active.resolve(reply.rows); active = undefined; advance();
      } catch (error) { fail(new Error('Process inventory host returned invalid metadata', { cause: error })); }
    }
  };
}
