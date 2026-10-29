import { execFile } from 'node:child_process';
import { open, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { err, ok } from '../../shared/api-types';
import type { Result } from '../../shared/api-types';

/**
 * 项目级锁（规格 8.5）。
 *
 * 用 `open(path, 'wx')`（O_CREAT|O_EXCL）原子占有锁文件，避免「先读后写」的竞态。
 * 不用 rename 替换：替换不是互斥创建，两个进程可以同时认为自己拿到了锁。
 *
 * 锁内容含 pid 与进程启动时间。Windows 会很快复用 PID：只看 pid 存活会把
 * 已经退出的旧实例误判成仍占用。启动时间对不上则视为陈旧锁并接管。
 * 读不到对方启动时间时保持保守（存活即占用），避免误删别人的锁。
 */

const execFileAsync = promisify(execFile);

/** 本进程记录的启动时间与系统查询值允许的偏差（毫秒）。 */
export const LOCK_START_TOLERANCE_MS = 5_000;

const STEAL_ATTEMPTS = 5;
const READ_RETRIES = 5;
const READ_RETRY_MS = 40;

export interface ProjectLockPayload {
  pid: number;
  at: string;
  /** 进程启动时间（Unix 毫秒）。旧锁文件可能没有该字段。 */
  startedAt: number | null;
}

let cachedOwnStartedAt: number | null = null;

/** 当前进程启动时间的稳定近似值（首次调用后缓存）。 */
export function ownProcessStartedAtMs(): number {
  if (cachedOwnStartedAt === null) {
    cachedOwnStartedAt = Math.round(Date.now() - process.uptime() * 1000);
  }
  return cachedOwnStartedAt;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 读取其他进程的启动时间；失败返回 null（调用方不得据此抢走锁）。 */
export async function readProcessStartedAtMs(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (pid === process.pid) {
    return ownProcessStartedAtMs();
  }
  try {
    if (process.platform === 'linux') {
      return await linuxStartedAtMs(pid);
    }
    if (process.platform === 'darwin') {
      return await darwinStartedAtMs(pid);
    }
    if (process.platform === 'win32') {
      return await windowsStartedAtMs(pid);
    }
  } catch {
    return null;
  }
  return null;
}

async function linuxStartedAtMs(pid: number): Promise<number | null> {
  const [stat, procStat] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile('/proc/stat', 'utf8'),
  ]);
  const btimeLine = procStat.split('\n').find((line) => line.startsWith('btime '));
  const btime = Number(btimeLine?.slice('btime '.length));
  const close = stat.lastIndexOf(')');
  if (!Number.isFinite(btime) || close < 0) {
    return null;
  }
  // starttime 是 comm 字段之后的第 20 个字段（从 1 计），单位是时钟滴答。
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const startTicks = Number(fields[19]);
  if (!Number.isFinite(startTicks)) {
    return null;
  }
  const userHz = 100;
  return Math.round((btime + startTicks / userHz) * 1000);
}

async function darwinStartedAtMs(pid: number): Promise<number | null> {
  const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    timeout: 3000,
    env: { ...process.env, LC_ALL: 'C' },
  });
  const parsed = Date.parse(String(stdout).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

async function windowsStartedAtMs(pid: number): Promise<number | null> {
  const script =
    `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
    `[DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 8000, windowsHide: true },
  );
  const parsed = Number(String(stdout).trim());
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

async function readPayload(lockPath: string): Promise<ProjectLockPayload | null> {
  for (let attempt = 0; attempt < READ_RETRIES; attempt++) {
    let raw: string;
    try {
      raw = await readFile(lockPath, 'utf8');
    } catch {
      return null;
    }
    if (raw.trim().length === 0) {
      await delay(READ_RETRY_MS);
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown; at?: unknown; startedAt?: unknown };
      if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
        return null;
      }
      const startedAt =
        typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt) ? parsed.startedAt : null;
      return {
        pid: parsed.pid,
        at: typeof parsed.at === 'string' ? parsed.at : '',
        startedAt,
      };
    } catch {
      await delay(READ_RETRY_MS);
    }
  }
  return null;
}

/**
 * 对方是否仍持有锁。
 * 同一进程始终视为持有（PID 不可能在自己还活着时被复用）。
 */
export async function lockHolderOwns(payload: ProjectLockPayload): Promise<boolean> {
  if (!isProcessAlive(payload.pid)) {
    return false;
  }
  if (payload.pid === process.pid) {
    return true;
  }
  if (payload.startedAt === null) {
    return true;
  }
  const actual = await readProcessStartedAtMs(payload.pid);
  if (actual === null) {
    return true;
  }
  return Math.abs(actual - payload.startedAt) <= LOCK_START_TOLERANCE_MS;
}

async function tryCreateExclusive(
  lockPath: string,
  nowIso: string,
): Promise<'created' | 'exists' | { error: Result<string> }> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'EEXIST') {
      return 'exists';
    }
    return { error: err('IO', `无法写入项目锁：${(error as Error).message}`, true) };
  }
  try {
    const body = JSON.stringify({
      pid: process.pid,
      at: nowIso,
      startedAt: ownProcessStartedAtMs(),
    });
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    return { error: err('IO', `无法写入项目锁：${(error as Error).message}`, true) };
  }
  await handle.close();
  return 'created';
}

/** 原子获取项目锁。成功时 data 为锁文件路径。 */
export async function acquireProjectLock(lockPath: string, nowIso: string): Promise<Result<string>> {
  for (let attempt = 0; attempt < STEAL_ATTEMPTS; attempt++) {
    const created = await tryCreateExclusive(lockPath, nowIso);
    if (created === 'created') {
      return ok(lockPath);
    }
    if (created !== 'exists') {
      return created.error;
    }
    const payload = await readPayload(lockPath);
    if (payload !== null && (await lockHolderOwns(payload))) {
      if (payload.pid === process.pid) {
        return ok(lockPath);
      }
      return err(
        'PROJECT_LOCKED',
        `项目正被另一个程序（进程 ${payload.pid}）占用，请关闭后重试。`,
        true,
      );
    }
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
  return err('IO', '无法写入项目锁：多次尝试仍未独占锁文件。', true);
}

export async function releaseProjectLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true }).catch(() => undefined);
}
