import type {
  Annotation,
  ExportFrameSettings,
  ExportModuleId,
  ExportRequest,
  ExportScope,
  ExportTableSettings,
  ExportLayoutSettings,
  ProjectSnapshot,
  StructureNode,
} from './api-types';
import { formatTimeMs } from './time';
import { createCurveEvaluator } from './geometry';
import { migrateProjectSnapshot } from './schema';
import { sortAnnotations, titleFromBody } from './annotations';
import { sectionRanges } from './sections';
import {
  ancestorsOf,
  buildNumbering,
  deriveRanges,
  findNode,
  formatNumber,
  levelLabel,
} from './structure';

/**
 * 导出文档构建（规格 13 重设计）：把项目快照 + 导出请求解析成一份与当前
 * 曲线、标注、三级结构严格一致的「导出文档」，供 PDF / Excel / PNG / JSON
 * 各格式渲染共用。
 *
 * 纯函数（无 DOM / Node / Electron），可被 main 与 renderer 共用，vitest 直接覆盖。
 *
 * 时间一致性：
 * - 镜头起止时间一律来自三级结构的派生区间（deriveRanges），不另存 endMs；
 * - 曲线取值一律走 createCurveEvaluator，与编辑器同一套求值逻辑。
 */

/* ------------------------------------------------------------------ */
/* 结果类型                                                             */
/* ------------------------------------------------------------------ */

export interface ExportProjectInfo {
  name: string;
  originalName: string;
  /** 全片时长（整数毫秒）。 */
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  frameRateLabel: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  curveName: string;
  curveColor: string;
}

export interface ExportRange {
  startMs: number;
  endMs: number;
  /** 人类可读范围名（如「整个项目」「当前段落：开场」）。 */
  label: string;
}

/** 分镜表的一行（一个镜头一行）。 */
export interface ExportShotRow {
  /** 范围内序号（1 起）。 */
  index: number;
  /** 层级编号（如 1.1.1）。 */
  number: string;
  shotId: string;
  chapterName: string;
  sectionName: string;
  shotName: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  curveStart: number;
  curvePeak: number;
  curveEnd: number;
  annotationSummary: string;
  note: string;
  /** 代表画面建议时间（毫秒）；includeShotFrame=false 时为 null。 */
  frameTimeMs: number | null;
}

export interface ExportCurveNodeRow {
  index: number;
  timeMs: number;
  value: number;
}

export interface ExportAnnotationRow {
  index: number;
  timeMs: number;
  title: string;
  body: string;
  chapterName: string;
  sectionName: string;
  /** 标注时间点画面建议时间（毫秒）；未启用时为 null。 */
  frameTimeMs: number | null;
}

export interface ExportOutlineRow {
  number: string;
  level: 'chapter' | 'section' | 'shot';
  levelLabel: string;
  name: string;
  startMs: number;
  endMs: number;
  note: string;
}

export interface ExportNoteRow {
  number: string;
  levelLabel: string;
  name: string;
  note: string;
  startMs: number;
  endMs: number;
}

export interface ExportStatistics {
  chapterCount: number;
  sectionCount: number;
  shotCount: number;
  annotationCount: number;
  curveNodeCount: number;
  rangeDurationMs: number;
  avgShotMs: number;
  minShotMs: number;
  maxShotMs: number;
  /** 镜头密度（镜头数 / 分钟）。 */
  shotDensityPerMin: number;
  peakValue: number;
  minValue: number;
}

export interface ExportCurvePoint {
  timeMs: number;
  value: number;
}

export interface ExportDocument {
  info: ExportProjectInfo;
  range: ExportRange;
  scopeKind: ExportScope['kind'];
  modules: ExportModuleId[];
  frames: ExportFrameSettings;
  table: ExportTableSettings;
  layout: ExportLayoutSettings;
  /** 范围内节奏曲线采样点（相对时间，供绘图）。 */
  curvePoints: ExportCurvePoint[];
  shots: ExportShotRow[];
  curveNodes: ExportCurveNodeRow[];
  annotations: ExportAnnotationRow[];
  outline: ExportOutlineRow[];
  notes: ExportNoteRow[];
  statistics: ExportStatistics;
}

/* ------------------------------------------------------------------ */
/* 纯函数辅助                                                           */
/* ------------------------------------------------------------------ */

const clampTime = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** 画面规避偏移：代表画面不取在硬切/过渡瞬间，避开区间首尾一定比例。 */
export function frameSafetyOffset(durationMs: number): number {
  // 至少避开 1 帧（约 33ms），最多 200ms 或区间长度的 15%。
  return Math.min(200, Math.max(33, Math.round(durationMs * 0.15)));
}

