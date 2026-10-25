import { describe, expect, it } from 'vitest';
import type { ProjectMedia, ProjectSnapshot } from '../src/shared/api-types';
import { createInitialSnapshot } from '../src/shared/schema';
import { addAnnotation } from '../src/shared/annotations';
import { addBoundary, renameSection, setSectionNote } from '../src/shared/sections';
import { buildMarkdownExport } from '../src/shared/export-markdown';

/** Markdown 导出测试（规格 13.2：内容、归属、转义）。 */

function makeMedia(): ProjectMedia {
  return {
    id: 'm',
    originalName: '原视频.mp4',
    sourcePath: 'media/source.mp4',
    playbackPath: null,
    sha256: 'a'.repeat(64),
    sizeBytes: 1,
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

function buildFixture(): ProjectSnapshot {
  let snapshot = createInitialSnapshot({ projectId: 'p', name: '示例分析', media: makeMedia() });
  const added = addBoundary(snapshot.boundaries, snapshot.sections, 20_000, 'b1', 's2', 60_000);
  if (!added.ok) {
    throw new Error('addBoundary failed');
  }
  const leftId = snapshot.sections[0]?.id ?? '';
  let sections = renameSection(added.sections, leftId, '开场');
  sections = renameSection(sections, 's2', '高潮');
  sections = setSectionNote(sections, leftId, '开场备注');
  sections = setSectionNote(sections, 's2', '高潮备注');
  snapshot = { ...snapshot, boundaries: added.boundaries, sections };

  let anns = addAnnotation(snapshot.annotations, 30_000, 'n-late').annotations;
  anns = addAnnotation(anns, 10_000, 'n-early').annotations;
  snapshot = { ...snapshot, annotations: anns };
  return snapshot;
}

describe('buildMarkdownExport（规格 13.2）', () => {
  it('包含项目名、源文件、时长、曲线维度、段落与标注', () => {
    const md = buildMarkdownExport(buildFixture(), { generatedAt: '2026-10-24T00:00:00.000Z' });
    expect(md).toContain('# 拉片分析：示例分析');
    expect(md).toContain('- 源文件：原视频.mp4');
    expect(md).toContain('- 视频时长：01:00.000');
    expect(md).toContain('- 曲线维度：情绪强度');
    expect(md).toContain('- 分段数：2');
    expect(md).toContain('- 标注数：2');
    expect(md).toContain('### 1. 开场');
    expect(md).toContain('- 时间范围：00:00.000 — 00:20.000');
    expect(md).toContain('开场备注');
  });

  it('标注按时间升序，且给出所属段落（边界归右侧）', () => {
    const md = buildMarkdownExport(buildFixture());
    // 10 秒的标注属“开场”，30 秒的属“高潮”，且 10 秒在前。
    expect(md.indexOf('00:10.000')).toBeLessThan(md.indexOf('00:30.000'));
    expect(md).toContain('- 所属段落：开场');
    expect(md).toContain('- 所属段落：高潮');
  });

  it('转义特殊字符，避免破坏 Markdown 结构', () => {
    let snapshot = buildFixture();
    snapshot = {
      ...snapshot,
      annotations: [
        { id: 'x', timeMs: 5_000, title: '# 场景标题', body: '正文 *加粗* 与 `代码`\n1. 列表项', labelOffset: { x: 0, y: 0 } },
      ],
    };
    const md = buildMarkdownExport(snapshot);
    expect(md).toContain('\\# 场景标题');
    expect(md).toContain('\\*加粗\\*');
    expect(md).toContain('\\`代码\\`');
    // 行首有序列表被转义，不会自成一个列表项。
    expect(md).toContain('\\1. 列表项');
  });

  it('无标注/无正文时给出明确占位文本', () => {
    const snapshot = createInitialSnapshot({ projectId: 'e', name: '空', media: makeMedia() });
    const md = buildMarkdownExport(snapshot);
    expect(md).toContain('（无标注）');
    expect(md).toContain('（无备注）');
  });
});