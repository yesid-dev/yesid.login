import {
  ownedProcesses, mergeOwnedProcesses, remainingOwnedProcesses, processInventory, terminateProcessTree,
  isProcessAlive, waitForProcessExit, waitForProcessesExit, verifyProcessesGone, stopProcessInventory,
  type ProcessEntry
} from './owned-processes.ts';

type Tasks = { browser(): Promise<unknown>; worker(owned: ProcessEntry[] | undefined): Promise<unknown> };
const defaults = {
  root: process.pid, inventory: processInventory, terminate: terminateProcessTree,
  alive: isProcessAlive, wait: waitForProcessExit, stop: stopProcessInventory,
  report: (message: string) => console.info(message)
};

/** Always attempt every resource; sweep both the initial identities and newly observed children. */
export async function closeResourceSet(tasks: Tasks, overrides: Partial<typeof defaults> = {}): Promise<void> {
  const deps = { ...defaults, ...overrides };
  const failures: unknown[] = [];
  let owned: ProcessEntry[] | undefined;
  try { owned = ownedProcesses(deps.root, await deps.inventory()); }
  catch (error) { failures.push(new Error('Could not inventory owned Chromium/workerd processes', { cause: error })); }
  try { await tasks.browser(); } catch (error) { failures.push(error); }
  try { await tasks.worker(owned); } catch (error) { failures.push(error); }
  try {
    const rows = await deps.inventory();
    owned = mergeOwnedProcesses(owned || [], ownedProcesses(deps.root, rows));
    const remaining = remainingOwnedProcesses(owned, rows);
    const statuses = await Promise.allSettled(remaining.map(row => deps.alive(row)));
    const live = statuses.flatMap((status, i) => {
      if (status.status === 'rejected') { failures.push(new Error(`${remaining[i].name} pid ${remaining[i].pid} liveness unverified`, { cause: status.reason })); return []; }
      return status.value ? [remaining[i]] : [];
    });
    if (live.length) {
      deps.report(`cleanup - terminating orphaned owned processes: ${live.map(row => `${row.name} pid ${row.pid}`).join(', ')}`);
      const terminated = await Promise.allSettled(live.map(row => deps.terminate(row, rows, { inventory: deps.inventory })));
      for (const result of terminated) if (result.status === 'rejected') failures.push(result.reason);
      try { await waitForProcessesExit(live, deps.wait); } catch (error) { failures.push(error); }
    }
    const finalRows = await deps.inventory();
    owned = mergeOwnedProcesses(owned, ownedProcesses(deps.root, finalRows));
    await verifyProcessesGone(owned, finalRows, deps.alive);
    deps.report(`cleanup - verified 0 owned Chromium/workerd processes (${owned.length} tracked)`);
  } catch (error) { failures.push(error); }
  try { await deps.stop(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Resource cleanup failed');
}
