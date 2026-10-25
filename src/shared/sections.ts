import type { Boundary, Section } from './api-types';

/**
 * 分段结构操作（规格 7：结构模型、增删、拖动、锁定、合并）。
 *
 * 不变量（与 schema 校验一致）：
 * - 首尾边界 fixed 且 locked，不可拖动/删除/解锁；
 * - 内部边界间隔 ≥ MIN_BOUNDARY_GAP_MS（100ms）；
 * - 段落与非终点边界一一对应，段落身份绑定“起点边界 ID”（移动边界不改变归属）；
 * - 段落名称是内容，插入前面的段落不重编号。
 *
 * 纯函数，返回新数组；所有编辑都维护上述不变量。
 */

export const MIN_BOUNDARY_GAP_MS = 100;
/** 删除边界合并段落时的备注分隔符（明确分隔，不丢文字，规格 7.2）。 */
export const NOTE_MERGE_SEPARATOR = '\n\n———\n\n';

/**
 * 智能镜头识别生成的边界 id 前缀（shot-apply 用）。
 * 监视器据此区分"镜头切点边界"与"用户手动段落边界"：
 * 大量镜头边界只在时间线显示，不全部延伸到分析监视器。
 */
export const SHOT_BOUNDARY_PREFIX = 'bnd-shot-';

/** 是否为镜头识别自动生成的边界。 */
export function isShotGeneratedBoundary(id: string): boolean {
  return id.startsWith(SHOT_BOUNDARY_PREFIX);
}

export interface SectionEdit {
  ok: boolean;
  /** 失败原因（面向创作者的中文提示）。 */
  message?: string;
  boundaries: Boundary[];
  sections: Section[];
}

export function sortBoundaries(boundaries: readonly Boundary[]): Boundary[] {
  return [...boundaries].sort((a, b) => a.timeMs - b.timeMs);
}

function endpoints(boundaries: readonly Boundary[]): { start: Boundary | undefined; end: Boundary | undefined } {
  const sorted = sortBoundaries(boundaries);
  return { start: sorted[0], end: sorted[sorted.length - 1] };
}

/** 非终点边界（每个对应一个段落），按时间升序。 */
export function sectionStartBoundaries(boundaries: readonly Boundary[]): Boundary[] {
  const sorted = sortBoundaries(boundaries);
  return sorted.slice(0, Math.max(0, sorted.length - 1));
}

/** 段落起止范围（末段终点为最后边界）。 */
export function sectionRanges(
  boundaries: readonly Boundary[],
  sections: readonly Section[],
): { section: Section; startMs: number; endMs: number }[] {
  const starts = sectionStartBoundaries(boundaries);
  const sorted = sortBoundaries(boundaries);
  const endBoundary = sorted[sorted.length - 1];
  const ranges: { section: Section; startMs: number; endMs: number }[] = [];
  for (const boundary of starts) {
    const section = sections.find((s) => s.startBoundaryId === boundary.id);
    if (!section) {
      continue;
    }
    const index = sorted.findIndex((b) => b.id === boundary.id);
    const next = sorted[index + 1];
    ranges.push({
      section,
      startMs: boundary.timeMs,
      endMs: next?.timeMs ?? endBoundary?.timeMs ?? boundary.timeMs,
    });
  }
  return ranges;
}

/**
 * 时间归属段落（规格 13.2）：
 * - 内部边界处归属**右侧**段落（即以该边界为起点的段落）；
 * - timeMs = durationMs 归属最后一段；
 * - 返回 null 表示没有可用段落（结构异常）。
 */
export function resolveSectionForTime(
  boundaries: readonly Boundary[],
  sections: readonly Section[],
  timeMs: number,
): Section | null {
  const starts = sectionStartBoundaries(boundaries);
  let matched: Boundary | undefined;
  for (const boundary of starts) {
    if (boundary.timeMs <= timeMs) {
      matched = boundary;
    } else {
      break;
    }
  }
  if (matched === undefined) {
    return null;
  }
  return sections.find((s) => s.startBoundaryId === matched?.id) ?? null;
}

