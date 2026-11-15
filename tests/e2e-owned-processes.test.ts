import { expect, test } from 'bun:test';
import { ownedProcesses, terminateProcessTree, verifyProcessesGone, waitForProcessExit, type ProcessEntry } from '../e2e/owned-processes.ts';
const row = (pid: number, parent: number, name: string, created = 'original'): ProcessEntry => ({ pid, parent, name, created });
test('ownership follows descendants through wrappers and excludes other suites', () => {
  const rows = [row(5, 4, 'chrome.exe'), row(4, 3, 'node.exe'), row(3, 1, 'node.exe'), row(6, 3, 'workerd.exe'), row(7, 2, 'chrome.exe')];
  expect(ownedProcesses(3, rows).map(row => row.pid)).toEqual([5, 6]);
});

test('ownership includes shortened POSIX browser names and their non-browser helpers', () => {
  expect(ownedProcesses(3, [row(5, 3, 'chrome-headless'), row(6, 5, 'crashpad_handler'), row(7, 2, 'chrome.exe')]).map(row => row.pid))
    .toEqual([5, 6]);
});
test('verification names an orphan even after its parent has exited', () => {
  const orphan = row(5, 1, 'chrome.exe');
  expect(() => verifyProcessesGone([orphan], [orphan])).toThrow('chrome.exe pid 5');
});
test('verification accepts exited processes and ignores reused Windows PIDs', () => {
  expect(() => verifyProcessesGone([row(5, 1, 'chrome.exe')], [])).not.toThrow();
  expect(() => verifyProcessesGone([row(5, 1, 'chrome.exe')], [row(5, 2, 'chrome.exe', 'new')])).not.toThrow();
});

test('verification catches a late renderer even after the recorded browser parent exits', () => {
  expect(() => verifyProcessesGone([row(5, 1, 'chrome.exe')], [row(99, 5, 'chrome.exe')]))
    .toThrow('chrome.exe pid 99');
});

test('native force termination targets only the owned tree, including non-browser children', () => {
  const killed: number[] = [];
  terminateProcessTree(5, [row(5, 1, 'chrome.exe'), row(6, 5, 'helper.exe'), row(7, 6, 'chrome.exe'), row(8, 1, 'chrome.exe')], pid => { killed.push(pid); });
  expect(killed).toEqual([7, 6, 5]);
});

test('termination attempts the remaining tree after a failure and names the refused PID', () => {
  const killed: number[] = [];
  let failure: AggregateError | undefined;
  try { terminateProcessTree(5, [row(6, 5, 'chrome.exe')], pid => {
    killed.push(pid); if (pid === 6) throw Object.assign(new Error('denied'), { code: 'EPERM' });
  }); } catch (error) { failure = error as AggregateError; }
  expect(killed).toEqual([6, 5]);
  expect(failure?.errors[0].message).toContain('pid 6');
});

test('an already exited process needs no further termination', () => {
  expect(() => terminateProcessTree(5, [], () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); })).not.toThrow();
});

test('cached inventory rows count as gone only with native exit acknowledgement', () => {
  const process = row(5, 1, 'chrome.exe');
  expect(() => verifyProcessesGone([process], [process], () => false)).not.toThrow();
  expect(() => verifyProcessesGone([process], [process], () => true)).toThrow('pid 5');
});

test('exit acknowledgement waits for termination and reports a process that stays alive', async () => {
  let alive = true;
  const timer = setTimeout(() => { alive = false; }, 20);
  try { await waitForProcessExit(5, 100, () => alive); expect(alive).toBe(false); }
  finally { clearTimeout(timer); }
  await expect(waitForProcessExit(7, 20, () => true)).rejects.toThrow('pid 7');
});

test('a reused browser PID does not confer ownership of its new children', () => {
  expect(() => verifyProcessesGone([row(5, 1, 'chrome.exe')], [row(5, 1, 'chrome.exe', 'new'), row(6, 5, 'chrome.exe', 'new')])).not.toThrow();
});
