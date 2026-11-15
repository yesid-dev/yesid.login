import { expect, test } from 'bun:test';
import { ownedProcesses, remainingOwnedProcesses, terminateProcessTree, type ProcessEntry } from '../e2e/owned-processes.ts';
import { closeOwnedResource } from '../e2e/lifecycle.ts';
const row = (pid: number, parent: number, created: string, name = 'chrome.exe'): ProcessEntry => ({ pid, parent, created, name });

test('ownership excludes an older unrelated process carrying this shard root PID as stale PPID', () => {
  expect(ownedProcesses(3, [row(3, 1, '200', 'node.exe'), row(5, 3, '100')])).toEqual([]);
});
test('remaining ownership excludes an older orphan carrying an exited owned PID as PPID', () => {
  expect(remainingOwnedProcesses([row(5, 3, '200')], [row(6, 5, '100')])).toEqual([]);
});
test('termination never targets an older unrelated process with a stale PPID', async () => {
  const killed: number[] = [];
  await terminateProcessTree(row(5, 3, '200'), [row(5, 3, '200'), row(6, 5, '100')], { inventory: async pid => [row(5, 3, '200'), row(6, 5, '100')].filter(row => row.pid === pid), terminate: pid => { killed.push(pid); } });
  expect(killed).toEqual([5]);
});
test('successful deadline escalation warns with resource and phase durations', async () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    await closeOwnedResource('Chromium pid 5', () => new Promise(() => {}), async () => {}, async () => {}, 5);
    expect(warnings.join('\n')).toMatch(/Chromium pid 5.*graceful.*\d+.*force.*\d+.*verif.*\d+/);
  } finally { console.warn = warn; }
});
