import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireProjectLock,
  isProcessAlive,
  readProcessStartedAtMs,
  releaseProjectLock,
} from '../src/main/services/project-lock';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'laipian-lock-'));
  cleanups.push(dir);
  return dir;
}

function unusedPid(): number {
  for (let pid = 2_000_000_000; pid < 2_000_000_200; pid += 1) {
    if (!isProcessAlive(pid)) {
      return pid;
    }
  }
  throw new Error('找不到未使用的 pid');
}

describe('acquireProjectLock', () => {
  it('空目录可以独占创建，同一进程再次获取不改写别人的语义', async () => {
    const dir = await tempDir();
    const lockPath = path.join(dir, '.lock');
    const first = await acquireProjectLock(lockPath, new Date().toISOString());
    expect(first.ok).toBe(true);
    const raw = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number; startedAt: number };
    expect(raw.pid).toBe(process.pid);
    expect(typeof raw.startedAt).toBe('number');

    const second = await acquireProjectLock(lockPath, new Date().toISOString());
    expect(second.ok).toBe(true);
    await releaseProjectLock(lockPath);
    await expect(readFile(lockPath, 'utf8')).rejects.toThrow();
  });

  it('已退出进程的锁可以接管', async () => {
    const dir = await tempDir();
    const lockPath = path.join(dir, '.lock');
    await writeFile(
      lockPath,
      JSON.stringify({ pid: unusedPid(), at: new Date().toISOString(), startedAt: 1 }),
    );
    const result = await acquireProjectLock(lockPath, new Date().toISOString());
    expect(result.ok).toBe(true);
    const raw = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
    expect(raw.pid).toBe(process.pid);
  });

  it('存活的其他进程持有锁时不覆盖文件', async () => {
    const dir = await tempDir();
    const lockPath = path.join(dir, '.lock');
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const holderPid = holder.pid as number;
      const startedAt = await readProcessStartedAtMs(holderPid);
      expect(startedAt).not.toBeNull();
      const body = JSON.stringify({ pid: holderPid, at: new Date().toISOString(), startedAt });
      await writeFile(lockPath, body);
      const result = await acquireProjectLock(lockPath, new Date().toISOString());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PROJECT_LOCKED');
      }
      expect(await readFile(lockPath, 'utf8')).toBe(body);
    } finally {
      holder.kill();
    }
  });

  it('PID 仍存活但启动时间不一致时视为复用并接管', async () => {
    const dir = await tempDir();
    const lockPath = path.join(dir, '.lock');
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const holderPid = holder.pid as number;
      const actual = await readProcessStartedAtMs(holderPid);
      expect(actual).not.toBeNull();
      await writeFile(
        lockPath,
        JSON.stringify({ pid: holderPid, at: '2000-01-01T00:00:00.000Z', startedAt: 1 }),
      );
      const result = await acquireProjectLock(lockPath, new Date().toISOString());
      expect(result.ok).toBe(true);
      const raw = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
      expect(raw.pid).toBe(process.pid);
    } finally {
      holder.kill();
    }
  });
});
