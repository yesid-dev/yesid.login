import { expect, test } from 'bun:test';
import { startLocalBrowser } from '../e2e/local-browser.ts';
import { sameProcess, type ProcessEntry } from '../e2e/owned-processes.ts';

function fixture() {
  const parent: ProcessEntry = { pid: process.pid, parent: 1, name: 'node.exe', created: '50' };
  const root: ProcessEntry = { pid: 5, parent: process.pid, name: 'chrome.exe', created: '100' };
  const child = { pid: 5, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
  let rows = [parent, root]; const events: string[] = [];
  const server = { process: () => child, wsEndpoint: () => 'ws://fixture', close: async () => { events.push('server close'); rows = [parent]; child.exitCode = 0; }, kill: async () => { events.push('unsafe server kill'); } };
  const browser = { contexts: () => [{ close: async () => { events.push('context close'); } }], close: async () => { events.push('browser close'); } };
  const deps = {
    launch: async () => server, connect: async () => browser,
    inventory: async (pid?: number) => rows.filter(row => pid === undefined || row.pid === pid),
    terminate: async (recorded: ProcessEntry) => { events.push('native kill'); expect(recorded).toEqual(root); rows = [parent]; child.exitCode = 0; },
    wait: async (recorded: ProcessEntry) => { if (rows.some(row => sameProcess(recorded, row))) throw new Error('still alive'); }, limitMs: 5
  };
  return { root, parent, child, events, server, browser, deps, replace: (next: ProcessEntry[]) => { rows = next; } };
}
test('startLocalBrowser closes contexts then browser then server and verifies launch identity', async () => {
  const f = fixture(); const local = await startLocalBrowser(f.deps); await local.dispose();
  expect(f.events).toEqual(['context close', 'browser close', 'server close']);
});
test('a slow browser escalates only the recorded live launch and never calls server.kill', async () => {
  const f = fixture(); f.browser.close = () => new Promise(() => {});
  const local = await startLocalBrowser(f.deps); await local.dispose();
  expect(f.events).toContain('native kill'); expect(f.events).not.toContain('unsafe server kill');
});
test('a recycled root PID is excluded even if its old ChildProcess flags lag', async () => {
  const f = fixture(); f.browser.close = () => { f.replace([f.parent, { ...f.root, created: '200' }]); return new Promise(() => {}); };
  const local = await startLocalBrowser(f.deps); await local.dispose();
  expect(f.events).not.toContain('native kill'); expect(f.events).not.toContain('unsafe server kill');
});
test('an exited child handle prevents force termination despite stale inventory', async () => {
  const f = fixture(); f.browser.close = () => { f.child.exitCode = 0; return new Promise(() => {}); };
  f.deps.wait = async () => {};
  const local = await startLocalBrowser(f.deps); await local.dispose();
  expect(f.events).not.toContain('native kill'); expect(f.events).not.toContain('unsafe server kill');
});
test('browser startup preserves a failed connection after successful reclamation', async () => {
  const f = fixture(), error = new Error('connection failed'); f.deps.connect = async () => { throw error; };
  await expect(startLocalBrowser(f.deps)).rejects.toBe(error); expect(f.events).toEqual(['server close']);
});
test('missing launch ownership fails without signalling any process', async () => {
  const f = fixture(); f.replace([f.parent]);
  await expect(startLocalBrowser(f.deps)).rejects.toThrow('launch identity unavailable'); expect(f.events).toEqual([]);
});
test('all contexts are attempted and a graceful close error is preserved after native reclamation', async () => {
  const f = fixture(); f.browser.contexts = () => [{ close: async () => { throw new Error('context broken'); } }, { close: async () => { f.events.push('second context close'); } }];
  const local = await startLocalBrowser(f.deps); await expect(local.dispose()).rejects.toThrow('Browser contexts failed to close');
  expect(f.events).toEqual(['second context close', 'native kill']);
});
