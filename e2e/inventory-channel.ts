import { CLEANUP_LIMIT_MS, reportCleanupProgress } from './lifecycle.ts';
import type { ProcessEntry } from './owned-processes.ts';

export type TerminationResult = 'not-found' | 'identity-mismatch' | 'killed';
type Request = { id: number; pid?: number; created?: string; operation?: 'terminate' };
type Result = ProcessEntry[] | TerminationResult;
type Pending = { request: Request; resolve(value: Result): void; reject(error: Error): void };
const isTerminationResult = (value: unknown): value is TerminationResult => typeof value === 'string' && ['not-found', 'identity-mismatch', 'killed'].includes(value);

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
  const enqueue = (request: Omit<Request, 'id'>): Promise<Result> => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => { queue.push({ request: { id: ++sequence, ...request }, resolve, reject }); advance(); });
  };
  return {
    fail,
    async request(pid?: number): Promise<ProcessEntry[]> { return await enqueue({ pid }) as ProcessEntry[]; },
    async terminate(entry: ProcessEntry): Promise<TerminationResult> {
      return await enqueue({ pid: entry.pid, created: entry.created, operation: 'terminate' }) as TerminationResult;
    },
    accept(line: string) {
      if (failure) return;
      try {
        const reply = JSON.parse(line) as { id: number; rows?: ProcessEntry[]; result?: unknown; error?: boolean };
        if (!active || reply.id !== active.request.id) return;
        if (reply.error) throw new Error('Inventory host operation failed');
        let value: Result;
        if (active.request.operation === 'terminate') {
          if (!isTerminationResult(reply.result)) throw new Error('Invalid termination outcome');
          value = reply.result;
        } else {
          if (!Array.isArray(reply.rows)) throw new Error('Invalid process metadata');
          value = reply.rows;
        }
        clearTimeout(timer);
        active.resolve(value); active = undefined; advance();
      } catch (error) { fail(new Error('Process inventory host returned invalid metadata', { cause: error })); }
    }
  };
}
