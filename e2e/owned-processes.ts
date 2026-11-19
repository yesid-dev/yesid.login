import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CLEANUP_LIMIT_MS, closeOwnedResource, reportCleanupProgress } from './lifecycle.ts';
import { createInventoryChannel, type TerminationResult } from './inventory-channel.ts';

export type ProcessEntry = { pid: number; parent: number; name: string; created: string };
export type Inventory = (pid?: number) => Promise<ProcessEntry[]>;
export type Alive = (entry: ProcessEntry) => Promise<boolean>;
const execute = promisify(execFile);
const pwsh = join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
const query = `
function Stop-RecordedProcess($request) {
  $candidate = $null
  try {
    $candidate = [Diagnostics.Process]::GetProcessById([int]$request.pid)
    # Open and retain the native handle before checking birth. Dispose only after Kill.
    $heldHandle = $candidate.Handle
    if($candidate.HasExited) { return 'not-found' }
    $ticks = $candidate.StartTime.ToFileTimeUtc()
    $created = ($ticks - ($ticks % 10)).ToString()
    if($created -ne [string]$request.created) { return 'identity-mismatch' }
    $candidate.Kill()
    return 'killed'
  } catch {
    $reason = $_.Exception
    while($reason.InnerException) { $reason = $reason.InnerException }
    if($reason -is [ArgumentException] -or $reason -is [InvalidOperationException] -or ($reason -is [ComponentModel.Win32Exception] -and $reason.NativeErrorCode -eq 87)) { return 'not-found' }
    throw
  } finally { if($candidate) { $candidate.Dispose() } }
}
# One native process snapshot: parent, name and creation time in about 0.1 s, where WMI takes seconds on a busy host.
# Creation times use the same 1-microsecond rounding as the targeted read below; a process this user cannot open
# reports no creation time, and the ownership checks fail closed on any such row they would need.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class LoginProcessRow { public uint pid { get; set; } public uint parent { get; set; } public string name { get; set; } public string created { get; set; } }
public static class LoginProcessSnapshot {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry { public uint size; public uint usage; public uint pid; public IntPtr heap; public uint module; public uint threads; public uint parent; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static List<LoginProcessRow> Take() {
    var rows = new List<LoginProcessRow>();
    IntPtr snapshot = CreateToolhelp32Snapshot(0x2, 0);
    if (snapshot == new IntPtr(-1)) throw new Win32Exception();
    try {
      var entry = new Entry(); entry.size = (uint)Marshal.SizeOf(typeof(Entry));
      if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception();
      do {
        string created = "";
        IntPtr process = OpenProcess(0x1000, false, entry.pid);
        if (process != IntPtr.Zero) {
          try { long c, e, k, u; if (GetProcessTimes(process, out c, out e, out k, out u) && c > 0) created = (c - (c % 10)).ToString(); }
          finally { CloseHandle(process); }
        }
        rows.Add(new LoginProcessRow { pid = entry.pid, parent = entry.parent, name = entry.exe, created = created });
      } while (Process32NextW(snapshot, ref entry));
    } finally { CloseHandle(snapshot); }
    return rows;
  }
}
'@
[Console]::WriteLine('ready')
while($null -ne ($line = [Console]::ReadLine())) {
  $request = $line | ConvertFrom-Json
  try {
    if($request.operation -eq 'terminate') {
      $result = Stop-RecordedProcess $request
      [pscustomobject]@{id=$request.id;result=$result} | ConvertTo-Json -Compress
      continue
    }
    if($null -ne $request.pid) {
      $candidate = $null
      try {
        $candidate = [Diagnostics.Process]::GetProcessById([int]$request.pid)
        $ticks = $candidate.StartTime.ToFileTimeUtc()
        # CIM birth times have microsecond precision; keep both providers canonical.
        $created = ($ticks - ($ticks % 10)).ToString()
        $rows = @([pscustomobject]@{pid=$candidate.Id;parent=0;name=($candidate.ProcessName+'.exe');created=$created})
      } catch {
        $reason = $_.Exception
        while($reason.InnerException) { $reason = $reason.InnerException }
        if($reason -is [ArgumentException] -or $reason -is [InvalidOperationException] -or ($reason -is [ComponentModel.Win32Exception] -and $reason.NativeErrorCode -eq 87)) { $rows = @() } else { throw }
      } finally { if($candidate) { $candidate.Dispose() } }
    } else {
      $snapshotStarted = [DateTime]::UtcNow.ToFileTimeUtc()
      $rows = @(foreach($row in [LoginProcessSnapshot]::Take()) {
        if(!$row.created -or [long]$row.created -le $snapshotStarted) {
          [pscustomobject]@{pid=$row.pid;parent=$row.parent;name=$row.name;created=$row.created}
        }
      })
    }
    [pscustomobject]@{id=$request.id;rows=$rows} | ConvertTo-Json -Depth 4 -Compress
  } catch { [pscustomobject]@{id=$request.id;error=$true;rows=@()} | ConvertTo-Json -Compress }
}`;
let host: ChildProcessWithoutNullStreams | undefined;
let resolveReady!: () => void;
let rejectReady!: (error: Error) => void;
const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
void ready.catch(() => {});
let exited: Promise<void> = Promise.resolve();
const channel = createInventoryChannel(request => host!.stdin.write(JSON.stringify(request) + '\n'));

