import { describe, expect, it } from 'vitest';
import type { ProjectMedia, ProjectSnapshot } from '../src/shared/api-types';
import { createInitialSnapshot, validateProjectSnapshot } from '../src/shared/schema';
import { addAnnotation, updateAnnotation } from '../src/shared/annotations';
import {
  addBoundary,
  mergeNotes,
  removeBoundary,
  renameSection,
  resolveSectionForTime,
  setSectionNote,
} from '../src/shared/sections';

/**
 * 阶段 C 文档级集成测试：分段（新增→重命名→合并）与标注（新增→编辑）操作
 * 串起来后，成品仍满足 schema 不变量（规格 11.3）与标注归属规则（规格 13.2）。
 */

function makeMedia(): ProjectMedia {
  return {
    id: 'media-1',
    originalName: '原视频.mp4',
    sourcePath: 'media/source.mp4',
    playbackPath: null,
    sha256: 'a'.repeat(64),
    sizeBytes: 1024,
    durationMs: 60_000,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    audioCodec: 'aac',
    avgFrameRate: { num: 30, den: 1 },
    isVfr: false,
    isHdr: false,
  };
}

describe('分段 + 标注串联后仍满足 schema（规格 7 / 6 / 11.3）', () => {
  it('新增边界、重命名、合并备注、加标注 → 校验通过且归属正确', () => {
    let snapshot: ProjectSnapshot = createInitialSnapshot({
      projectId: 'p1',
      name: '集成测试',
      media: makeMedia(),
    });

    // 新增边界（左段保留，右段默认名）。
    const added = addBoundary(snapshot.boundaries, snapshot.sections, 20_000, 'b1', 's2', 60_000);
    expect(added.ok).toBe(true);
    snapshot = { ...snapshot, boundaries: added.boundaries, sections: added.sections };

    // 重命名左右段并写备注（左段 id 由初始快照生成，右段用新增时传入的 id）。
    const leftId = snapshot.sections[0]?.id ?? '';
    let sections = renameSection(snapshot.sections, leftId, '开场');
    sections = renameSection(sections, 's2', '高潮');
    sections = setSectionNote(sections, leftId, '左段备注');
    sections = setSectionNote(sections, 's2', '右段备注');
    snapshot = { ...snapshot, sections };

    // 加两条标注。
    let anns = addAnnotation(snapshot.annotations, 10_000, 'n1').annotations;
    anns = addAnnotation(anns, 30_000, 'n2').annotations;
    const edited = updateAnnotation(anns, 'n1', { title: '铺垫', body: '第一段说明' });
    expect(edited.ok).toBe(true);
    anns = edited.annotations;
    snapshot = { ...snapshot, annotations: anns };

    // schema 校验通过。
    const validated = validateProjectSnapshot(snapshot);
    expect(validated.ok).toBe(true);

    // 归属：n1 属左段（开场），n2 属右段（高潮）。
    expect(resolveSectionForTime(snapshot.boundaries, snapshot.sections, 10_000)?.name).toBe('开场');
    expect(resolveSectionForTime(snapshot.boundaries, snapshot.sections, 30_000)?.name).toBe('高潮');

    // 删除边界合并：保留左段名，右段备注以分隔符并入。
    const removed = removeBoundary(snapshot.boundaries, snapshot.sections, 'b1');
    expect(removed.ok).toBe(true);
    expect(removed.sections[0]?.name).toBe('开场');
    expect(removed.sections[0]?.note).toBe(mergeNotes('左段备注', '右段备注'));
    const afterMerge = validateProjectSnapshot({ ...snapshot, boundaries: removed.boundaries, sections: removed.sections });
    expect(afterMerge.ok).toBe(true);
  });

  it('同一毫秒重复标注不新增（返回已有）', () => {
    const base = createInitialSnapshot({ projectId: 'p2', name: 'x', media: makeMedia() });
    const first = addAnnotation(base.annotations, 5_000, 'a');
    const dup = addAnnotation(first.annotations, 5_000, 'b');
    expect(first.created).toBe(true);
    expect(dup.created).toBe(false);
    expect(dup.existing?.id).toBe('a');
  });
});