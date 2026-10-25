import { describe, expect, it } from 'vitest';
import type { ProjectMedia, ProjectSnapshot } from '../src/shared/api-types';
import { createInitialSnapshot } from '../src/shared/schema';
import { addAnnotation } from '../src/shared/annotations';
import { addBoundary } from '../src/shared/sections';
import { PNG_BASE_HEIGHT, PNG_WIDTH, buildPngExport, wrapTitle } from '../src/shared/export-png';

/** PNG 导出模型测试（规格 13.1：固定尺寸、坐标、索引、编号）。 */

function makeMedia(durationMs = 60_000): ProjectMedia {
  return {
    id: 'm',
    originalName: '原视频.mp4',
    sourcePath: 'media/source.mp4',
    playbackPath: null,
    sha256: 'a'.repeat(64),
    sizeBytes: 1,
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
  return createInitialSnapshot({ projectId: 'p', name: '示例', media: makeMedia() });
}

describe('buildPngExport 尺寸与坐标（规格 13.1）', () => {
  it('固定输出宽 2400、基础高 1000', () => {
    const model = buildPngExport(baseSnapshot());
    expect(model.width).toBe(PNG_WIDTH);
    expect(model.baseHeight).toBe(PNG_BASE_HEIGHT);
    expect(model.plot.width).toBe(2400 - 128);
    expect(model.plot.height).toBe(1000 - 110 - 90);
  });

  it('完整范围：曲线端点映射到绘图区左右边缘，值 50 映射到垂直中点', () => {
    const model = buildPngExport(baseSnapshot());
    const first = model.curvePoints[0];
    const last = model.curvePoints[model.curvePoints.length - 1];
    expect(first?.x).toBeCloseTo(model.plot.left, 3);
    expect(last?.x).toBeCloseTo(model.plot.left + model.plot.width, 3);
    // 默认曲线两端值 50 → y = top + 0.5*height。
    expect(first?.y).toBeCloseTo(model.plot.top + model.plot.height / 2, 3);
  });

  it('当前范围：只覆盖 [start,end]，时间位置正确', () => {
    const model = buildPngExport(baseSnapshot(), { startMs: 20_000, endMs: 40_000 });
    const first = model.curvePoints[0];
    const last = model.curvePoints[model.curvePoints.length - 1];
    expect(first?.x).toBeCloseTo(model.plot.left, 3);
    expect(last?.x).toBeCloseTo(model.plot.left + model.plot.width, 3);
    // 30 秒（区间中点）映射到绘图区中心。
    const midTicks = model.ticks.find((t) => t.timeMs === 30_000);
    if (midTicks) {
      expect(midTicks.x).toBeCloseTo(model.plot.left + model.plot.width / 2, 3);
    }
  });

  it('内部边界位置正确（跳过固定首尾），段落名居中于区间', () => {
    let snapshot = baseSnapshot();
    const added = addBoundary(snapshot.boundaries, snapshot.sections, 20_000, 'b1', 's2', 60_000);
    if (!added.ok) throw new Error('addBoundary failed');
    snapshot = { ...snapshot, boundaries: added.boundaries, sections: added.sections };
    const model = buildPngExport(snapshot);
    expect(model.boundaries).toHaveLength(1);
    expect(model.boundaries[0]?.x).toBeCloseTo(model.plot.left + (20_000 / 60_000) * model.plot.width, 3);
    // 段落 1 覆盖 [0,20s] → 名居中于 10s；段落 2 覆盖 [20s,60s] → 名居中于 40s。
    expect(model.sectionLabels).toHaveLength(2);
    expect(model.sectionLabels[0]?.x).toBeCloseTo(model.plot.left + (10_000 / 60_000) * model.plot.width, 3);
    expect(model.sectionLabels[1]?.x).toBeCloseTo(model.plot.left + (40_000 / 60_000) * model.plot.width, 3);
    expect(model.sectionLabels.every((label) => label.name.length > 0)).toBe(true);
  });
});

describe('buildPngExport 标注编号与索引（规格 13.1）', () => {
  it('标注按时间升序编号', () => {
    let snapshot = baseSnapshot();
    let anns = addAnnotation(snapshot.annotations, 40_000, 'late').annotations;
    anns = addAnnotation(anns, 10_000, 'early').annotations;
    snapshot = { ...snapshot, annotations: anns };
    const model = buildPngExport(snapshot);
    expect(model.annotations[0]?.index).toBe(1);
    expect(model.annotations[0]?.x).toBeLessThan(model.annotations[1]?.x ?? 0);
  });

  it('超过 100 条标注时索引只含前 100，并给出截断提示', () => {
    let snapshot = baseSnapshot();
    let anns = snapshot.annotations;
    for (let i = 0; i < 120; i++) {
      anns = addAnnotation(anns, i * 100, `t${i}`).annotations;
    }
    snapshot = { ...snapshot, annotations: anns };
    const model = buildPngExport(snapshot);
    expect(model.indexEntries).toHaveLength(100);
    expect(model.indexTruncated).toBe(true);
    expect(model.totalAnnotations).toBe(120);
    expect(model.overflowAnnotations).toBe(20);
    // 索引区增高（高度大于基础高）。
    expect(model.height).toBeGreaterThan(model.baseHeight);
  });

  it('无标注时索引为空且高度接近基础高', () => {
    const model = buildPngExport(baseSnapshot());
    expect(model.indexEntries).toHaveLength(0);
    expect(model.indexTruncated).toBe(false);
    expect(model.height).toBeGreaterThanOrEqual(model.baseHeight);
  });
});

describe('wrapTitle', () => {
  it('短标题不换行，长标题按字符数切分', () => {
    expect(wrapTitle('短')).toEqual(['短']);
    const lines = wrapTitle('x'.repeat(100));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('x'.repeat(100));
  });
});