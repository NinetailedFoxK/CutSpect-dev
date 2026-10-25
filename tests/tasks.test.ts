import { describe, expect, it } from 'vitest';
import { createTaskManager } from '../src/main/services/tasks';
import { err, ok } from '../src/shared/api-types';
import type { TaskEvent } from '../src/shared/api-types';

/**
 * 后台任务管理器测试（规格 10.4 / 12.3）。
 * 覆盖：状态机终态、真实进度事件、取消（signal 观察）、事件补齐快照。
 */

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor 超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('createTaskManager.run（状态机）', () => {
  it('成功：事件序列 queued→running…→succeeded，返回 ok 且 taskId 稳定', async () => {
    const tasks = createTaskManager();
    const events: TaskEvent[] = [];
    tasks.subscribe((event) => events.push(event));

    const result = await tasks.run({ kind: 'copy', projectId: 'p1' }, async (ctx) => {
      ctx.report({ kind: 'bytes', completedBytes: 5, totalBytes: 10 });
      return ok('done');
    });

    expect(result).toEqual({ ok: true, data: 'done' });
    expect(events.map((e) => e.status)).toEqual(['queued', 'running', 'running', 'succeeded']);
    const taskId = events[0]?.taskId;
    expect(events.every((e) => e.taskId === taskId)).toBe(true);
    expect(events.every((e) => e.projectId === 'p1')).toBe(true);
    expect(events[2]?.progress).toEqual({ kind: 'bytes', completedBytes: 5, totalBytes: 10 });
  });

  it('失败：返回 error → failed 事件带中文 message（项目无关为 null）', async () => {
    const tasks = createTaskManager();
    const events: TaskEvent[] = [];
    tasks.subscribe((event) => events.push(event));

    const result = await tasks.run({ kind: 'probe', projectId: null }, async () =>
      err('PROBE_FAILED', '读取媒体信息失败'),
    );

    expect(result.ok).toBe(false);
    const last = events[events.length - 1];
    expect(last?.status).toBe('failed');
    expect(last?.message).toBe('读取媒体信息失败');
    expect(last?.projectId).toBeNull();
  });

  it('运行体抛异常被折叠为 INTERNAL，任务不悬挂', async () => {
    const tasks = createTaskManager();
    const result = await tasks.run({ kind: 'probe', projectId: 'p' }, async () => {
      throw new Error('boom');
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
    }
  });
});

describe('createTaskManager.cancel（取消）', () => {
  it('取消置 cancelled 终态；cancel 对不存在任务返回 false', async () => {
    const tasks = createTaskManager();
    const events: TaskEvent[] = [];
    tasks.subscribe((event) => events.push(event));

    let runningTaskId: string | null = null;
    tasks.subscribe((event) => {
      if (event.status === 'running') {
        runningTaskId = event.taskId;
      }
    });

    const runPromise = tasks.run({ kind: 'copy', projectId: 'p2' }, async (ctx) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener('abort', () => resolve());
      });
      return err('CANCELLED', '复制已取消。');
    });

    await waitFor(() => runningTaskId !== null);
    expect(tasks.cancel('不存在的任务')).toBe(false);
    expect(tasks.cancel(runningTaskId ?? '')).toBe(true);

    const result = await runPromise;
    expect(result.ok).toBe(false);
    const last = events[events.length - 1];
    expect(last?.status).toBe('cancelled');
    expect(tasks.isRunning(runningTaskId ?? '')).toBe(false);
  });
});

describe('createTaskManager.snapshotForProject（事件补齐）', () => {
  it('返回该项目已发生的事件，按时间升序可重放到终态', async () => {
    const tasks = createTaskManager();
    await tasks.run({ kind: 'copy', projectId: 'p3' }, async (ctx) => {
      ctx.report({ kind: 'bytes', completedBytes: 1, totalBytes: 2 });
      return ok(null);
    });
    await tasks.run({ kind: 'probe', projectId: 'p3' }, async () => ok(null));
    await tasks.run({ kind: 'copy', projectId: 'other' }, async () => ok(null));

    const snapshot = tasks.snapshotForProject('p3');
    expect(snapshot.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.every((e) => e.projectId === 'p3')).toBe(true);
    // 最后一个事件是某个任务的 succeeded 终态。
    expect(snapshot[snapshot.length - 1]?.status).toBe('succeeded');
    // 时间升序。
    const times = snapshot.map((e) => e.updatedAt);
    expect([...times].sort()).toEqual(times);
    expect(tasks.snapshotForProject('nobody')).toEqual([]);
  });

  it('单个订阅者抛错不影响其余订阅者', async () => {
    const tasks = createTaskManager();
    const received: string[] = [];
    tasks.subscribe(() => {
      throw new Error('consumer failure');
    });
    tasks.subscribe((event) => {
      if (event.status === 'succeeded') {
        received.push(event.taskId);
      }
    });
    await tasks.run({ kind: 'probe', projectId: 'p' }, async () => ok(null));
    expect(received).toHaveLength(1);
  });
});