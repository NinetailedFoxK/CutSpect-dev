import type { ProjectSnapshot } from './api-types';
import { clamp } from './time';
import { formatTimeMs } from './time';
import { createCurveEvaluator } from './geometry';
import { sectionRanges } from './sections';
import { sortAnnotations, titleFromBody } from './annotations';

/**
 * PNG 分析图导出模型（规格 13.1）。
 *
 * 只做“独立导出坐标计算”，产出绘制所需的位置与文本；真正的光栅化在
 * renderer 用 Canvas 完成（renderer/export/render-png.ts）。
 * 特点：
 * - 固定输出宽 2400、基础高 1000（可传 width/baseHeight 覆盖，便于测试）；
 * - 支持“完整视频”与“当前时间范围”两种范围；
 * - 底部追加编号与标题索引，按需增高；超过 100 条标注时索引只含前 100，
 *   并给出 indexTruncated/overflowAnnotations 供调用方提示；
 * - 不包含选择框、控制柄、播放头（由本模型不含这些元素保证）。
 *
 * 纯函数，无 DOM / Canvas 依赖，vitest 直接覆盖。
 */

export const PNG_WIDTH = 2400;
export const PNG_BASE_HEIGHT = 1000;
export const INDEX_LIMIT = 100;

const PLOT_LEFT = 64;
const PLOT_RIGHT = 64;
const PLOT_TOP = 110;
const PLOT_BOTTOM_RESERVED = 90;
const ENTRY_LINE_HEIGHT = 22;
const ENTRY_GAP = 6;
const TITLE_WRAP_CHARS = 46;
const INDEX_HEADER_GAP = 26;
const INDEX_ENTRIES_GAP = 24;

const TICK_STEPS_MS = [
  1_000, 5_000, 30_000, 60_000, 300_000, 600_000, 1_800_000, 3_600_000, 10_800_000,
] as const;
const MIN_TICK_SPACING_PX = 110;

export interface PngExportOptions {
  /** 起始时间（默认 0）。 */
  startMs?: number;
  /** 结束时间（默认 durationMs）。 */
  endMs?: number;
  width?: number;
  baseHeight?: number;
}

export interface PngTick {
  timeMs: number;
  x: number;
  label: string;
}

export interface PngBoundaryMark {
  x: number;
  locked: boolean;
}

/** 段落名标记（规格 7）：x 为该名在其「两边界之间」区间内的居中位置。 */
export interface PngSectionLabel {
  x: number;
  name: string;
}

export interface PngAnnotationMark {
  x: number;
  y: number;
  index: number;
  title: string;
}

export interface PngIndexEntry {
  index: number;
  timeLabel: string;
  title: string;
  y: number;
  lines: string[];
}

export interface PngExportModel {
  width: number;
  height: number;
  baseHeight: number;
  title: string;
  curveName: string;
  color: string;
  plot: { left: number; top: number; width: number; height: number };
  labelsY: number;
  range: { startMs: number; endMs: number };
  ticks: PngTick[];
  curvePoints: { x: number; y: number }[];
  boundaries: PngBoundaryMark[];
  sectionLabels: PngSectionLabel[];
  annotations: PngAnnotationMark[];
  indexHeaderY: number;
  indexEntries: PngIndexEntry[];
  indexTruncated: boolean;
  totalAnnotations: number;
  overflowAnnotations: number;
}

function chooseTickStep(spanMs: number, plotWidth: number): number {
  for (const step of TICK_STEPS_MS) {
    if (spanMs > 0 && (step / spanMs) * plotWidth >= MIN_TICK_SPACING_PX) {
      return step;
    }
  }
  return TICK_STEPS_MS[TICK_STEPS_MS.length - 1] ?? 10_800_000;
}

