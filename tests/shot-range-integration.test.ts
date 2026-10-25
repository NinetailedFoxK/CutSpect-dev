import { describe, expect, it } from 'vitest';
import { createHistory } from '../src/shared/history';
import { createInitialSnapshot, projectSnapshotSchema } from '../src/shared/schema';
import type { ProjectMedia, ProjectSnapshot } from '../src/shared/api-types';
import { childrenOf, deriveRanges, validateStructure } from '../src/shared/structure';
import { planShotsInRange } from '../src/shared/structure-shots';

/**
 * 局部智能分镜的“保存与撤销”闭环（需求 2.9 / 4.2）：
 * - 一次生成只产生一条撤销记录，Command+Z 一次恢复全部镜头；
 * - 结果接入项目快照，重新打开（schema 校验 + 反序列化）后镜头仍存在。
 */

function makeMedia(durationMs: number): ProjectMedia {
  return {
    id: 'media-1',
    originalName: 'a.mp4',
    sourcePath: 'media/source.mp4',
    playbackPath: null,
    sha256: 'a'.repeat(64),
    sizeBytes: 1000,
    durationMs,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    audioCodec: 'aac',
    avgFrameRate: { num: 30, den: 1 },
    isVfr: false,
    isHdr: false,
  };
}

function baseSnapshot(): ProjectSnapshot {
  const snapshot = createInitialSnapshot({
    projectId: 'p1',
    name: '测试项目',
    media: makeMedia(10_000),
    now: '2026-10-25T00:00:00.000Z',
  });
  return { ...snapshot, revision: 1 };
}

describe('局部智能分镜：保存与撤销闭环', () => {
  it('一次生成 → 一条撤销记录；撤销恢复原状、重做恢复结果', () => {
    const snapshot = baseSnapshot();
    const sectionId = 'p1-section-1';
    const before = childrenOf(snapshot.structure ?? [], sectionId, 'shot');
    expect(before).toHaveLength(1);

    const plan = planShotsInRange({
      structure: snapshot.structure ?? [],
      durationMs: snapshot.media.durationMs,
      parentId: sectionId,
      cutTimes: [2000, 5000, 7000],
      idSeed: 'sd',
    });
    expect(plan.ok).toBe(true);
    expect(validateStructure(plan.structure, snapshot.media.durationMs)).toEqual([]);

    const history = createHistory<ProjectSnapshot>(snapshot);
    const changed = history.commit({ ...snapshot, structure: plan.structure });
    expect(changed).toBe(true);
    expect(history.depth()).toBe(1);

    const after = childrenOf(history.present().structure ?? [], sectionId, 'shot');
    expect(after.map((s) => s.name)).toEqual(['镜头 1', '镜头 2', '镜头 3', '镜头 4']);
    expect(deriveRanges(history.present().structure ?? [], snapshot.media.durationMs).get(after[3]!.id)).toEqual({
      startMs: 7000,
      endMs: 10_000,
    });

    const undone = history.undo();
    expect(undone).not.toBeNull();
    expect(childrenOf(undone!.structure ?? [], sectionId, 'shot').map((s) => s.name)).toEqual(['未划分镜头']);
    expect(history.canUndo()).toBe(false);

    const redone = history.redo();
    expect(redone).not.toBeNull();
    expect(childrenOf(redone!.structure ?? [], sectionId, 'shot').map((s) => s.name)).toEqual([
      '镜头 1',
      '镜头 2',
      '镜头 3',
      '镜头 4',
    ]);
  });

  it('保存后 schema 校验通过，重新打开镜头仍存在', () => {
    const snapshot = baseSnapshot();
    const sectionId = 'p1-section-1';
    const plan = planShotsInRange({
      structure: snapshot.structure ?? [],
      durationMs: snapshot.media.durationMs,
      parentId: sectionId,
      cutTimes: [3000, 6000],
      idSeed: 'sd',
    });
    const saved: ProjectSnapshot = { ...snapshot, structure: plan.structure, revision: 2 };

    // 模拟落盘 → 重新打开：JSON 往返 + schema 校验。
    const roundTripped = JSON.parse(JSON.stringify(saved)) as unknown;
    const parsed = projectSnapshotSchema.safeParse(roundTripped);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const reopened = parsed.data as ProjectSnapshot;
    const shots = childrenOf(reopened.structure ?? [], sectionId, 'shot');
    expect(shots.map((s) => s.name)).toEqual(['镜头 1', '镜头 2', '镜头 3']);
    expect(deriveRanges(reopened.structure ?? [], reopened.media.durationMs).get(shots[0]!.id)).toEqual({
      startMs: 0,
      endMs: 3000,
    });
  });
});