export function warmProcessInventory(): void {
  if (host || process.platform !== 'win32') return;
  host = spawn(existsSync(pwsh) ? pwsh : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  host.stderr.resume();
  host.stdin.on('error', error => channel.fail(error));
  exited = new Promise<void>(resolve => host!.once('exit', () => resolve()));
  host.on('error', error => { rejectReady(error); channel.fail(error); });
  host.on('exit', () => {
    const error = new Error('Process inventory host exited'); rejectReady(error); channel.fail(error);
  });
  createInterface({ input: host.stdout }).on('line', line => {
    if (line === 'ready') resolveReady(); else channel.accept(line);
  });
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  reportCleanupProgress();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Process inventory exceeded its deadline')), CLEANUP_LIMIT_MS);
  })]); } finally { clearTimeout(timer); }
}

/** Full snapshots supply ancestry; targeted native reads supply identity only (parent=0). */
export async function processInventory(pid?: number): Promise<ProcessEntry[]> {
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Invalid process ID');
  warmProcessInventory();
  if (host) {
    try { await bounded(ready); } catch (error) { channel.fail(error as Error); throw error; }
    return channel.request(pid);
  }
  const args = pid === undefined ? ['-eo', 'pid=,ppid=,lstart=,comm='] : ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,comm='];
  let stdout: string;
  try { ({ stdout } = await execute('ps', args, { timeout: CLEANUP_LIMIT_MS, env: { ...process.env, LC_ALL: 'C' } })); }
  catch (error) { if (pid !== undefined && (error as { code?: number; stdout?: string }).code === 1 && !(error as { stdout?: string }).stdout?.trim()) return []; throw error; }
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(line);
    if (!match || !Number.isFinite(Date.parse(match[3]))) throw new Error('POSIX process birth time unavailable');
    return { pid: Number(match[1]), parent: Number(match[2]), name: match[4].split('/').pop()!, created: String(Date.parse(match[3])) };
  });
}

