import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CLEANUP_LIMIT_MS, closeOwnedResource, reportCleanupProgress } from './lifecycle.ts';

export type ProcessEntry = { pid: number; parent: number; name: string; created: string };
const execute = promisify(execFile);

// Start the Windows host while the suite starts, so cold shell startup is never teardown work.
const pwsh = join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
const query = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;name=$_.Name;created=$(if($_.CreationDate){$_.CreationDate.ToFileTimeUtc().ToString()}else{""})} } | ConvertTo-Json -Compress';
let host: ChildProcessWithoutNullStreams | undefined;
let resolveReady!: () => void;
let rejectReady!: (error: Error) => void;
const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
void ready.catch(() => {});
let pending: { resolve(value: ProcessEntry[]): void; reject(error: Error): void } | undefined;
let exited: Promise<void> = Promise.resolve();

export function warmProcessInventory(): void {
  if (host || process.platform !== 'win32') return;
  host = spawn(existsSync(pwsh) ? pwsh : 'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `[Console]::WriteLine('ready'); while($null -ne [Console]::ReadLine()){ try { ${query} } catch { [Console]::WriteLine('failed') } }`],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  host.stderr.resume();
  exited = new Promise<void>(resolve => host!.once('exit', () => resolve()));
  host.on('error', error => { rejectReady(error); pending?.reject(error); });
  host.on('exit', () => {
    const error = new Error('Process inventory host exited');
    rejectReady(error); pending?.reject(error);
  });
  createInterface({ input: host.stdout }).on('line', line => {
    if (line === 'ready') { resolveReady(); return; }
    try {
      const rows = JSON.parse(line) as ProcessEntry | ProcessEntry[];
      pending?.resolve(Array.isArray(rows) ? rows : [rows]);
    } catch { pending?.reject(new Error('Process inventory host returned invalid metadata')); }
  });
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  reportCleanupProgress();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Process inventory exceeded its deadline')), CLEANUP_LIMIT_MS);
  })]); } finally { clearTimeout(timer); }
}

/** Read only IDs, image names and creation times, never process arguments or environment. */
export async function processInventory(): Promise<ProcessEntry[]> {
  warmProcessInventory();
  if (host) {
    await bounded(ready);
    if (pending) throw new Error('Concurrent process inventory request');
    try { return await bounded(new Promise<ProcessEntry[]>((resolve, reject) => {
      pending = { resolve, reject }; host!.stdin.write('snapshot\n');
    })); } finally { pending = undefined; }
  }
  const { stdout } = await execute('ps', ['-eo', 'pid=,ppid=,comm='], { timeout: CLEANUP_LIMIT_MS });
  return stdout.trim().split('\n').map(line => {
    const [pid, parent, ...name] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), name: name.join(' ').split('/').pop()!, created: '' };
  });
}

export async function stopProcessInventory(): Promise<void> {
  if (!host) return;
  await closeOwnedResource(`Process inventory host pid ${host.pid}`, async () => {
    host!.stdin.end(); await exited;
  }, async () => { host!.kill('SIGKILL'); await exited; }, () => host!.pid ? waitForProcessExit(host!.pid) : Promise.resolve());
}

function descendantsOf(root: number, rows: ProcessEntry[]): ProcessEntry[] {
  const descendants = new Set([root]);
  let previous = 0;
  while (previous !== descendants.size) {
    previous = descendants.size;
    for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid);
  }
  return rows.filter(row => descendants.has(row.pid) && row.pid !== root);
}

export function ownedProcesses(root: number, rows: ProcessEntry[]): ProcessEntry[] {
  const descendants = descendantsOf(root, rows);
  const resources = descendants.filter(row => /^(chrome(?:[-_].*)?|chromium(?:[-_].*)?|headless_shell|workerd)(\.exe)?$/i.test(row.name));
  const owned = new Set(resources.map(row => row.pid));
  for (const resource of resources) for (const child of descendantsOf(resource.pid, rows)) owned.add(child.pid);
  return descendants.filter(row => owned.has(row.pid));
}

/** Use native termination for each owned PID; do not start taskkill during teardown. */
export function terminateProcessTree(root: number, rows: ProcessEntry[], terminate: (pid: number) => void = pid => { process.kill(pid, 'SIGKILL'); }): void {
  const failures: Error[] = [];
  for (const pid of [...descendantsOf(root, rows).map(row => row.pid).reverse(), root]) {
    try { terminate(pid); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(new Error(`Could not terminate owned pid ${pid}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Owned process termination failed');
}

export function remainingOwnedProcesses(owned: ProcessEntry[], rows: ProcessEntry[]): ProcessEntry[] {
  const remaining = owned.filter(before => rows.some(now => now.pid === before.pid && now.created === before.created));
  // A browser may spawn another renderer after the first snapshot. Parent IDs survive exit.
  for (const before of owned) {
    const current = rows.find(row => row.pid === before.pid);
    if (current && current.created !== before.created) continue;
    for (const descendant of descendantsOf(before.pid, rows)) {
      if (!remaining.some(row => row.pid === descendant.pid)) remaining.push(descendant);
    }
  }
  return remaining;
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

/** Wait for the OS to acknowledge one termination, without reissuing the signal. */
export async function waitForProcessExit(pid: number, limitMs = CLEANUP_LIMIT_MS, alive = isProcessAlive): Promise<void> {
  reportCleanupProgress();
  const end = performance.now() + limitMs;
  while (alive(pid)) {
    if (performance.now() >= end) throw new Error(`Owned pid ${pid} is still alive`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export function verifyProcessesGone(owned: ProcessEntry[], rows: ProcessEntry[], alive: (pid: number) => boolean = () => true): void {
  const remaining = remainingOwnedProcesses(owned, rows).filter(row => alive(row.pid));
  if (remaining.length) throw new Error(`Owned processes remain: ${remaining.map(row => `${row.name} pid ${row.pid}`).join(', ')}`);
}

/** Wrangler owns multiple workerd processes; a slow dispose must reclaim every one. */
export async function closeWorkerProcesses(close: () => Promise<unknown>, owned: ProcessEntry[] | undefined): Promise<void> {
  await closeOwnedResource('Local Worker', close, async () => {
    if (!owned) throw new Error('Local Worker ownership inventory is unavailable');
    const rows = await processInventory();
    const workers = remainingOwnedProcesses(owned, rows).filter(row => /^workerd(\.exe)?$/i.test(row.name) && isProcessAlive(row.pid));
    for (const worker of workers) terminateProcessTree(worker.pid, rows);
    await Promise.all(workers.map(worker => waitForProcessExit(worker.pid)));
  }, async () => {
    if (!owned) throw new Error('Local Worker exit cannot be verified without its ownership inventory');
    await Promise.all(owned.filter(row => /^workerd(\.exe)?$/i.test(row.name)).map(worker => waitForProcessExit(worker.pid)));
  });
}
