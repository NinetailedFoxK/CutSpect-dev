import { describe, expect, it } from 'vitest';
import type {
  Annotation,
  Boundary,
  ProjectMedia,
  ProjectSnapshot,
  Section,
} from '../src/shared/api-types';
import {
  createInitialSnapshot,
  migrateProjectSnapshot,
  needsStructureMigration,
  validateProjectSnapshot,
} from '../src/shared/schema';
import { buildLegacyStructure, deriveRanges, validateStructure } from '../src/shared/structure';

/**
 * 旧单层项目 → 三级结构迁移测试（规格 3.3）。
 */

function makeMedia(durationMs = 10_000): ProjectMedia {
  return {
    id: 'media-1',
    originalName: 'clip.mp4',
    sourcePath: 'media/source.mp4',
    playbackPath: null,
    sha256: 'a'.repeat(64),
    sizeBytes: 2048,
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

/** 去掉三级结构并降回 v1，模拟旧项目。 */
function toLegacy(snapshot: ProjectSnapshot): ProjectSnapshot {
  const { structure: _structure, ...rest } = snapshot;
  void _structure;
  return { ...rest, schemaVersion: 1 } as ProjectSnapshot;
}

describe('buildLegacyStructure（旧分段 → 三级结构）', () => {
  const boundaries: Boundary[] = [
    { id: 'b-start', timeMs: 0, fixed: true, locked: true },
    { id: 'b-2', timeMs: 4000, fixed: false, locked: false },
    { id: 'b-end', timeMs: 10_000, fixed: true, locked: true },
  ];
  const sections: Section[] = [
    { id: 's1', startBoundaryId: 'b-start', name: '开头', note: '开场说明' },
    { id: 's2', startBoundaryId: 'b-2', name: '中段', note: '冲突升级' },
  ];

  it('生成 1 章节 + 2 段落 + 每段一个未划分镜头，且不变量成立', () => {
    const structure = buildLegacyStructure({
      projectId: 'p1',
      durationMs: 10_000,
      boundaries,
      sections,
    });
    expect(structure.filter((n) => n.level === 'chapter')).toHaveLength(1);
    expect(structure.filter((n) => n.level === 'section')).toHaveLength(2);
    expect(structure.filter((n) => n.level === 'shot')).toHaveLength(2);
    expect(validateStructure(structure, 10_000)).toEqual([]);

    const chapter = structure.find((n) => n.level === 'chapter')!;
    expect(chapter.name).toBe('完整视频');
    expect(chapter.parentId).toBeNull();

    const s1 = structure.find((n) => n.id === 's1')!;
    expect(s1.name).toBe('开头');
    expect(s1.note).toBe('开场说明');
    expect(s1.parentId).toBe(chapter.id);
    // 首段对应固定起点边界（locked），迁移保留锁定状态。
    expect(s1.locked).toBe(true);

    const s2 = structure.find((n) => n.id === 's2')!;
    expect(s2.startMs).toBe(4000);
    expect(s2.locked).toBe(false);

    const ranges = deriveRanges(structure, 10_000);
    expect(ranges.get(s2.id)).toEqual({ startMs: 4000, endMs: 10_000 });
  });
});

describe('migrateProjectSnapshot（幂等、无损）', () => {
  it('v1 项目迁移到 v2 并补齐三级结构', () => {
    const v2 = createInitialSnapshot({ projectId: 'p1', name: '项目', media: makeMedia() });
    const legacy = toLegacy(v2);
    const annotation: Annotation = {
      id: 'ann-1',
      timeMs: 3000,
      title: '标题',
      body: '正文',
      labelOffset: { x: 0, y: 0 },
    };
    const legacyWithAnnotation: ProjectSnapshot = { ...legacy, annotations: [annotation] };

    expect(needsStructureMigration(legacy)).toBe(true);
    const migrated = migrateProjectSnapshot(legacyWithAnnotation);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.structure).toBeDefined();
    expect(validateProjectSnapshot(migrated).ok).toBe(true);

    // 曲线、标注、边界、段落与视图必须保持不变。
    expect(migrated.curve).toEqual(legacyWithAnnotation.curve);
    expect(migrated.annotations).toEqual([annotation]);
    expect(migrated.boundaries).toEqual(legacyWithAnnotation.boundaries);
    expect(migrated.sections).toEqual(legacyWithAnnotation.sections);
    expect(migrated.view).toEqual(legacyWithAnnotation.view);
  });

  it('重复迁移不改变结果（幂等）', () => {
    const v2 = createInitialSnapshot({ projectId: 'p1', name: '项目', media: makeMedia() });
    const legacy = toLegacy(v2);
    const first = migrateProjectSnapshot(legacy);
    const second = migrateProjectSnapshot(first);
    expect(needsStructureMigration(first)).toBe(false);
    expect(second).toEqual(first);
    expect(JSON.stringify(second.structure)).toBe(JSON.stringify(first.structure));
  });

  it('已含三级结构且版本一致时原样返回', () => {
    const v2 = createInitialSnapshot({ projectId: 'p1', name: '项目', media: makeMedia() });
    expect(needsStructureMigration(v2)).toBe(false);
    expect(migrateProjectSnapshot(v2)).toBe(v2);
  });

  it('旧版本快照（无 structure）通过向后兼容校验', () => {
    const legacy = toLegacy(createInitialSnapshot({ projectId: 'p1', name: '项目', media: makeMedia() }));
    expect(validateProjectSnapshot(legacy).ok).toBe(true);
  });

  it('新项目初始快照自带三级结构且合法', () => {
    const v2 = createInitialSnapshot({ projectId: 'p1', name: '项目', media: makeMedia() });
    expect(v2.structure).toBeDefined();
    expect(validateStructure(v2.structure!, 10_000)).toEqual([]);
    expect(validateProjectSnapshot(v2).ok).toBe(true);
  });
});