export async function stopProcessInventory(): Promise<void> {
  if (!host) return;
  const child = host;
  await closeOwnedResource(`Process inventory host pid ${child.pid}`, async () => {
    child.stdin.end(); await exited;
  }, async () => {
    // ChildProcess.kill uses its owned native handle, not Playwright's PID/shell fallback.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }, () => exited);
}

function birth(entry: ProcessEntry): bigint {
  // Missing metadata fails closed on every platform, including older POSIX inventories.
  if (!/^\d+$/.test(entry.created)) throw new Error(`Creation time unavailable for ${entry.name} pid ${entry.pid}`);
  return BigInt(entry.created);
}
export function sameProcess(recorded: ProcessEntry, current: ProcessEntry | undefined): boolean {
  birth(recorded);
  if (!current) return false;
  birth(current);
  return recorded.pid === current.pid && recorded.created === current.created;
}
function descendantsOf(root: ProcessEntry, rows: ProcessEntry[], diagnoseMissingParent = false): ProcessEntry[] {
  birth(root);
  const current = rows.find(row => row.pid === root.pid);
  if (!current && !diagnoseMissingParent) return [];
  if (current && !sameProcess(root, current)) return [];
  const descendants = new Map([[root.pid, root]]);
  let previous = 0;
  while (previous !== descendants.size) {
    previous = descendants.size;
    for (const row of rows) {
      const parent = descendants.get(row.parent);
      if (parent && !descendants.has(row.pid) && birth(row) >= birth(parent)) descendants.set(row.pid, row);
    }
  }
  return rows.filter(row => descendants.has(row.pid) && row.pid !== root.pid);
}
export function ownedProcesses(root: number | ProcessEntry, rows: ProcessEntry[]): ProcessEntry[] {
  const identity = typeof root === 'number' ? rows.find(row => row.pid === root) : root;
  if (!identity) throw new Error(`Process root ${root} is missing from the ownership inventory`);
  const descendants = descendantsOf(identity, rows);
  const resources = descendants.filter(row => /^(chrome(?:[-_].*)?|chromium(?:[-_].*)?|headless_shell|workerd)(\.exe)?$/i.test(row.name));
  return mergeOwnedProcesses(resources, ...resources.map(row => descendantsOf(row, rows)));
}
export function mergeOwnedProcesses(...groups: ProcessEntry[][]): ProcessEntry[] {
  return [...new Map(groups.flat().map(row => [`${row.pid}:${row.created}`, row])).values()];
}
export function remainingOwnedProcesses(owned: ProcessEntry[], rows: ProcessEntry[]): ProcessEntry[] {
  const remaining: ProcessEntry[][] = [owned.filter(before => sameProcess(before, rows.find(now => now.pid === before.pid)))];
  for (const before of owned) remaining.push(descendantsOf(before, rows));
  return mergeOwnedProcesses(...remaining);
}

/** Unknown children of an exited parent are ambiguous, never authority to send a signal. */
function unverifiedLineage(owned: ProcessEntry[], rows: ProcessEntry[]): ProcessEntry[] {
  const known = new Set(remainingOwnedProcesses(owned, rows).map(row => `${row.pid}:${row.created}`));
  return mergeOwnedProcesses(...owned.map(root => descendantsOf(root, rows, true)))
    .filter(row => !known.has(`${row.pid}:${row.created}`));
}

/** Windows comparison and kill share the same held handle in the existing host. */
export async function terminateWindowsProcess(entry: ProcessEntry): Promise<TerminationResult> {
  birth(entry);
  if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0) throw new Error('Invalid process ID');
  if (process.platform !== 'win32') throw new Error('Held-handle termination requires Windows');
  warmProcessInventory();
  try { await bounded(ready); } catch (error) { channel.fail(error as Error); throw error; }
  return channel.terminate(entry);
}

/** Windows is handle-bound. POSIX retains its non-atomic fresh-check/PID-signal path. */
export async function terminateProcessTree(root: ProcessEntry, rows: ProcessEntry[],
  { inventory = processInventory, terminate, platform = process.platform, heldTerminate = terminateWindowsProcess }:
  { inventory?: Inventory; terminate?: (pid: number) => void; platform?: NodeJS.Platform;
    heldTerminate?: (entry: ProcessEntry) => Promise<TerminationResult> } = {}): Promise<void> {
  const failures: Error[] = [];
  for (const target of [...descendantsOf(root, rows).reverse(), root]) {
    try {
      if (platform === 'win32' && !terminate) {
        await heldTerminate(target);
      } else if (sameProcess(target, (await inventory(target.pid)).find(row => row.pid === target.pid))) {
        if (terminate) terminate(target.pid); else process.kill(target.pid, 'SIGKILL');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(new Error(`Could not terminate owned ${target.name} pid ${target.pid}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Owned process termination failed');
}

export async function isProcessAlive(entry: ProcessEntry,
  { inventory = processInventory, probe = (pid: number) => { process.kill(pid, 0); } }:
  { inventory?: Inventory; probe?: (pid: number) => void } = {}): Promise<boolean> {
  if (!sameProcess(entry, (await inventory(entry.pid)).find(row => row.pid === entry.pid))) return false;
  try { probe(entry.pid); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
export async function waitForProcessExit(entry: ProcessEntry, limitMs = CLEANUP_LIMIT_MS, alive: Alive = isProcessAlive): Promise<void> {
  reportCleanupProgress();
  const end = performance.now() + limitMs;
  while (await alive(entry)) {
    if (performance.now() >= end) throw new Error(`Owned ${entry.name} pid ${entry.pid} is still alive`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
export async function waitForProcessesExit(entries: ProcessEntry[], wait = waitForProcessExit): Promise<void> {
  const results = await Promise.allSettled(entries.map(entry => wait(entry)));
  const errors = results.flatMap((result, index) => result.status === 'rejected'
    ? [new Error(`${entries[index].name} pid ${entries[index].pid} exit is unverified`, { cause: result.reason })] : []);
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
}
export async function verifyProcessesGone(owned: ProcessEntry[], rows: ProcessEntry[], alive: Alive = isProcessAlive): Promise<void> {
  const remaining = remainingOwnedProcesses(owned, rows);
  const uncertain = unverifiedLineage(owned, rows);
  const candidates = mergeOwnedProcesses(remaining, uncertain);
  const results = await Promise.allSettled(candidates.map(entry => alive(entry)));
  const failures = results.flatMap((result, index) => result.status === 'rejected' || result.value
    ? [new Error(`${candidates[index].name} pid ${candidates[index].pid} remains live or unverified${uncertain.includes(candidates[index]) ? ' (ownership lineage unverified)' : ''}`, { cause: result.status === 'rejected' ? result.reason : undefined })] : []);
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('; '));
}

export async function closeWorkerProcesses(close: () => Promise<unknown>, owned: ProcessEntry[] | undefined,
  { inventory = processInventory, terminate = terminateProcessTree, wait = waitForProcessesExit, limitMs = CLEANUP_LIMIT_MS } = {}): Promise<void> {
  const workers = owned?.filter(row => /^workerd(\.exe)?$/i.test(row.name));
  await closeOwnedResource('Local Worker', close, async () => {
    if (!workers) throw new Error('Local Worker ownership inventory is unavailable');
    const rows = await inventory();
    const targets = remainingOwnedProcesses(workers, rows);
    const results = await Promise.allSettled(targets.map(worker => terminate(worker, rows)));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Worker process termination failed');
    await wait(targets);
  }, async () => {
    if (!workers) throw new Error('Local Worker exit cannot be verified without its ownership inventory');
    await wait(workers);
  }, limitMs);
}
