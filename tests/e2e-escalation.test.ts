import { expect, test } from 'bun:test';
import { closeOwnedResource } from '../e2e/lifecycle.ts';

test('successful graceful close verifies exit without forcing termination', async () => {
  const events: string[] = [];
  await closeOwnedResource('Chromium', async () => { events.push('close'); }, async () => { events.push('kill'); },
    async () => { events.push('verify'); }, 10);
  expect(events).toEqual(['close', 'verify']);
});

test('a falsy graceful rejection still fails after resource reclamation', async () => {
  let failed = false;
  try { await closeOwnedResource('Chromium', async () => { throw undefined; }, async () => {}, async () => {}, 10); }
  catch { failed = true; }
  expect(failed).toBe(true);
});

test('exit verification has a deadline even when the verifier never settles', async () => {
  await expect(closeOwnedResource('Chromium', async () => {}, async () => {}, () => new Promise(() => {}), 10))
    .rejects.toThrow('Chromium remains unverified');
});

test('slow graceful close escalates and succeeds only after verification', async () => {
  const events: string[] = [];
  await closeOwnedResource('Chromium', () => new Promise(() => {}), async () => { events.push('kill'); },
    async () => { events.push('verify'); }, 10);
  expect(events).toEqual(['kill', 'verify']);
});

test('verification failure names the resource and fails cleanup', async () => {
  await expect(closeOwnedResource('Chromium pid 123', () => new Promise(() => {}), async () => {},
    async () => { throw new Error('still alive'); }, 10)).rejects.toThrow('Chromium pid 123');
});

test('a real graceful error is preserved even after successful reclamation', async () => {
  await expect(closeOwnedResource('Chromium', async () => { throw new Error('protocol broken'); }, async () => {},
    async () => {}, 10)).rejects.toThrow('protocol broken');
});

test('failed force close cannot pass verification', async () => {
  await expect(closeOwnedResource('Chromium', () => new Promise(() => {}), async () => { throw new Error('kill refused'); },
    async () => {}, 10)).rejects.toThrow('kill refused');
});

test('a hanging force close remains bounded', async () => {
  await expect(closeOwnedResource('Chromium', () => new Promise(() => {}), () => new Promise(() => {}),
    async () => { throw new Error('process is still alive'); }, 10)).rejects.toThrow('Chromium remains unverified');
});

test('pending kill bookkeeping can pass only when exit verification succeeds', async () => {
  let verified = false;
  await closeOwnedResource('Chromium', () => new Promise(() => {}), () => new Promise(() => {}),
    async () => { verified = true; }, 10);
  expect(verified).toBe(true);
});

test('a real owned process is force-terminated and its exit is observed', async () => {
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    await closeOwnedResource(`fixture pid ${child.pid}`, () => new Promise(() => {}), async () => {
      child.kill('SIGKILL'); await child.exited;
    }, async () => { await child.exited; }, 100);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await child.exited; } }
});
