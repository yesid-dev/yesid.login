/** Cleanup is best effort on interruption, but must never hold a process open indefinitely. */
export const CLEANUP_LIMIT_MS = 5_000;

/** Advance the parent's idle watchdog only when a new bounded cleanup phase starts. */
export function reportCleanupProgress(): void {
  if (!process.connected) return;
  // IPC loss is supervised by the parent; it must not prevent local reclamation.
  try { process.send?.({ type: 'e2e-cleanup-progress' }, () => {}); } catch {}
}

/** A deadline is an escalation trigger, not evidence that an owned process survived. */
export async function closeOwnedResource(name: string, close: () => Promise<unknown>,
  force: () => Promise<unknown>, verify: () => Promise<unknown>, limitMs = CLEANUP_LIMIT_MS): Promise<void> {
  const expired = new Error(`${name} graceful close exceeded its deadline`);
  let failure: unknown;
  let failed = false;
  try { await deadline(close, limitMs, expired); }
  catch (error) {
    if (error !== expired) { failed = true; failure = error; }
    console.info(`cleanup - ${name}: escalating to forced termination`);
    const forceExpired = new Error(`${name} force termination exceeded its deadline`);
    try { await deadline(force, limitMs, forceExpired); }
    catch (forceError) {
      if (forceError !== forceExpired) throw new AggregateError([error, forceError], `${name} force termination failed: ${String(forceError)}`);
      console.info(`cleanup - ${name}: force completion pending; verifying process exit`);
    }
  }
  try { await deadline(verify, limitMs, `${name} exit verification exceeded its deadline`); }
  catch (error) { throw new Error(`${name} remains unverified: ${String(error)}`, { cause: error }); }
  if (failed) throw failure;
}

async function deadline<T>(work: () => Promise<T>, limitMs: number, message: string | Error): Promise<T> {
  reportCleanupProgress();
  let limit: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => { limit = setTimeout(() => reject(typeof message === 'string' ? new Error(message) : message), limitMs); })
    ]);
  } finally { clearTimeout(limit); }
}

export async function cleanup(tasks: (() => unknown)[], limitMs = CLEANUP_LIMIT_MS): Promise<void> {
  const results = await deadline(() => Promise.allSettled(tasks.map(task => Promise.resolve().then(task))), limitMs, 'Resource cleanup exceeded its deadline');
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Resource cleanup failed');
}

/** Cover creation and readiness with one deadline; reclaim resources that arrive late. */
export async function startResource<T extends { dispose(): Promise<unknown> }>(start: () => Promise<T>, ready: (resource: T) => Promise<unknown>, limitMs: number): Promise<T> {
  let resource: T | undefined;
  let expired = false;
  const pending = Promise.resolve().then(start).then(async created => {
    resource = created;
    if (expired) {
      await cleanup([() => created.dispose()]);
      throw new Error('Local Worker startup exceeded its command limit');
    }
    await ready(created);
    return created;
  });
  try {
    return await deadline(() => pending, limitMs, 'Local Worker startup exceeded its command limit');
  } catch (error) {
    expired = true;
    await cleanup([() => resource?.dispose()]).catch(error => console.error('Startup cleanup:', error));
    throw error;
  }
}

/** Close a resource whose launch may still be pending; a rejected launch owns no resource. */
export function cleanupStarted<T>(started: Promise<T> | undefined, close: (resource: T) => Promise<unknown>): Promise<unknown> | undefined {
  return started?.then(close, () => {});
}
