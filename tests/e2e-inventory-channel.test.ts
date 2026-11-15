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
