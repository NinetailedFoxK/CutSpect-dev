import { describe, expect, it } from 'vitest';
import type { ExportRequest, ProjectMedia, ProjectSnapshot } from '../src/shared/api-types';
import { createInitialSnapshot } from '../src/shared/schema';
import {
  DEFAULT_TABLE_FIELDS,
  EXPORT_FIELD_DEFS,
  EXPORT_KIND_DEFS,
  EXPORT_MODULE_DEFS,
  STANDARD_PDF_MODULES,
  STANDARD_XLSX_MODULES,
  applyTemplate,
  buildStandardRequest,
  resolveFrameWidth,
  toTemplate,
} from '../src/shared/export-config';

const MEDIA: ProjectMedia = {
  id: 'm',
  originalName: 'a.mp4',
  sourcePath: 'media/a.mp4',
  playbackPath: null,
  sha256: '0'.repeat(64),
  sizeBytes: 1024,
  durationMs: 10000,
  width: 1920,
  height: 1080,
  videoCodec: 'h264',
  audioCodec: 'aac',
  avgFrameRate: { num: 30, den: 1 },
  isVfr: false,
  isHdr: false,
};

function snapshot(): ProjectSnapshot {
  return createInitialSnapshot({ projectId: 'p', name: '项目', media: MEDIA });
}

describe('resolveFrameWidth（不超过源视频最高分辨率）', () => {
  it('标准 / 高清档按期望宽度取小', () => {
    expect(resolveFrameWidth('standard', 0, 1920)).toBe(960);
    expect(resolveFrameWidth('high', 0, 1920)).toBe(1920);
  });

  it('最高档不超过源视频宽度', () => {
    expect(resolveFrameWidth('max', 0, 1920)).toBe(1920);
    expect(resolveFrameWidth('max', 0, 1280)).toBe(1280);
  });

  it('用户自选上限生效且不高于源', () => {
    expect(resolveFrameWidth('high', 500, 1920)).toBe(500);
    expect(resolveFrameWidth('max', 4000, 1920)).toBe(1920);
  });
});

describe('标准导出预设', () => {
  const base = { projectId: 'p', snapshot: snapshot(), suggestedName: 'x', scope: { kind: 'project' } as const };

  it('阅读与分享 = PDF，含曲线/结构/分镜/标注模块', () => {
    const req = buildStandardRequest(base, 'pdf');
    expect(req.kinds).toEqual(['pdf']);
    expect(req.modules).toEqual(STANDARD_PDF_MODULES);
    expect(req.layout.template).toBe('table');
    expect(req.frames.includeShotFrame).toBe(true);
    expect(req.frames.includeCurveNodeFrames).toBe(true);
    expect(req.zip).toBe(false);
  });

  it('继续整理 = XLSX，含分镜表/曲线节点/标注/大纲', () => {
    const req = buildStandardRequest(base, 'xlsx');
    expect(req.kinds).toEqual(['xlsx']);
    expect(req.modules).toEqual(STANDARD_XLSX_MODULES);
    expect(req.layout.orientation).toBe('landscape');
  });
});

describe('模板导出与复用', () => {
  const request: ExportRequest = {
    ...buildStandardRequest(
      { projectId: 'p', snapshot: snapshot(), suggestedName: 'x', scope: { kind: 'project' } },
      'pdf',
    ),
    table: { fields: [...DEFAULT_TABLE_FIELDS] },
  };

  it('toTemplate 只保存范围类型，不保存具体节点', () => {
    const scoped: ExportRequest = { ...request, scope: { kind: 'section', nodeIds: ['A1'] } };
    const template = toTemplate(scoped, '我的模板', 't1');
    expect(template.scopeKind).toBe('section');
    expect(template.name).toBe('我的模板');
    expect('scope' in template).toBe(false);
  });

  it('applyTemplate 应用维度但保留当前具体范围节点', () => {
    const template = toTemplate({ ...request, scope: { kind: 'chapter', nodeIds: ['A'] } }, 't', 't2');
    const applied = applyTemplate({ ...request, scope: { kind: 'section', nodeIds: ['A1'] } }, template);
    expect(applied.scope.kind).toBe('chapter');
    expect(applied.scope.nodeIds).toEqual(['A1']);
    expect(applied.kinds).toEqual(template.kinds);
  });
});

describe('配置常量完整性', () => {
  it('包含全部输出格式与字段定义', () => {
    expect(EXPORT_KIND_DEFS.map((k) => k.id)).toEqual(['pdf', 'xlsx', 'png', 'json', 'markdown']);
    expect(EXPORT_FIELD_DEFS.some((f) => f.id === 'frame' && f.image)).toBe(true);
    expect(DEFAULT_TABLE_FIELDS).toContain('curvePeak');
    expect(EXPORT_MODULE_DEFS.map((m) => m.id)).toContain('statistics');
  });
});