/** 解析“段落 N”名称取最大序号，与新段数取较大值 +1（不重编号、不冲突，规格 7.1）。 */
export function nextSectionDefaultName(sections: readonly Section[]): string {
  let max = 0;
  for (const section of sections) {
    const match = /^段落\s*(\d+)$/.exec(section.name);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `段落 ${Math.max(max, sections.length) + 1}`;
}

/**
 * 以边界顺序为基准重建段落集合：保留已有 section 的 id/name/note，
 * 为缺失的非终点边界补新段（用于新增边界后）。保证一一对应且顺序一致。
 */
function rebuildSections(
  boundaries: readonly Boundary[],
  existing: readonly Section[],
  forNewBoundary: (boundary: Boundary) => Section | null,
): Section[] {
  const nonEnd = sectionStartBoundaries(boundaries);
  const byBoundaryId = new Map(existing.map((s) => [s.startBoundaryId, s]));
  const result: Section[] = [];
  for (const boundary of nonEnd) {
    const found = byBoundaryId.get(boundary.id);
    if (found) {
      result.push({ ...found });
      continue;
    }
    const created = forNewBoundary(boundary);
    if (created) {
      result.push(created);
    }
  }
  return result;
}

function fail(message: string, boundaries: readonly Boundary[], sections: readonly Section[]): SectionEdit {
  return { ok: false, message, boundaries: [...boundaries], sections: [...sections] };
}

/**
 * 新增边界（规格 7.2）：在 [prev, next] 之间插入内部边界；
 * 左段保留原名称与备注，右段创建默认名称与空备注。
 * 失败：端点、与相邻边界重合、间隔 < 100ms（返回可操作提示）。
 */
export function addBoundary(
  boundaries: readonly Boundary[],
  sections: readonly Section[],
  timeMs: number,
  newBoundaryId: string,
  newSectionId: string,
  durationMs: number,
): SectionEdit {
  const sorted = sortBoundaries(boundaries);
  const { start, end } = endpoints(sorted);
  if (start === undefined || end === undefined) {
    return fail('分段结构不完整（缺少首尾边界）。', boundaries, sections);
  }
  if (timeMs <= start.timeMs || timeMs >= end.timeMs || timeMs >= durationMs) {
    return fail('分段只能添加在视频首尾之间。', boundaries, sections);
  }
  // 找插入位置：start.timeMs < timeMs < end.timeMs 且落在某个相邻区间内。
  let insertAt = -1;
  for (let i = 0; i < sorted.length - 1; i++) {
    const prev = sorted[i];
    const next = sorted[i + 1];
    if (prev === undefined || next === undefined) {
      continue;
    }
    if (prev.timeMs < timeMs && timeMs < next.timeMs) {
      insertAt = i;
      break;
    }
  }
  if (insertAt < 0) {
    return fail('该位置已存在边界或与边界重合。', boundaries, sections);
  }
  const prev = sorted[insertAt];
  const next = sorted[insertAt + 1];
  if (prev === undefined || next === undefined) {
    return fail('无法确定分段位置。', boundaries, sections);
  }
  if (timeMs - prev.timeMs < MIN_BOUNDARY_GAP_MS || next.timeMs - timeMs < MIN_BOUNDARY_GAP_MS) {
    return fail('请放大时间线，或选择间隔至少 0.1 秒的位置。', boundaries, sections);
  }

  const newBoundary: Boundary = { id: newBoundaryId, timeMs, fixed: false, locked: false };
  const newBoundaries = sortBoundaries([...boundaries, newBoundary]);
  const defaultName = nextSectionDefaultName(sections);
  const newSections = rebuildSections(newBoundaries, sections, (boundary) =>
    boundary.id === newBoundaryId
      ? { id: newSectionId, startBoundaryId: newBoundaryId, name: defaultName, note: '' }
      : null,
  );
  return { ok: true, boundaries: newBoundaries, sections: newSections };
}

/** 拖动边界时间（规格 7.2）：夹紧到相邻边界内侧，不跨过、绝不倒序。首尾不可动。 */
export function moveBoundary(
  boundaries: readonly Boundary[],
  sections: readonly Section[],
  id: string,
  timeMs: number,
): SectionEdit {
  const sorted = sortBoundaries(boundaries);
  const index = sorted.findIndex((b) => b.id === id);
  if (index < 0) {
    return fail('找不到该边界。', boundaries, sections);
  }
  const target = sorted[index];
  if (target === undefined) {
    return fail('找不到该边界。', boundaries, sections);
  }
  if (target.fixed) {
    return fail('首尾边界不可拖动。', boundaries, sections);
  }
  const prev = sorted[index - 1];
  const next = sorted[index + 1];
  const min = prev !== undefined ? prev.timeMs + MIN_BOUNDARY_GAP_MS : target.timeMs;
  const max = next !== undefined ? next.timeMs - MIN_BOUNDARY_GAP_MS : target.timeMs;
  const clamped = Math.round(Math.min(Math.max(timeMs, min), Math.max(min, max)));
  const moved = sorted.map((b) => (b.id === id ? { ...b, timeMs: clamped } : { ...b }));
  // 移动边界不改变段落顺序与归属（规格 7.2）。
  return { ok: true, boundaries: moved, sections: sections.map((s) => ({ ...s })) };
}

/**
 * 删除内部边界并合并相邻段落（规格 7.2）：
 * - 保留左段名称；
 * - 右段非空备注用明确分隔符并入左段（不静默丢文字）；
 * - 首尾 / 锁定边界不可删除。
 */
export function removeBoundary(
  boundaries: readonly Boundary[],
  sections: readonly Section[],
  id: string,
): SectionEdit {
  const sorted = sortBoundaries(boundaries);
  const index = sorted.findIndex((b) => b.id === id);
  if (index < 0) {
    return fail('找不到该边界。', boundaries, sections);
  }
  const target = sorted[index];
  if (target === undefined) {
    return fail('找不到该边界。', boundaries, sections);
  }
  if (target.fixed) {
    return fail('首尾边界不可删除。', boundaries, sections);
  }
  if (target.locked) {
    return fail('该边界已锁定，请先解锁。', boundaries, sections);
  }
  const leftBoundary = sorted[index - 1];
  const rightBoundary = sorted[index + 1];
  if (leftBoundary === undefined || rightBoundary === undefined) {
    return fail('无法合并相邻段落。', boundaries, sections);
  }
  const leftSection = sections.find((s) => s.startBoundaryId === leftBoundary.id);
  const rightSection = sections.find((s) => s.startBoundaryId === id);
  if (leftSection === undefined || rightSection === undefined) {
    return fail('段落与边界不对应，无法合并。', boundaries, sections);
  }
  const mergedNote = mergeNotes(leftSection.note, rightSection.note);
  const newBoundaries = sorted.filter((b) => b.id !== id).map((b) => ({ ...b }));
  const newSections = rebuildSections(newBoundaries, sections, () => null).map((s) =>
    s.startBoundaryId === leftBoundary.id ? { ...s, note: mergedNote } : s,
  );
  return { ok: true, boundaries: newBoundaries, sections: newSections };
}

/** 合并两段备注；空值不引入分隔符。 */
export function mergeNotes(left: string, right: string): string {
  const a = left.trim();
  const b = right.trim();
  if (b.length === 0) {
    return left;
  }
  if (a.length === 0) {
    return right;
  }
  return `${left}${NOTE_MERGE_SEPARATOR}${right}`;
}

/** 锁定/解锁内部边界（首尾保持锁定）。 */
export function setBoundaryLocked(
  boundaries: readonly Boundary[],
  sections: readonly Section[],
  id: string,
  locked: boolean,
): SectionEdit {
  const target = boundaries.find((b) => b.id === id);
  if (target === undefined) {
    return fail('找不到该边界。', boundaries, sections);
  }
  if (target.fixed) {
    return fail('首尾边界始终锁定。', boundaries, sections);
  }
  const next = boundaries.map((b) => (b.id === id ? { ...b, locked } : { ...b }));
  return { ok: true, boundaries: next, sections: sections.map((s) => ({ ...s })) };
}

export function renameSection(sections: readonly Section[], id: string, name: string): Section[] {
  return sections.map((s) => (s.id === id ? { ...s, name } : { ...s }));
}

export function setSectionNote(sections: readonly Section[], id: string, note: string): Section[] {
  return sections.map((s) => (s.id === id ? { ...s, note } : { ...s }));
}