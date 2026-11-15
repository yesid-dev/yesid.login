import { expect, test } from 'bun:test';
import { closeResourceSet } from '../e2e/cleanup-resources.ts';
import type { ProcessEntry } from '../e2e/owned-processes.ts';
const root: ProcessEntry = { pid: 3, parent: 1, name: 'node.exe', created: '100' };
const child = (pid: number, parent = 3, created = '200'): ProcessEntry => ({ pid, parent, name: 'chrome.exe', created });
function fixture() {
  let rows = [root]; const messages: string[] = [], killed: number[] = [];
  return { messages, killed, replace: (next: ProcessEntry[]) => { rows = next; }, deps: {
    root: 3, inventory: async () => rows, alive: async (entry: ProcessEntry) => rows.some(row => row.pid === entry.pid && row.created === entry.created),
    terminate: async (entry: ProcessEntry) => { killed.push(entry.pid); rows = rows.filter(row => row.pid !== entry.pid); },
    wait: async (_entry: ProcessEntry) => {}, stop: async () => { messages.push('host stopped'); }, report: (message: string) => { messages.push(message); }
  } };
}
test('final ownership includes a process born after the initial snapshot', async () => {
  const f = fixture();
  await closeResourceSet({ browser: async () => { f.replace([root, child(5)]); }, worker: async () => {} }, f.deps);
  expect(f.killed).toEqual([5]); expect(f.messages.some(message => message.includes('verified 0'))).toBe(true);
});
test('a late unrelated older orphan is excluded from the fresh ownership union', async () => {
  const f = fixture();
  await closeResourceSet({ browser: async () => { f.replace([root, child(5, 3, '50')]); }, worker: async () => {} }, f.deps);
  expect(f.killed).toEqual([]);
});
test('every resource is attempted, and an actual close error remains a failure', async () => {
  const f = fixture(), events: string[] = [];
  await expect(closeResourceSet({ browser: async () => { events.push('browser'); throw new Error('broken close'); }, worker: async () => { events.push('worker'); } }, f.deps)).rejects.toThrow('Resource cleanup failed');
  expect(events).toEqual(['browser', 'worker']); expect(f.messages).toContain('host stopped');
});
test('exit waits name every stuck owned process and stop the inventory host', async () => {
  const f = fixture(); f.replace([root, child(5), child(6)]);
  f.deps.terminate = async () => {};
  f.deps.wait = async (entry: ProcessEntry) => { throw new Error(`stuck ${entry.pid}`); };
  let failure: AggregateError | undefined;
  try { await closeResourceSet({ browser: async () => {}, worker: async () => {} }, f.deps); } catch (error) { failure = error as AggregateError; }
  const details = failure?.errors.map(error => String(error)).join('; ') || '';
  expect(details).toContain('pid 5'); expect(details).toContain('pid 6'); expect(f.messages).toContain('host stopped');
});
test('a process appearing during final verification fails instead of printing verified zero', async () => {
  const f = fixture(); let snapshots = 0;
  f.deps.inventory = async () => ++snapshots < 3 ? [root] : [root, child(5)];
  f.deps.alive = async () => true;
  await expect(closeResourceSet({ browser: async () => {}, worker: async () => {} }, f.deps)).rejects.toThrow('Resource cleanup failed');
  expect(f.messages.some(message => message.includes('verified 0'))).toBe(false);
});
