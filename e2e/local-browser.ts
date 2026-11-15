import { chromium } from 'playwright-core';
import { closeOwnedResource } from './lifecycle.ts';
import { processInventory, terminateProcessTree, isProcessAlive, waitForProcessExit } from './owned-processes.ts';

/** Keep the public process handle so shutdown never relies on a protocol reply alone. */
export async function startLocalBrowser() {
  const server = await chromium.launchServer();
  const child = server.process();
  const name = `Chromium pid ${child.pid}`;
  // ChildProcess/Playwright completion can lag native exit while inherited pipes drain.
  const verify = () => waitForProcessExit(child.pid!);
  const force = async () => {
    if (isProcessAlive(child.pid!)) terminateProcessTree(child.pid!, await processInventory());
    await verify();
    await server.kill();
  };
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    return { browser, dispose: () => closeOwnedResource(name, async () => {
      await Promise.all(browser.contexts().map(context => context.close()));
      await browser.close();
      await server.close();
    }, force, verify) };
  } catch (error) {
    await closeOwnedResource(name, () => server.close(), force, verify);
    throw error;
  }
}
