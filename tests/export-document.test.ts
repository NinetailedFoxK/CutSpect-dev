import { describe, expect, it } from 'vitest';
import type { ExportRequest, ProjectMedia, ProjectSnapshot, StructureNode } from '../src/shared/api-types';
import { createInitialSnapshot } from '../src/shared/schema';
import { createStructureNode } from '../src/shared/structure';
import {
  buildExportDocument,
  frameSafetyOffset,
  shotFrameTime,
} from '../src/shared/export-document';
import {
  DEFAULT_FRAME_SETTINGS,
  DEFAULT_LAYOUT_SETTINGS,
  DEFAULT_TABLE_FIELDS,
  DEFAULT_EXPORT_MODULES,
} from '../src/shared/export-config';

/**
 * 导出文档构建测试（规格 13 重设计：与当前曲线/标注/三级结构一致）。
 */

const DURATION = 10_000;

const MEDIA: ProjectMedia = {
  id: 'm',
  originalName: 'a.mp4',
  sourcePath: 'media/a.mp4',
  playbackPath: null,
  sha256: '0'.repeat(64),
  sizeBytes: 1024 * 1024,
  durationMs: DURATION,
  width: 1920,
  height: 1080,
  videoCodec: 'h264',
  audioCodec: 'aac',
  avgFrameRate: { num: 30, den: 1 },
  isVfr: false,
  isHdr: false,
};

function node(
  id: string,
  level: StructureNode['level'],
  parentId: string | null,
  name: string,
  startMs: number,
  note = '',
): StructureNode {
  return createStructureNode({ id, level, parentId, name, startMs, note });
}

function sampleSnapshot(): ProjectSnapshot {
  const base = createInitialSnapshot({ projectId: 'p', name: '测试项目', media: MEDIA });
  const structure: StructureNode[] = [
    node('A', 'chapter', null, '开头', 0),
    node('A1', 'section', 'A', '人物出场', 0),
    node('A2', 'section', 'A', '抛出问题', 5000, '转折前铺垫'),
    node('A1a', 'shot', 'A1', '镜头 01', 0),
    node('A1b', 'shot', 'A1', '镜头 02', 2000),
    node('A2a', 'shot', 'A2', '镜头 03', 5000),
  ];
  return {
    ...base,
    structure,
    curve: {
      ...base.curve,
      nodes: [
        { id: 'n1', timeMs: 0, value: 20, outMode: 'linear', inHandle: null, outHandle: null },
        { id: 'n2', timeMs: 5000, value: 80, outMode: 'linear', inHandle: null, outHandle: null },
        { id: 'n3', timeMs: DURATION, value: 30, outMode: 'linear', inHandle: null, outHandle: null },
      ],
    },
    annotations: [
      { id: 'an1', timeMs: 1000, title: '入场', body: '正文', labelOffset: { x: 0, y: 0 } },
    ],
  };
}

function request(scope: ExportRequest['scope']): ExportRequest {
  return {
    projectId: 'p',
    snapshot: sampleSnapshot(),
    kinds: ['pdf'],
    scope,
    modules: [...DEFAULT_EXPORT_MODULES],
    frames: { ...DEFAULT_FRAME_SETTINGS, includeShotFrame: true },
    table: { fields: [...DEFAULT_TABLE_FIELDS] },
    layout: { ...DEFAULT_LAYOUT_SETTINGS },
    zip: false,
    suggestedName: '测试项目-导出',
  };
}

describe('buildExportDocument - 范围解析', () => {
  it('整个项目：包含全部 3 个镜头，范围为全片', () => {
    const doc = buildExportDocument(request({ kind: 'project' }));
    expect(doc.range.startMs).toBe(0);
    expect(doc.range.endMs).toBe(DURATION);
    expect(doc.shots.map((s) => s.shotId)).toEqual(['A1a', 'A1b', 'A2a']);
    expect(doc.statistics.shotCount).toBe(3);
  });

  it('当前段落：只包含该段的镜头', () => {
    const doc = buildExportDocument(request({ kind: 'section', nodeIds: ['A2'] }));
    expect(doc.shots.map((s) => s.shotId)).toEqual(['A2a']);
    expect(doc.range.startMs).toBe(5000);
    expect(doc.range.endMs).toBe(DURATION);
  });

  it('选中镜头：只包含指定镜头', () => {
    const doc = buildExportDocument(request({ kind: 'shots', nodeIds: ['A1b'] }));
    expect(doc.shots.map((s) => s.shotId)).toEqual(['A1b']);
  });

  it('自定义时间范围：裁剪到 [startMs, endMs]', () => {
    const doc = buildExportDocument(request({ kind: 'timeRange', startMs: 2500, endMs: 6000 }));
    expect(doc.range.startMs).toBe(2500);
    expect(doc.range.endMs).toBe(6000);
    expect(doc.shots.map((s) => s.shotId)).toEqual(['A1b', 'A2a']);
  });
});

