import { expect, test } from 'bun:test';
import { ownedProcesses, remainingOwnedProcesses, terminateProcessTree, verifyProcessesGone, waitForProcessExit, waitForProcessesExit, isProcessAlive, type ProcessEntry } from '../e2e/owned-processes.ts';
const row = (pid: number, parent: number, name = 'chrome.exe', created = '100'): ProcessEntry => ({ pid, parent, name, created });
const inventory = (rows: ProcessEntry[]) => async (pid?: number) => rows.filter(row => pid === undefined || row.pid === pid);
const present = async () => true;

test('ownership follows birth-ordered descendants through wrappers and excludes other suites', () => {
  const rows = [row(5, 4), row(4, 3, 'node.exe'), row(3, 1, 'node.exe'), row(6, 3, 'workerd.exe'), row(7, 2)];
  expect(ownedProcesses(3, rows).map(row => row.pid)).toEqual([5, 6]);
});
test('ownership includes POSIX browser names and their helpers', () => {
  expect(ownedProcesses(3, [row(3, 1, 'node'), row(5, 3, 'chrome-headless'), row(6, 5, 'crashpad_handler'), row(7, 2)]).map(row => row.pid)).toEqual([5, 6]);
});
test('verification names an orphan after its parent exits', async () => {
  const orphan = row(5, 1);
  await expect(verifyProcessesGone([orphan], [orphan], present)).rejects.toThrow('chrome.exe pid 5');
});
test('verification accepts exit and excludes reused Windows PIDs', async () => {
  await verifyProcessesGone([row(5, 1)], [], present);
  await verifyProcessesGone([row(5, 1)], [row(5, 2, 'chrome.exe', '200')], present);
});
test('a late renderer is owned only while its recorded parent is present with the same identity', () => {
  const parent = row(5, 1), renderer = row(99, 5, 'chrome.exe', '200');
  expect(remainingOwnedProcesses([parent], [parent, renderer]).map(row => row.pid)).toEqual([5, 99]);
  expect(remainingOwnedProcesses([parent], [renderer])).toEqual([]);
  expect(remainingOwnedProcesses([parent], [row(99, 5, 'chrome.exe', '50')])).toEqual([]);
});
test('an unknown younger orphan is never signalled and cannot produce a verified-zero result', async () => {
  const parent = row(5, 1), unknown = row(99, 5, 'chrome.exe', '200'); const killed: number[] = [];
  await terminateProcessTree(parent, [unknown], { inventory: inventory([unknown]), terminate: pid => { killed.push(pid); } });
  expect(killed).toEqual([]);
  await expect(verifyProcessesGone([parent], [unknown], present)).rejects.toThrow('pid 99 remains live or unverified (ownership lineage unverified)');
});
test('a previously recorded child remains owned and reclaimable after its parent exits', async () => {
  const parent = row(5, 1), renderer = row(99, 5, 'chrome.exe', '200'); const killed: number[] = [];
  expect(remainingOwnedProcesses([parent, renderer], [renderer])).toEqual([renderer]);
  await terminateProcessTree(renderer, [renderer], { inventory: inventory([renderer]), terminate: pid => { killed.push(pid); } });
  expect(killed).toEqual([99]);
});
test('missing creation metadata, including legacy POSIX rows, fails closed', async () => {
  expect(() => ownedProcesses(row(3, 1, 'node', ''), [row(5, 3, 'chrome', '')])).toThrow('Creation time unavailable');
  expect(() => ownedProcesses(row(3, 1, 'node'), [row(3, 1, 'node'), row(5, 3, 'chrome', '')])).toThrow('Creation time unavailable');
  await expect(isProcessAlive(row(5, 1, 'chrome', ''), { inventory: inventory([]) })).rejects.toThrow('Creation time unavailable');
});
test('native force signals only recorded descendants, with a fresh identity query per kill', async () => {
  const root = row(5, 1), rows = [root, row(6, 5, 'helper.exe'), row(7, 6), row(8, 1)];
  const killed: number[] = [], queries: number[] = [];
  await terminateProcessTree(root, rows, { inventory: async pid => { queries.push(pid!); return rows.filter(row => row.pid === pid); }, terminate: pid => { killed.push(pid); } });
  expect(killed).toEqual([7, 6, 5]); expect(queries).toEqual(killed);
});
test('PID recycling between snapshot and signal excludes the replacement', async () => {
  const root = row(5, 1), child = row(6, 5), killed: number[] = [];
  await terminateProcessTree(root, [root, child], { inventory: inventory([row(5, 1, 'chrome.exe', '200'), row(6, 1, 'chrome.exe', '200')]), terminate: pid => { killed.push(pid); } });
  expect(killed).toEqual([]);
});
test('termination attempts every identity despite a refusal and names its PID', async () => {
  const root = row(5, 1), rows = [root, row(6, 5)], killed: number[] = [];
  let failure: AggregateError | undefined;
  try { await terminateProcessTree(root, rows, { inventory: inventory(rows), terminate: pid => {
    killed.push(pid); if (pid === 6) throw Object.assign(new Error('denied'), { code: 'EPERM' });
  } }); } catch (error) { failure = error as AggregateError; }
  expect(killed).toEqual([6, 5]); expect(failure?.errors[0].message).toContain('pid 6');
});
test('already exited processes receive no signal', async () => {
  let killed = false;
  await terminateProcessTree(row(5, 1), [], { inventory: inventory([]), terminate: () => { killed = true; } });
  expect(killed).toBe(false);
});
test('liveness and exit waits check creation identity before touching a recycled PID', async () => {
  const recorded = row(5, 1), current = row(5, 1, 'chrome.exe', '200'); let probed = false;
  const alive = (entry: ProcessEntry) => isProcessAlive(entry, { inventory: inventory([current]), probe: () => { probed = true; } });
  expect(await alive(recorded)).toBe(false); await waitForProcessExit(recorded, 10, alive); expect(probed).toBe(false);
});
test('cached rows count as gone only with native exit acknowledgement', async () => {
  const entry = row(5, 1);
  expect(await isProcessAlive(entry, { inventory: inventory([entry]), probe: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } })).toBe(false);
  await verifyProcessesGone([entry], [entry], async () => false);
});
test('exit waits acknowledge termination and report every stuck identity', async () => {
  let alive = true; const timer = setTimeout(() => { alive = false; }, 20);
  try { await waitForProcessExit(row(5, 1), 100, async () => alive); expect(alive).toBe(false); } finally { clearTimeout(timer); }
  await expect(waitForProcessesExit([row(7, 1), row(8, 1)], entry => waitForProcessExit(entry, 10, present))).rejects.toThrow('pid 7 exit is unverified; chrome.exe pid 8');
});
test('a reused browser PID does not confer ownership of its new children', async () => {
  await verifyProcessesGone([row(5, 1)], [row(5, 1, 'chrome.exe', '200'), row(6, 5, 'chrome.exe', '200')], present);
});
