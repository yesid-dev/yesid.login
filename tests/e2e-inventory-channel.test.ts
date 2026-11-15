import { expect, test } from 'bun:test';
import { createInventoryChannel } from '../e2e/inventory-channel.ts';

test('sequence IDs keep stale metadata out of the next queued request', async () => {
  const sent: { id: number; pid?: number }[] = [];
  const channel = createInventoryChannel(request => { sent.push(request); });
  const first = channel.request(5), second = channel.request(6);
  channel.accept(JSON.stringify({ id: 1, rows: [] })); await first;
  let resolved = false; void second.then(() => { resolved = true; });
  channel.accept(JSON.stringify({ id: 1, rows: [] })); await Promise.resolve();
  expect(resolved).toBe(false);
  channel.accept(JSON.stringify({ id: 2, rows: [] })); await second;
  expect(sent).toEqual([{ id: 1, pid: 5 }, { id: 2, pid: 6 }]);
});
test('a timed-out host rejects queued and future requests despite a late reply', async () => {
  let sent = 0;
  const channel = createInventoryChannel(() => { sent++; }, 5);
  const results = await Promise.allSettled([channel.request(), channel.request()]);
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
  channel.accept(JSON.stringify({ id: 1, rows: [] }));
  await expect(channel.request()).rejects.toThrow('host is unusable'); expect(sent).toBe(1);
});

for (const outcome of ['not-found', 'identity-mismatch', 'killed'] as const) {
  test(`held-handle termination returns distinct ${outcome} outcome`, async () => {
    const sent: { id: number; pid?: number; created?: string; operation?: string }[] = [];
    const channel = createInventoryChannel(request => { sent.push(request); });
    const result = channel.terminate({ pid: 5, parent: 1, name: 'chrome.exe', created: '100' });
    expect(sent[0]).toEqual({ id: 1, pid: 5, created: '100', operation: 'terminate' });
    channel.accept(JSON.stringify({ id: 1, result: outcome }));
    expect(await result).toBe(outcome);
  });
}

test('an invalid termination result fails the host channel', async () => {
  const channel = createInventoryChannel(() => {});
  const result = channel.terminate({ pid: 5, parent: 1, name: 'chrome.exe', created: '100' });
  channel.accept(JSON.stringify({ id: 1, result: ['killed'] }));
  await expect(result).rejects.toThrow('invalid metadata');
  await expect(channel.request()).rejects.toThrow('invalid metadata');
});
