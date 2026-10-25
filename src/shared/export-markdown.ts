import type { ProjectSnapshot } from './api-types';
import { formatTimeMs } from './time';
import { resolveSectionForTime, sectionRanges } from './sections';
import { sortAnnotations, titleFromBody } from './annotations';

/**
 * Markdown 分析笔记生成（规格 13.2）。
 *
 * 内容：项目名、源文件名、视频时长、曲线维度、段落起止时间与备注，
 * 以及按时间排序的全部标注标题、正文与所属段落。
 * 特殊字符转义，保证用户文本不会破坏 Markdown 结构；正文保持纯文本。
 *
 * 纯函数，无 DOM / Node 依赖，vitest 直接覆盖。
 */

/** 行内转义 Markdown 结构字符（反斜杠、反引号、强调、链接、尖括号）。 */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_\[\]<>])/g, '\\$1');
}

/** 行首结构字符（标题 #、引用 >、无序/有序列表）转义，避免破坏文档结构。 */
function escapeLineStructure(text: string): string {
  return text.replace(/^(\s*)(#{1,6}\s|>|[-+*]\s|\d+\.\s)/, (_m, indent: string, marker: string) => `${indent}\\${marker}`);
}

function escapeText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => escapeLineStructure(escapeInline(line)))
    .join('\n');
}

export interface MarkdownExportOptions {
  /** 生成时间（ISO）；省略则不写入该行。 */
  generatedAt?: string;
}

/**
 * 生成 Markdown 分析笔记。段落按时间升序；标注按时间升序并给出所属段落
 * （边界归属右侧段落，durationMs 归属最后一段，规格 13.2）。
 */
export function buildMarkdownExport(
  snapshot: ProjectSnapshot,
  options: MarkdownExportOptions = {},
): string {
  const { media, curve, boundaries, sections } = snapshot;
  const lines: string[] = [];

  lines.push(`# 拉片分析：${escapeText(snapshot.name)}`);
  lines.push('');
  lines.push(`- 源文件：${escapeText(media.originalName)}`);
  lines.push(`- 视频时长：${formatTimeMs(media.durationMs)}`);
  lines.push(`- 曲线维度：${escapeText(curve.name)}`);
  lines.push(`- 分段数：${sectionRanges(boundaries, sections).length}`);
  lines.push(`- 标注数：${snapshot.annotations.length}`);
  if (options.generatedAt !== undefined) {
    lines.push(`- 导出时间：${escapeText(options.generatedAt)}`);
  }
  lines.push('');

  // —— 段落 ——
  lines.push('## 段落');
  lines.push('');
  const ranges = sectionRanges(boundaries, sections);
  if (ranges.length === 0) {
    lines.push('（无段落）');
    lines.push('');
  } else {
    ranges.forEach((range, index) => {
      lines.push(`### ${index + 1}. ${escapeText(range.section.name)}`);
      lines.push('');
      lines.push(
        `- 时间范围：${formatTimeMs(range.startMs)} — ${formatTimeMs(range.endMs)}`,
      );
      lines.push('');
      lines.push(range.section.note.trim().length > 0 ? escapeText(range.section.note) : '（无备注）');
      lines.push('');
    });
  }

  // —— 标注 ——
  lines.push('## 标注');
  lines.push('');
  const annotations = sortAnnotations(snapshot.annotations);
  if (annotations.length === 0) {
    lines.push('（无标注）');
    lines.push('');
  } else {
    annotations.forEach((annotation, index) => {
      const title = annotation.title.trim().length > 0 ? annotation.title : titleFromBody(annotation.body);
      const display = title.length > 0 ? title : '（无标题）';
      lines.push(`### ${index + 1}. ${escapeText(display)} · ${formatTimeMs(annotation.timeMs)}`);
      lines.push('');
      const owning = resolveSectionForTime(boundaries, sections, annotation.timeMs);
      lines.push(`- 所属段落：${owning !== null ? escapeText(owning.name) : '—'}`);
      lines.push('');
      lines.push(annotation.body.trim().length > 0 ? escapeText(annotation.body) : '（无正文）');
      lines.push('');
    });
  }

  return lines.join('\n');
}