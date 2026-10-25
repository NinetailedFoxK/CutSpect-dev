import { describe, expect, it } from 'vitest';
import { importReducer } from '../src/renderer/pages/ImportPage';
import type { ImportPhase } from '../src/renderer/pages/ImportPage';
import type { TaskEvent, TaskKind, TaskProgress, TaskStatus } from '../src/shared/api-types';

/**
 * 导入状态机测试（批次 1 新增"生成封面"阶段）。
 * 覆盖：复制/读取信息/生成封面/成功/失败各分支与终态幂等。
 */

function makeEvent(
  kind: TaskKind,
  status: TaskStatus,
  progress: TaskProgress | null = null,
): TaskEvent {
  return {
    taskId: `${kind}-task`,
    kind,
    status,
    projectId: 'p1',
    progress,
    message: null,
    updatedAt: new Date().toISOString(),
  };
}

function step(phase: ImportPhase): string {
  return phase.kind;
}

describe('importReducer（导入步骤状态机）', () => {
  it('copy bytes 进度 → copying', () => {
    const next = importReducer(
      { kind: 'waiting' },
      { type: 'event', event: makeEvent('copy', 'running', { kind: 'bytes', completedBytes: 5, totalBytes: 10 }) },
    );
    expect(step(next)).toBe('copying');
  });

  it('probe step 读取信息 → probing', () => {
    const next = importReducer(
      { kind: 'copy-done' },
      { type: 'event', event: makeEvent('probe', 'running', { kind: 'step', step: '读取视频信息' }) },
    );
    expect(step(next)).toBe('probing');
  });

  it('probe step 生成封面 → covering（本批新增阶段）', () => {
    const next = importReducer(
      { kind: 'probing', taskId: 'probe-task', progress: { kind: 'step', step: '读取视频信息' } },
      { type: 'event', event: makeEvent('probe', 'running', { kind: 'step', step: '生成封面' }) },
    );
    expect(step(next)).toBe('covering');
  });

  it('probe succeeded → succeeded（覆盖 covering 态）', () => {
    const next = importReducer(
      { kind: 'covering' },
      { type: 'event', event: makeEvent('probe', 'succeeded') },
    );
    expect(step(next)).toBe('succeeded');
  });

  it('失败 → failed 记录当时的步骤索引', () => {
    const next = importReducer(
      { kind: 'probing', taskId: 'probe-task', progress: null },
      { type: 'event', event: makeEvent('probe', 'failed') },
    );
    expect(next.kind).toBe('failed');
    if (next.kind === 'failed') {
      expect(next.stepIndex).toBe(2);
    }
  });

  it('终态幂等：成功后迟到的 running 事件不改状态', () => {
    const settled: ImportPhase = { kind: 'succeeded' };
    const next = importReducer(settled, {
      type: 'event',
      event: makeEvent('probe', 'running', { kind: 'step', step: '生成封面' }),
    });
    expect(next).toBe(settled);
  });
});