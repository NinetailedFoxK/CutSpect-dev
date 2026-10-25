import { describe, expect, it } from 'vitest';
import { err, ok } from '../src/shared/api-types';
import { createSaveCoordinator } from '../src/renderer/editor/save-coordinator';

describe('createSaveCoordinator', () => {
  it('编辑发生在写入期间时串行保存最新快照和新 revision', async () => {
    let latest = { value: 1 };
    const calls: Array<{ value: number; revision: number }> = [];
    const states: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const queue = createSaveCoordinator({
      initialRevision: 4,
      readLatest: () => ({ ...latest }),
      write: async (snapshot, expectedRevision) => {
        calls.push({ value: snapshot.value, revision: expectedRevision });
        if (calls.length === 1) await firstGate;
        return ok({ revision: expectedRevision + 1 });
      },
      onState: (state) => states.push(state),
      onRevision: () => undefined,
    });

    queue.markDirty();
    const saving = queue.flush();
    latest = { value: 2 };
    queue.markDirty();
    releaseFirst();

    await expect(saving).resolves.toBe(true);
    expect(calls).toEqual([
      { value: 1, revision: 4 },
      { value: 2, revision: 5 },
    ]);
    expect(queue.isDirty()).toBe(false);
    expect(states.at(-1)).toBe('saved');
  });

  it('写入失败时保留 dirty 状态供重试，成功后再标记 saved', async () => {
    let attempts = 0;
    const states: string[] = [];
    const queue = createSaveCoordinator({
      initialRevision: 1,
      readLatest: () => ({ value: 3 }),
      write: async (_snapshot, expectedRevision) => {
        attempts += 1;
        return attempts === 1 ? err('IO', '磁盘暂时不可写') : ok({ revision: expectedRevision + 1 });
      },
      onState: (state) => states.push(state),
      onRevision: () => undefined,
    });

    queue.markDirty();
    await expect(queue.flush()).resolves.toBe(false);
    expect(queue.isDirty()).toBe(true);
    expect(states.at(-1)).toBe('error');

    await expect(queue.flush()).resolves.toBe(true);
    expect(queue.isDirty()).toBe(false);
    expect(states.at(-1)).toBe('saved');
  });

  it('失败回调携带错误（码/文案）；成功后回调最近保存时间（规格 10）', async () => {
    const errors: Array<{ code: string; message: string }> = [];
    const savedAt: number[] = [];
    let attempts = 0;
    const queue = createSaveCoordinator({
      initialRevision: 0,
      readLatest: () => ({ value: 1 }),
      write: async (_snapshot, expectedRevision) => {
        attempts += 1;
        return attempts === 1
          ? err('DISK_FULL', '磁盘空间不足，无法保存。', true)
          : ok({ revision: expectedRevision + 1 });
      },
      onState: () => undefined,
      onRevision: () => undefined,
      onError: (error) => errors.push({ code: error.code, message: error.message }),
      onSaved: (at) => savedAt.push(at),
    });

    queue.markDirty();
    await expect(queue.flush()).resolves.toBe(false);
    expect(errors).toEqual([{ code: 'DISK_FULL', message: '磁盘空间不足，无法保存。' }]);
    expect(savedAt).toHaveLength(0);

    await expect(queue.flush()).resolves.toBe(true);
    expect(savedAt).toHaveLength(1);
    expect(savedAt[0]).toBeGreaterThan(0);
  });
});