describe('buildExportDocument - 镜头行与曲线值', () => {
  it('镜头行含章/节/镜头名、起止时间码与时长', () => {
    const doc = buildExportDocument(request({ kind: 'project' }));
    const first = doc.shots[0];
    expect(first).toBeDefined();
    expect(first?.index).toBe(1);
    expect(first?.chapterName).toBe('开头');
    expect(first?.sectionName).toBe('人物出场');
    expect(first?.shotName).toBe('镜头 01');
    expect(first?.startMs).toBe(0);
    expect(first?.endMs).toBe(2000);
    expect(first?.durationMs).toBe(2000);
  });

  it('曲线起始/峰值/结束值取自镜头区间（线性 20→80）', () => {
    const doc = buildExportDocument(request({ kind: 'project' }));
    const first = doc.shots[0];
    expect(first?.curveStart).toBeCloseTo(21.2, 0);
    expect(first?.curveEnd).toBeCloseTo(42.8, 0);
    expect(first?.curvePeak).toBeCloseTo(42.8, 0);
  });

  it('标注摘要带入镜头区间内的标注标题', () => {
    const doc = buildExportDocument(request({ kind: 'project' }));
    expect(doc.shots[0]?.annotationSummary).toContain('入场');
  });

  it('统计数据聚合正确', () => {
    const doc = buildExportDocument(request({ kind: 'project' }));
    expect(doc.statistics.chapterCount).toBe(1);
    expect(doc.statistics.sectionCount).toBe(2);
    expect(doc.statistics.avgShotMs).toBe(Math.round((2000 + 3000 + 5000) / 3));
  });
});

describe('代表画面时间（避让硬切瞬间）', () => {
  it('中间帧取区间中点', () => {
    expect(shotFrameTime(node('s', 'shot', 'A1', 'x', 0), 0, 2000, 'middle')).toBe(1000);
  });

  it('首帧/尾帧内缩，不落在区间边界', () => {
    const shot = node('s', 'shot', 'A1', 'x', 0);
    const offset = frameSafetyOffset(2000);
    expect(offset).toBeGreaterThan(0);
    expect(shotFrameTime(shot, 0, 2000, 'first')).toBe(offset);
    expect(shotFrameTime(shot, 0, 2000, 'last')).toBe(2000 - offset);
  });

  it('封面帧优先使用镜头 coverTimeMs', () => {
    const shot: StructureNode = { ...node('s', 'shot', 'A1', 'x', 0), coverTimeMs: 1500 };
    expect(shotFrameTime(shot, 0, 2000, 'cover')).toBe(1500);
  });
});

describe('buildExportDocument - 大纲 / 备注 / 模块裁剪', () => {
  it('结构大纲覆盖范围内全部层级', () => {
    const doc = buildExportDocument(request({ kind: 'project' }));
    expect(doc.outline.filter((r) => r.level === 'chapter')).toHaveLength(1);
    expect(doc.outline.filter((r) => r.level === 'section')).toHaveLength(2);
    expect(doc.outline.filter((r) => r.level === 'shot')).toHaveLength(3);
  });

  it('备注收集非空 note', () => {
    const doc = buildExportDocument(request({ kind: 'project' }));
    expect(doc.notes.some((n) => n.name === '抛出问题' && n.note === '转折前铺垫')).toBe(true);
  });

  it('未启用代表画面时 frameTimeMs 为 null', () => {
    const base = request({ kind: 'project' });
    const doc = buildExportDocument({ ...base, frames: { ...base.frames, includeShotFrame: false } });
    expect(doc.shots.every((s) => s.frameTimeMs === null)).toBe(true);
  });
});