import { describe, expect, it } from 'vitest';
import type { ExportRequest, ProjectMedia, ProjectSnapshot } from '../src/shared/api-types';
import { createInitialSnapshot } from '../src/shared/schema';
import { createStructureNode } from '../src/shared/structure';
import { buildExportDocument } from '../src/shared/export-document';
import {
  DEFAULT_EXPORT_MODULES,
  DEFAULT_FRAME_SETTINGS,
  DEFAULT_LAYOUT_SETTINGS,
  DEFAULT_TABLE_FIELDS,
} from '../src/shared/export-config';
import { buildChartHtml, buildCurveSvg, buildReportHtml, escapeHtml } from '../src/shared/export-html';
import { estimateExport } from '../src/shared/export-estimate';

const MEDIA: ProjectMedia = {
  id: 'm',
  originalName: '<script>a.mp4',
  sourcePath: 'media/a.mp4',
  playbackPath: null,
  sha256: '0'.repeat(64),
  sizeBytes: 2048,
  durationMs: 6000,
  width: 1920,
  height: 1080,
  videoCodec: 'h264',
  audioCodec: 'aac',
  avgFrameRate: { num: 30, den: 1 },
  isVfr: false,
  isHdr: false,
};

function makeRequest(modules = DEFAULT_EXPORT_MODULES): ExportRequest {
  const base = createInitialSnapshot({ projectId: 'p', name: '项目 <b>', media: MEDIA });
  const snapshot: ProjectSnapshot = {
    ...base,
    structure: [
      createStructureNode({ id: 'A', level: 'chapter', parentId: null, name: '开头', startMs: 0 }),
      createStructureNode({ id: 'A1', level: 'section', parentId: 'A', name: '段落 1', startMs: 0 }),
      createStructureNode({ id: 'A1a', level: 'shot', parentId: 'A1', name: '镜头 01', startMs: 0 }),
      createStructureNode({ id: 'A1b', level: 'shot', parentId: 'A1', name: '镜头 02', startMs: 3000 }),
    ],
  };
  return {
    projectId: 'p',
    snapshot,
    kinds: ['pdf'],
    scope: { kind: 'project' },
    modules,
    frames: { ...DEFAULT_FRAME_SETTINGS, includeShotFrame: true },
    table: { fields: [...DEFAULT_TABLE_FIELDS] },
    layout: { ...DEFAULT_LAYOUT_SETTINGS },
    zip: false,
    suggestedName: 'x',
  };
}

describe('escapeHtml', () => {
  it('转义结构字符', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
  });
});

describe('buildCurveSvg', () => {
  it('生成含路径的 SVG', () => {
    const svg = buildCurveSvg(
      [
        { timeMs: 0, value: 10 },
        { timeMs: 1000, value: 90 },
      ],
      { startMs: 0, endMs: 1000 },
    );
    expect(svg).toContain('<path');
    expect(svg).toContain('<svg');
  });
});

describe('buildReportHtml', () => {
  it('按模块渲染对应标题', () => {
    const doc = buildExportDocument(makeRequest());
    const html = buildReportHtml(doc, { generatedAt: '2026-01-01T00:00:00Z' });
    expect(html).toContain('项目信息');
    expect(html).toContain('分镜表');
    expect(html).toContain('结构大纲');
    expect(html).toContain('节奏曲线总览');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('未选模块不渲染', () => {
    const doc = buildExportDocument(makeRequest(['projectInfo']));
    const html = buildReportHtml(doc, {});
    expect(html).toContain('项目信息');
    expect(html).not.toContain('分镜表');
  });

  it('用户文本被转义（不注入标签）', () => {
    const doc = buildExportDocument(makeRequest());
    const html = buildReportHtml(doc, {});
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('画面缺失时显示占位而非路径', () => {
    const doc = buildExportDocument(makeRequest());
    const html = buildReportHtml(doc, {});
    expect(html).toContain('画面不可用');
  });
});

describe('buildChartHtml', () => {
  it('生成节奏谱页面', () => {
    const doc = buildExportDocument(makeRequest());
    const html = buildChartHtml(doc, {});
    expect(html).toContain('节奏谱');
    expect(html).toContain('<svg');
  });
});

describe('estimateExport', () => {
  it('PDF 估算给出非零页数与画面数', () => {
    const req = makeRequest();
    const estimate = estimateExport({
      snapshot: req.snapshot,
      kinds: req.kinds,
      scope: req.scope,
      modules: req.modules,
      frames: req.frames,
      table: req.table,
      layout: req.layout,
    });
    expect(estimate.pages).toBeGreaterThanOrEqual(1);
    expect(estimate.frameCount).toBe(2);
    expect(estimate.fileCount).toBe(1);
    expect(estimate.bytes).toBeGreaterThan(0);
  });
});