/** 按字符数贪婪换行（中文按单字切分，英文按空格优先）。 */
export function wrapTitle(text: string, maxChars = TITLE_WRAP_CHARS): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const lines: string[] = [];
  let current = '';
  for (const char of text) {
    current += char;
    if (current.length >= maxChars) {
      lines.push(current);
      current = '';
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [text];
}

/** 生成 PNG 导出的完整模型。 */
export function buildPngExport(snapshot: ProjectSnapshot, options: PngExportOptions = {}): PngExportModel {
  const width = options.width ?? PNG_WIDTH;
  const baseHeight = options.baseHeight ?? PNG_BASE_HEIGHT;
  const durationMs = Math.max(1, snapshot.media.durationMs);
  const startMs = clamp(Math.round(options.startMs ?? 0), 0, durationMs);
  const endMs = clamp(Math.round(options.endMs ?? durationMs), startMs + 1, durationMs);
  const span = endMs - startMs;

  const plotWidth = Math.max(1, width - PLOT_LEFT - PLOT_RIGHT);
  const plotHeight = Math.max(1, baseHeight - PLOT_TOP - PLOT_BOTTOM_RESERVED);
  const plot = { left: PLOT_LEFT, top: PLOT_TOP, width: plotWidth, height: plotHeight };

  const xOf = (timeMs: number): number =>
    plot.left + (span > 0 ? ((timeMs - startMs) / span) * plotWidth : 0);
  const yOf = (value: number): number => plot.top + (1 - clamp(value, 0, 100) / 100) * plotHeight;

  // 刻度。
  const step = chooseTickStep(span, plotWidth);
  const ticks: PngTick[] = [];
  const first = Math.ceil(startMs / step) * step;
  for (let t = first; t <= endMs; t += step) {
    ticks.push({ timeMs: t, x: xOf(t), label: formatTimeMs(t) });
  }

  // 曲线折线（按像素密度采样）。
  const evaluator = createCurveEvaluator(snapshot.curve.nodes);
  const sampleCount = Math.max(2, Math.min(4000, Math.ceil(plotWidth)));
  const curvePoints: { x: number; y: number }[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    const timeMs = startMs + (span * i) / sampleCount;
    curvePoints.push({ x: xOf(timeMs), y: yOf(evaluator.at(timeMs)) });
  }

  // 内部边界线（跳过固定首尾）。
  const ranges = sectionRanges(snapshot.boundaries, snapshot.sections);
  const boundaries: PngBoundaryMark[] = [];
  for (const boundary of snapshot.boundaries) {
    if (boundary.fixed || boundary.timeMs < startMs || boundary.timeMs > endMs) {
      continue;
    }
    boundaries.push({ x: xOf(boundary.timeMs), locked: boundary.locked });
  }

  // 段落名：每个段落居中显示在其「两边界之间」的区间内（与编辑器一致）；
  // 区间超出导出范围时，按可见部分取中点。
  const sectionLabels: PngSectionLabel[] = [];
  for (const range of ranges) {
    const visibleStart = Math.max(range.startMs, startMs);
    const visibleEnd = Math.min(range.endMs, endMs);
    if (visibleEnd <= visibleStart) {
      continue;
    }
    sectionLabels.push({ x: xOf((visibleStart + visibleEnd) / 2), name: range.section.name });
  }

  // 标注点（按时间升序编号）。
  const sorted = sortAnnotations(snapshot.annotations);
  const annotations: PngAnnotationMark[] = sorted.map((annotation, index) => ({
    x: xOf(annotation.timeMs),
    y: yOf(evaluator.at(annotation.timeMs)),
    index: index + 1,
    title: annotation.title.trim().length > 0 ? annotation.title : titleFromBody(annotation.body),
  }));

  // 底部索引（最多 100 条，超出时截断提示）。
  const totalAnnotations = sorted.length;
  const indexLimited = sorted.slice(0, INDEX_LIMIT);
  const labelsY = plot.top + plot.height + 22;
  const baseBottom = labelsY + 34;
  const indexHeaderY = baseBottom + INDEX_HEADER_GAP;
  let cursor = indexHeaderY + INDEX_ENTRIES_GAP;
  const indexEntries: PngIndexEntry[] = indexLimited.map((annotation, i) => {
    const title = annotation.title.trim().length > 0 ? annotation.title : titleFromBody(annotation.body);
    const lines = wrapTitle(title.length > 0 ? title : '（无标题）');
    const entry: PngIndexEntry = {
      index: i + 1,
      timeLabel: formatTimeMs(annotation.timeMs),
      title,
      y: cursor,
      lines,
    };
    cursor += lines.length * ENTRY_LINE_HEIGHT + ENTRY_GAP;
    return entry;
  });
  const height = cursor + 24;

  return {
    width,
    height,
    baseHeight,
    title: snapshot.name,
    curveName: snapshot.curve.name,
    color: snapshot.curve.color,
    plot,
    labelsY,
    range: { startMs, endMs },
    ticks,
    curvePoints,
    boundaries,
    sectionLabels,
    annotations,
    indexHeaderY,
    indexEntries,
    indexTruncated: totalAnnotations > INDEX_LIMIT,
    totalAnnotations,
    overflowAnnotations: Math.max(0, totalAnnotations - INDEX_LIMIT),
  };
}