/**
 * 计算镜头代表画面时间：按偏好取封面 / 首帧 / 中间帧 / 尾帧，
 * 首尾帧自动内缩避免落在硬切瞬间。
 */
export function shotFrameTime(
  shot: StructureNode,
  startMs: number,
  endMs: number,
  position: ExportFrameSettings['framePosition'],
): number {
  const span = Math.max(1, endMs - startMs);
  if (position === 'cover' && shot.coverTimeMs !== null) {
    return clampTime(Math.round(shot.coverTimeMs), startMs, Math.max(startMs, endMs - 1));
  }
  const offset = frameSafetyOffset(span);
  switch (position) {
    case 'first':
      return clampTime(startMs + offset, startMs, Math.max(startMs, endMs - 1));
    case 'last':
      return clampTime(endMs - offset, startMs, Math.max(startMs, endMs - 1));
    case 'middle':
    default:
      return clampTime(Math.round((startMs + endMs) / 2), startMs, Math.max(startMs, endMs - 1));
  }
}

/**
 * 采样区间内曲线值：返回起值、峰值、末值。
 * 起末各内缩一小段，避免落在镜头边界切点造成的跳变。
 */
export function sampleCurveInRange(
  evaluator: { at(timeMs: number): number },
  startMs: number,
  endMs: number,
): { start: number; peak: number; end: number } {
  const span = Math.max(1, endMs - startMs);
  const inner = Math.min(120, Math.max(0, Math.round(span * 0.05)));
  const s = startMs + inner;
  const e = Math.max(s, endMs - inner);
  const samples = Math.max(2, Math.min(64, Math.ceil((e - s) / 200)));
  let peak = 0;
  let min = 100;
  for (let i = 0; i <= samples; i++) {
    const t = s + ((e - s) * i) / samples;
    const v = evaluator.at(t);
    peak = Math.max(peak, v);
    min = Math.min(min, v);
  }
  const startValue = evaluator.at(s);
  const endValue = evaluator.at(e);
  return {
    start: startValue,
    peak: Math.max(peak, startValue, endValue),
    end: endValue,
  };
}

function frameRateLabel(num: number, den: number): string {
  if (!(num > 0) || !(den > 0)) {
    return '—';
  }
  const fps = num / den;
  return `${fps.toFixed(2).replace(/\.00$/, '')} fps`;
}

