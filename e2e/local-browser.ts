import { chromium, type Browser } from 'playwright-core';
import type { ChildProcess } from 'node:child_process';
import { CLEANUP_LIMIT_MS, closeOwnedResource } from './lifecycle.ts';
import { processInventory, terminateProcessTree, waitForProcessExit, sameProcess, ownedProcesses, type Inventory } from './owned-processes.ts';

type BrowserHandle = { contexts(): { close(): Promise<unknown> }[]; close(): Promise<unknown> };
type ServerHandle = { process(): Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>; wsEndpoint(): string; close(): Promise<unknown> };
type Dependencies<B extends BrowserHandle> = {
  launch(): Promise<ServerHandle>; connect(endpoint: string): Promise<B>; inventory: Inventory;
  terminate: typeof terminateProcessTree; wait: typeof waitForProcessExit; limitMs?: number;
};
const defaults: Dependencies<Browser> = {
  launch: () => chromium.launchServer(), connect: endpoint => chromium.connect(endpoint),
  inventory: processInventory, terminate: terminateProcessTree, wait: waitForProcessExit
};

export function startLocalBrowser<B extends BrowserHandle>(dependencies: Dependencies<B>): Promise<{ browser: B; dispose(): Promise<void> }>;
export function startLocalBrowser(): Promise<{ browser: Browser; dispose(): Promise<void> }>;
/** Record launch identity before handing out the browser. Escalation never calls server.kill(). */
export async function startLocalBrowser(deps: Dependencies<BrowserHandle> = defaults) {
  const server = await deps.launch();
  const child = server.process();
  const name = `Chromium pid ${child.pid}`;
  const running = () => child.exitCode === null && child.signalCode === null;
  const root = ownedProcesses(process.pid, await deps.inventory()).find(row => row.pid === child.pid);
  if (!root || !running()) throw new Error(`${name} launch identity unavailable`);
  // Validating itself fails closed if birth metadata is missing, including on POSIX.
  sameProcess(root, root);
  const verify = () => deps.wait(root);
  const force = async () => {
    const rows = await deps.inventory();
    if (running() && sameProcess(root, rows.find(row => row.pid === root.pid))) {
      await deps.terminate(root, rows, { inventory: deps.inventory });
    }
    await verify();
    // Playwright's Windows server.kill() invokes taskkill via a shell using only a PID.
    // Native termination and onclose release the server; never issue that second kill.
  };
  const closeServer = async () => {
    if (running() && sameProcess(root, (await deps.inventory(root.pid)).find(row => row.pid === root.pid))) await server.close();
  };
  try {
    const browser = await deps.connect(server.wsEndpoint());
    return { browser, dispose: () => closeOwnedResource(name, async () => {
      const results = await Promise.allSettled(browser.contexts().map(context => context.close()));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Browser contexts failed to close');
      await browser.close(); await closeServer();
    }, force, verify, deps.limitMs ?? CLEANUP_LIMIT_MS) };
  } catch (error) {
    try { await closeOwnedResource(name, closeServer, force, verify, deps.limitMs ?? CLEANUP_LIMIT_MS); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Browser connection and cleanup failed'); }
    throw error;
  }
}
