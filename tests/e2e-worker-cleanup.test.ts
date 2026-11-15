import { expect, test } from 'bun:test';
import { closeWorkerProcesses, type ProcessEntry } from '../e2e/owned-processes.ts';
const worker: ProcessEntry = { pid: 5, parent: process.pid, name: 'workerd.exe', created: '100' };

test('Worker disposal verifies all owned workerd identities without forcing a successful close', async () => {
  const events: string[] = [];
  await closeWorkerProcesses(async () => { events.push('dispose'); }, [worker], {
    terminate: async () => { events.push('kill'); }, wait: async entries => { expect(entries).toEqual([worker]); events.push('verify'); }, limitMs: 5
  });
  expect(events).toEqual(['dispose', 'verify']);
});
test('a hanging Worker dispose escalates recorded workerd identities and verifies exit', async () => {
  const events: string[] = [];
  await closeWorkerProcesses(() => new Promise(() => {}), [worker], {
    inventory: async () => [worker], terminate: async entry => { expect(entry).toEqual(worker); events.push('kill'); },
    wait: async () => { events.push('verify'); }, limitMs: 5
  });
  expect(events).toEqual(['kill', 'verify', 'verify']);
});
test('a recycled workerd PID is never sent to the termination operation', async () => {
  let killed = false;
  await closeWorkerProcesses(() => new Promise(() => {}), [worker], {
    inventory: async () => [{ ...worker, created: '200' }], terminate: async () => { killed = true; }, wait: async () => {}, limitMs: 5
  }); expect(killed).toBe(false);
});
test('a Worker disposal error survives successful process reclamation', async () => {
  const failure = new Error('dispose broken');
  await expect(closeWorkerProcesses(async () => { throw failure; }, [worker], {
    inventory: async () => [], wait: async () => {}, limitMs: 5
  })).rejects.toBe(failure);
});
test('missing Worker ownership cannot report verified exit', async () => {
  await expect(closeWorkerProcesses(async () => {}, undefined, { limitMs: 5 })).rejects.toThrow('ownership inventory');
});