function sizeLabel(bytes: number): string {
  if (!(bytes > 0)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export { sizeLabel, frameRateLabel };

/* ------------------------------------------------------------------ */
/* 范围解析                                                             */
/* ------------------------------------------------------------------ */

interface ResolvedScope {
  startMs: number;
  endMs: number;
  label: string;
  /** shots 范围限定的镜头 id 集合；其余范围 null。 */
  shotIds: Set<string> | null;
}

function resolveScope(snapshot: ProjectSnapshot, scope: ExportScope): ResolvedScope {
  const durationMs = Math.max(1, snapshot.media.durationMs);
  const structure = snapshot.structure ?? [];
  const ranges = deriveRanges(structure, durationMs);
  const label = (kind: string): string => kind;

  switch (scope.kind) {
    case 'project':
      return { startMs: 0, endMs: durationMs, label: '整个项目', shotIds: null };
    case 'chapter': {
      const id = scope.nodeIds?.[0];
      const node = id !== undefined ? findNode(structure, id) : undefined;
      const range = id !== undefined ? ranges.get(id) : undefined;
      if (node !== undefined && range !== undefined) {
        return { startMs: range.startMs, endMs: range.endMs, label: `当前章：${node.name}`, shotIds: null };
      }
      return { startMs: 0, endMs: durationMs, label: '整个项目', shotIds: null };
    }
    case 'section': {
      const id = scope.nodeIds?.[0];
      const node = id !== undefined ? findNode(structure, id) : undefined;
      const range = id !== undefined ? ranges.get(id) : undefined;
      if (node !== undefined && range !== undefined) {
        return { startMs: range.startMs, endMs: range.endMs, label: `当前段落：${node.name}`, shotIds: null };
      }
      return { startMs: 0, endMs: durationMs, label: '整个项目', shotIds: null };
    }
    case 'shots': {
      const ids = scope.nodeIds ?? [];
      const set = new Set(ids);
      let min = Number.POSITIVE_INFINITY;
      let max = 0;
      for (const id of ids) {
        const r = ranges.get(id);
        if (r !== undefined) {
          min = Math.min(min, r.startMs);
          max = Math.max(max, r.endMs);
        }
      }
      if (!Number.isFinite(min) || max <= min) {
        return { startMs: 0, endMs: durationMs, label: '整个项目', shotIds: null };
      }
      return { startMs: min, endMs: max, label: `选中镜头（${ids.length} 个）`, shotIds: set };
    }
    case 'timeRange': {
      const startMs = clampTime(Math.round(scope.startMs ?? 0), 0, durationMs);
      const endMs = clampTime(Math.round(scope.endMs ?? durationMs), startMs + 1, durationMs);
      return {
        startMs,
        endMs,
        label: `自定义范围：${formatTimeMs(startMs)} — ${formatTimeMs(endMs)}`,
        shotIds: null,
      };
    }
    default:
      return { startMs: 0, endMs: durationMs, label: label('整个项目'), shotIds: null };
  }
}

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

export function buildExportDocument(request: ExportRequest): ExportDocument {
  const snapshot = migrateProjectSnapshot(request.snapshot);
  const { media, curve } = snapshot;
  const structure = snapshot.structure ?? [];
  const durationMs = Math.max(1, media.durationMs);
  const scope = resolveScope(snapshot, request.scope);
  const ranges = deriveRanges(structure, durationMs);
  const numbering = buildNumbering(structure);
  const evaluator = createCurveEvaluator(curve.nodes);
  const index = new Map(structure.map((node) => [node.id, node]));

  const nameOf = (id: string | null): string => {
    if (id === null) return '';
    return index.get(id)?.name ?? '';
  };
  const numberLabel = (id: string): string => formatNumber(numbering.get(id) ?? []);

  /* ---- 分镜表：范围内的镜头行 ---- */
  const shotNodes = structure.filter((node) => node.level === 'shot');
  const shots: ExportShotRow[] = [];
  for (const shot of shotNodes) {
    const range = ranges.get(shot.id);
    if (range === undefined) continue;
    if (range.endMs <= scope.startMs || range.startMs >= scope.endMs) continue;
    if (scope.shotIds !== null && !scope.shotIds.has(shot.id)) continue;
    const section = shot.parentId !== null ? index.get(shot.parentId) : undefined;
    const chapterId = section?.parentId ?? null;
    const values = sampleCurveInRange(evaluator, range.startMs, range.endMs);
    const inRangeAnnotations = sortAnnotations(snapshot.annotations).filter(
      (a) => a.timeMs >= range.startMs && a.timeMs < range.endMs,
    );
    const summary = inRangeAnnotations
      .map((a) => (a.title.trim().length > 0 ? a.title.trim() : titleFromBody(a.body)))
      .filter((t) => t.length > 0)
      .join('；');
    shots.push({
      index: shots.length + 1,
      number: numberLabel(shot.id),
      shotId: shot.id,
      chapterName: nameOf(chapterId),
      sectionName: section?.name ?? '',
      shotName: shot.name,
      startMs: range.startMs,
      endMs: range.endMs,
      durationMs: range.endMs - range.startMs,
      curveStart: values.start,
      curvePeak: values.peak,
      curveEnd: values.end,
      annotationSummary: summary,
      note: shot.note,
      frameTimeMs: request.frames.includeShotFrame
        ? shotFrameTime(shot, range.startMs, range.endMs, request.frames.framePosition)
        : null,
    });
  }

  /* ---- 曲线节点：范围内节点 ---- */
  const curveNodes: ExportCurveNodeRow[] = curve.nodes
    .filter((node) => node.timeMs >= scope.startMs && node.timeMs <= scope.endMs)
    .map((node, i) => ({ index: i + 1, timeMs: node.timeMs, value: node.value }));

  /* ---- 标注：范围内标注 ---- */
  const annotations: ExportAnnotationRow[] = sortAnnotations(snapshot.annotations)
    .filter((a) => a.timeMs >= scope.startMs && a.timeMs <= scope.endMs)
    .map((a, i) => hydrateAnnotation(a, i, index, ranges));

  /* ---- 结构大纲 & 备注：范围内结构节点 ---- */
  const inScope = (node: StructureNode): boolean => {
    const range = ranges.get(node.id);
    if (range === undefined) return false;
    return range.endMs > scope.startMs && range.startMs < scope.endMs;
  };
  const outline: ExportOutlineRow[] = structure.filter(inScope).map((node) => {
    const range = ranges.get(node.id);
    return {
      number: numberLabel(node.id),
      level: node.level,
      levelLabel: levelLabel(node.level),
      name: node.name,
      startMs: range?.startMs ?? node.startMs,
      endMs: range?.endMs ?? durationMs,
      note: node.note,
    };
  });
  const notes: ExportNoteRow[] = outline
    .filter((row) => row.note.trim().length > 0)
    .map((row) => ({
      number: row.number,
      levelLabel: row.levelLabel,
      name: row.name,
      note: row.note,
      startMs: row.startMs,
      endMs: row.endMs,
    }));
  // 旧段落备注（当三级结构未携带时补充，保证与旧项目一致）。
  const legacyNotes: ExportNoteRow[] = sectionRanges(snapshot.boundaries, snapshot.sections)
    .filter(
      (r) =>
        r.section.note.trim().length > 0 &&
        r.endMs > scope.startMs &&
        r.startMs < scope.endMs &&
        !outline.some((row) => row.name === r.section.name && row.startMs === r.startMs),
    )
    .map((r) => ({
      number: '',
      levelLabel: '段落',
      name: r.section.name,
      note: r.section.note,
      startMs: r.startMs,
      endMs: r.endMs,
    }));
  const allNotes = [...notes, ...legacyNotes];

  /* ---- 曲线采样点（供绘图） ---- */
  const span = Math.max(1, scope.endMs - scope.startMs);
  const sampleCount = Math.max(2, Math.min(1200, Math.round(span / 100)));
  const curvePoints: ExportCurvePoint[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    const timeMs = scope.startMs + (span * i) / sampleCount;
    curvePoints.push({ timeMs, value: evaluator.at(timeMs) });
  }

  /* ---- 统计 ---- */
  const durations = shots.map((s) => s.durationMs);
  const avgShotMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  const values = curvePoints.map((p) => p.value);
  const statistics: ExportStatistics = {
    chapterCount: outline.filter((r) => r.level === 'chapter').length,
    sectionCount: outline.filter((r) => r.level === 'section').length,
    shotCount: shots.length,
    annotationCount: annotations.length,
    curveNodeCount: curveNodes.length,
    rangeDurationMs: span,
    avgShotMs,
    minShotMs: durations.length > 0 ? Math.min(...durations) : 0,
    maxShotMs: durations.length > 0 ? Math.max(...durations) : 0,
    shotDensityPerMin: span > 0 ? (shots.length * 60_000) / span : 0,
    peakValue: Math.round(values.length > 0 ? Math.max(...values) : 0),
    minValue: Math.round(values.length > 0 ? Math.min(...values) : 0),
  };

  const info: ExportProjectInfo = {
    name: snapshot.name,
    originalName: media.originalName,
    durationMs,
    width: media.width,
    height: media.height,
    videoCodec: media.videoCodec,
    audioCodec: media.audioCodec,
    frameRateLabel: frameRateLabel(media.avgFrameRate.num, media.avgFrameRate.den),
    sizeBytes: media.sizeBytes,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    curveName: curve.name,
    curveColor: curve.color,
  };

  return {
    info,
    range: { startMs: scope.startMs, endMs: scope.endMs, label: scope.label },
    scopeKind: request.scope.kind,
    modules: request.modules,
    frames: request.frames,
    table: request.table,
    layout: request.layout,
    curvePoints,
    shots,
    curveNodes,
    annotations,
    outline,
    notes: allNotes,
    statistics,
  };
}

function hydrateAnnotation(
  annotation: Annotation,
  index: number,
  nodes: Map<string, StructureNode>,
  ranges: Map<string, { startMs: number; endMs: number }>,
): ExportAnnotationRow {
  // 归属：沿 shot → section → chapter 向上追溯，取时间点所在的最近包含结构。
  let owningSection = '';
  let owningChapter = '';
  for (const node of nodes.values()) {
    const range = ranges.get(node.id);
    if (range === undefined) continue;
    if (annotation.timeMs < range.startMs || annotation.timeMs >= range.endMs) continue;
    if (node.level === 'section') owningSection = node.name;
    if (node.level === 'chapter') owningChapter = node.name;
  }
  return {
    index,
    timeMs: annotation.timeMs,
    title: annotation.title.trim().length > 0 ? annotation.title : titleFromBody(annotation.body),
    body: annotation.body,
    chapterName: owningChapter,
    sectionName: owningSection,
    frameTimeMs: null,
  };
}

/** 供结构归属查询的外层封装（导出选项/估算可能复用）。 */
export function structureAncestors(structure: StructureNode[], id: string): StructureNode[] {
  return ancestorsOf(structure, id);
}