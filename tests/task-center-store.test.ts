import { describe, expect, it } from 'vitest';
import {
  createTaskCenterStore,
  isActiveStatus,
  isFinishedStatus,
  TASK_KIND_LABEL,
} from '../src/renderer/feedback/task-center-store';
import type { TaskCenterStore } from '../src/renderer/feedback/task-center-store';
import type { TaskEvent, TaskKind, TaskStatus } from '../src/shared/api-types';

/**
 * 后台任务中心测试（批次 1 基础设施）。
 * 覆盖：事件合并为条目、announce 覆盖名称/重试、失败保留重试、
 * dismiss/clearFinished、状态判定与中文名称。
 */

function makeEvent(
  taskId: string,
  kind: TaskKind,
  status: TaskStatus,
  extra: Partial<TaskEvent> = {},
): TaskEvent {
  return {
    taskId,
    kind,
    status,
    projectId: 'p1',
    progress: null,
    message: null,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

/** 接管 store 的事件源，返回可主动推送事件的函数。 */
function connect(store: TaskCenterStore): (event: TaskEvent) => void {
  const listeners: Array<(event: TaskEvent) => void> = [];
  store.attachSource({
    subscribe(listener) {
      listeners.push(listener);
      return () => undefined;
    },
  });
  return (event) => {
    listeners.forEach((listener) => listener(event));
  };
}

describe('createTaskCenterStore（任务中心）', () => {
  it('attachSource：同一 taskId 的事件合并为一条，最新状态与进度保留', () => {
    const store = createTaskCenterStore();
    const push = connect(store);
    push(makeEvent('t1', 'thumbnails', 'running', { progress: { kind: 'step', step: '生成缩略图 3/10' } }));
    push(makeEvent('t1', 'thumbnails', 'succeeded'));
    const entries = store.getSnapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('succeeded');
  });

  it('announce 先于事件：事件到达后保留已登记的名称与重试', () => {
    const store = createTaskCenterStore();
    const push = connect(store);
    const retry = (): void => undefined;
    store.announce({ taskId: 't2', label: '生成封面', retry });
    push(makeEvent('t2', 'thumbnails', 'failed', { message: '磁盘不足' }));

    const entry = store.getSnapshot().find((e) => e.taskId === 't2');
    expect(entry?.label).toBe('生成封面');
    expect(entry?.message).toBe('磁盘不足');
    expect(entry?.retry).toBe(retry);
  });

  it('未登记的任务使用种类默认中文名', () => {
    const store = createTaskCenterStore();
    const push = connect(store);
    push(makeEvent('t3', 'convert', 'running'));
    expect(store.getSnapshot()[0]?.label).toBe(TASK_KIND_LABEL.convert);
  });

  it('dismiss 移除指定任务；clearFinished 只清已结束任务', () => {
    const store = createTaskCenterStore();
    const push = connect(store);
    push(makeEvent('run', 'copy', 'running'));
    push(makeEvent('done', 'probe', 'succeeded'));
    push(makeEvent('fail', 'probe', 'failed'));

    store.clearFinished();
    const remaining = store.getSnapshot();
    expect(remaining.map((e) => e.taskId)).toEqual(['run']);

    store.dismiss('run');
    expect(store.getSnapshot()).toEqual([]);
  });

  it('状态判定：queued/running 为进行中，终态为已结束', () => {
    expect(isActiveStatus('queued')).toBe(true);
    expect(isActiveStatus('running')).toBe(true);
    expect(isActiveStatus('succeeded')).toBe(false);
    expect(isFinishedStatus('succeeded')).toBe(true);
    expect(isFinishedStatus('failed')).toBe(true);
    expect(isFinishedStatus('cancelled')).toBe(true);
    expect(isFinishedStatus('running')).toBe(false);
  });
});