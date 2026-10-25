import type { StructureNode } from './api-types';
import {
  childrenOf,
  createStructureNode,
  deriveRanges,
  findNode,
  levelLabel,
  LEVEL_DEFAULT_COLOR,
  sortStructure,
  validateStructure,
} from './structure';
import { DEFAULT_MIN_SHOT_MS, PLACEHOLDER_SHOT_NAME, SHOT_BOUNDARY_DEDUPE_MS } from './shots';
import { formatTimeMs } from './time';

/**
 * 对选中区域（章节 / 段落 / 时间范围）运行智能镜头分割的纯逻辑。
 *
 * 需求（智能分镜此段）：
 * - 只分析选中区域，不扫描/修改其他区域；
 * - 生成镜头属于选中的父级（段落），首尾与父级范围完全一致；
 * - 镜头连续排列、无空洞、无重叠、不越过父级边界；
 * - 已锁定 / 用户手动创建的镜头永不自动删除或移动；自动镜头可被重新识别替换；
 * - 无内部硬切时保留一个覆盖整个区域的镜头；
 * - 只有仍使用默认名称的镜头才自动编号，用户自定义名称不被覆盖；
 * - 结果一次性提交（调用方一次 commit → 一条撤销记录）。
 *
 * 数据模型沿用 structure.ts：镜头只存 startMs（endMs 由下一个兄弟派生），因此
 * “连续覆盖父级”由“边界集合首尾为父级首尾 + 严格递增”自动保证。
 */

export type ShotStrategy = 'replace-auto' | 'supplement';

export interface PlanShotsInput {
  structure: readonly StructureNode[];
  durationMs: number;
  /** 目标父级（必须是段落）。 */
  parentId: string;
  /** 选区起点（全局毫秒）；缺省为父级起点。 */
  startMs?: number;
  /** 选区终点（全局毫秒）；缺省为父级终点。 */
  endMs?: number;
  /** 检测到的切点（全局毫秒，未过滤）。 */
  cutTimes: readonly number[];
  strategy?: ShotStrategy;
  minShotMs?: number;
  dedupeMs?: number;
  /** 新镜头 id 前缀（保证唯一且可测试）。 */
  idSeed: string;
}

export interface PlanShotsResult {
  ok: boolean;
  message?: string;
  structure: StructureNode[];
  /** 目标父级内的镜头总数。 */
  shotCount: number;
  /** 本次依据检测切点新增的镜头数（0 表示未检测到内部硬切）。 */
  detectedCount: number;
  /** 被保留的手动 / 锁定镜头数。 */
  preservedCount: number;
  /** 是否产生实际变化（无变化时不提交、不新增撤销记录）。 */
  didChange: boolean;
}

/** 系统占位镜头（迁移产物“未划分镜头”）：可被自动识别替换，不算用户手动成果。 */
export function isPlaceholderShot(node: StructureNode): boolean {
  return node.name === PLACEHOLDER_SHOT_NAME;
}

/** 是否仍使用默认名称（“待编号”）：允许自动重新编号。 */
export function isDefaultShotName(name: string): boolean {
  return name.length === 0 || name === PLACEHOLDER_SHOT_NAME || /^镜头\s*\d+$/.test(name);
}

/** 镜头是否受保护（不得被自动删除 / 移动）：锁定，或用户手动创建且非占位。 */
export function isProtectedShot(node: StructureNode): boolean {
  return node.locked || (node.source === 'manual' && !isPlaceholderShot(node));
}

interface Range {
  startMs: number;
  endMs: number;
}

function roundTimes(times: readonly number[]): number[] {
  return times
    .filter((t) => Number.isFinite(t))
    .map((t) => Math.round(t))
    .sort((a, b) => a - b);
}

/** 合并重叠区间（用于受保护镜头的内部判定）。 */
function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, range.endMs);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** 点 t 是否落在任一区间的内部（含与边界距离 < dedupeMs 的缓冲）。 */
function nearPerserved(t: number, ranges: readonly Range[], dedupeMs: number): boolean {
  return ranges.some((r) => t > r.startMs - dedupeMs && t < r.endMs + dedupeMs);
}

/**
 * 在目标父级（段落）内重新规划镜头。
 *
 * 边界集合包含：父级首尾、选区首尾、受保护镜头首尾、（补充策略）全部现有镜头首尾，
 * 以及过滤后的检测切点。切点必须严格位于选区内部，且与已保留边界 / 已接受切点
 * 至少相隔 minShotMs（同时满足相近去重与最短镜头约束）。
 */
export function planShotsInRange(input: PlanShotsInput): PlanShotsResult {
  const {
    structure,
    durationMs,
    parentId,
    cutTimes,
    strategy = 'replace-auto',
    minShotMs = DEFAULT_MIN_SHOT_MS,
    dedupeMs = SHOT_BOUNDARY_DEDUPE_MS,
    idSeed,
  } = input;

  const parent = findNode(structure, parentId);
  if (!parent) {
    return fail(structure, '找不到要识别的目标结构。');
  }
  if (parent.level !== 'section') {
    return fail(structure, `只能对${levelLabel('section')}运行智能分镜。`);
  }
  const parentRange = deriveRanges(structure, durationMs).get(parentId);
  if (!parentRange) {
    return fail(structure, '目标结构时间范围异常，无法识别。');
  }

  const selStart = clampInto(input.startMs ?? parentRange.startMs, parentRange.startMs, parentRange.endMs);
  const selEnd = clampInto(input.endMs ?? parentRange.endMs, parentRange.startMs, parentRange.endMs);
  if (selEnd <= selStart) {
    return fail(structure, '选择的区域太短，无法识别镜头。');
  }

  const existing = childrenOf(structure, parentId, 'shot');
  const ranges = deriveRanges(structure, durationMs);
  const existingWithRange = existing.map((node) => ({
    node,
    range: ranges.get(node.id) ?? { startMs: node.startMs, endMs: node.startMs },
  }));

  const protectedRanges = mergeRanges(
    existingWithRange
      .filter(({ node }) => isProtectedShot(node))
      .map(({ range }) => range),
  );
  const preservedCount = existingWithRange.filter(({ node }) => isProtectedShot(node)).length;

  // 结构性边界（高优先，永不丢弃）。
  const required: number[] = [];
  const addRequired = (t: number): void => {
    const value = Math.round(t);
    if (!required.includes(value)) {
      required.push(value);
    }
  };
  addRequired(parentRange.startMs);
  addRequired(parentRange.endMs);
  addRequired(selStart);
  addRequired(selEnd);
  for (const range of protectedRanges) {
    addRequired(range.startMs);
    addRequired(range.endMs);
  }
  if (strategy === 'supplement') {
    for (const { range } of existingWithRange) {
      addRequired(range.startMs);
      addRequired(range.endMs);
    }
  }

  const accepted = [...required].sort((a, b) => a - b);

  // 检测切点过滤与最短镜头约束。
  let detectedCount = 0;
  for (const t of roundTimes(cutTimes)) {
    if (t <= selStart || t >= selEnd) {
      continue;
    }
    if (nearPerserved(t, protectedRanges, dedupeMs)) {
      continue;
    }
    if (accepted.some((p) => Math.abs(p - t) < minShotMs)) {
      continue;
    }
    accepted.push(t);
    detectedCount += 1;
  }
  accepted.sort((a, b) => a - b);

  // 由边界集合重建镜头；与既有镜头区间完全一致时复用其属性（保留名称/备注/锁定等）。
  const reusable = new Map<string, StructureNode>();
  for (const { node, range } of existingWithRange) {
    if (!isPlaceholderShot(node)) {
      reusable.set(`${range.startMs}:${range.endMs}`, node);
    }
  }

  const rebuilt: StructureNode[] = [];
  for (let i = 0; i < accepted.length - 1; i++) {
    const startMs = accepted[i]!;
    const endMs = accepted[i + 1]!;
    if (endMs <= startMs) {
      continue;
    }
    const previous = reusable.get(`${startMs}:${endMs}`);
    if (previous) {
      rebuilt.push({ ...previous });
    } else {
      rebuilt.push(
        createStructureNode({
          id: `${idSeed}-shot-${i}`,
          level: 'shot',
          parentId,
          name: '',
          startMs,
          color: LEVEL_DEFAULT_COLOR.shot,
          source: 'auto',
        }),
      );
    }
  }

  if (rebuilt.length === 0) {
    return fail(structure, '识别结果为空，已取消。');
  }

  // 仅对“仍使用默认名称”的镜头按时间顺序重新编号；自定义名称原样保留。
  let counter = 0;
  const named = rebuilt.map((node) => {
    counter += 1;
    return isDefaultShotName(node.name) ? { ...node, name: `镜头 ${counter}` } : { ...node };
  });

  const others = structure.filter((node) => !(node.level === 'shot' && node.parentId === parentId));
  const next = sortStructure([...others, ...named]);
  const issues = validateStructure(next, durationMs);
  if (issues.length > 0) {
    return fail(structure, '识别结果会产生非法结构，已取消。');
  }

  return {
    ok: true,
    structure: next,
    shotCount: named.length,
    detectedCount,
    preservedCount,
    didChange: shotSignature(existing) !== shotSignature(named),
  };
}

function fail(structure: readonly StructureNode[], message: string): PlanShotsResult {
  return { ok: false, message, structure: [...structure], shotCount: 0, detectedCount: 0, preservedCount: 0, didChange: false };
}

function clampInto(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** 镜头序列签名（起点 + 名称 + 锁定 + 来源），用于判断是否产生实际变化。 */
function shotSignature(shots: readonly StructureNode[]): string {
  return [...shots]
    .sort((a, b) => a.startMs - b.startMs)
    .map((node) => `${node.startMs}|${node.name}|${node.locked ? 1 : 0}|${node.source}`)
    .join(';');
}
/* ------------------------------------------------------------------ */
/* 选区 → 镜头识别目标                                                    */
/* ------------------------------------------------------------------ */

export type ShotTargetSelection =
  | { kind: 'node'; id: string }
  | { kind: 'range'; startMs: number; endMs: number };

export interface ShotSectionTarget {
  id: string;
  /** 该段落内实际执行识别的范围（选区与段落范围的交集）。 */
  startMs: number;
  endMs: number;
}

export interface ShotTarget {
  /** 面向用户的目标描述，如“第一次尝试 · 00:28 — 00:54”。 */
  label: string;
  sections: ShotSectionTarget[];
  /** 整体识别范围（用于 ffmpeg 局部扫描，一次扫描覆盖全部相关段落）。 */
  rangeStartMs: number;
  rangeEndMs: number;
}

export interface ResolveShotTargetResult {
  ok: boolean;
  message?: string;
  target?: ShotTarget;
}

/**
 * 把“当前选中章节 / 段落 / 时间范围”解析为可执行的识别目标：
 * - 段落：目标即该段落完整范围；
 * - 章节：目标为其下全部段落（整章一次扫描，逐段生成镜头）；
 * - 时间范围：取与该范围相交的全部段落，并按交集裁剪识别范围。
 * 无有效选区时返回面向用户的中文提示（按钮禁用原因）。
 */
export function resolveShotTarget(
  structure: readonly StructureNode[],
  durationMs: number,
  selection: ShotTargetSelection | null,
): ResolveShotTargetResult {
  if (selection === null) {
    return { ok: false, message: '请先在时间线上选择一个章节、段落或时间区域。' };
  }
  const ranges = deriveRanges(structure, durationMs);

  if (selection.kind === 'node') {
    const node = findNode(structure, selection.id);
    if (!node) {
      return { ok: false, message: '找不到选中的结构。' };
    }
    if (node.level === 'shot') {
      return { ok: false, message: '当前只选中了一个镜头；请在左侧结构中选择所属段落或章节后再分镜。' };
    }
    if (node.level === 'section') {
      const range = ranges.get(node.id);
      if (!range) {
        return { ok: false, message: '该段落时间范围异常，无法识别。' };
      }
      return {
        ok: true,
        target: {
          label: `${node.name || levelLabel('section')} · ${formatTimeMs(range.startMs)} — ${formatTimeMs(range.endMs)}`,
          sections: [{ id: node.id, startMs: range.startMs, endMs: range.endMs }],
          rangeStartMs: range.startMs,
          rangeEndMs: range.endMs,
        },
      };
    }
    // 章节：对其下全部段落识别。
    const sections = childrenOf(structure, node.id, 'section');
    const targets: ShotSectionTarget[] = [];
    for (const section of sections) {
      const range = ranges.get(section.id);
      if (range && range.endMs > range.startMs) {
        targets.push({ id: section.id, startMs: range.startMs, endMs: range.endMs });
      }
    }
    if (targets.length === 0) {
      return { ok: false, message: '该章节下没有可识别的段落。' };
    }
    return {
      ok: true,
      target: {
        label: `${node.name || levelLabel('chapter')} · ${formatTimeMs(targets[0]!.startMs)} — ${formatTimeMs(targets[targets.length - 1]!.endMs)}`,
        sections: targets,
        rangeStartMs: targets[0]!.startMs,
        rangeEndMs: targets[targets.length - 1]!.endMs,
      },
    };
  }

  // 时间范围选区：与相交的段落求交集。
  const selStart = Math.min(selection.startMs, selection.endMs);
  const selEnd = Math.max(selection.startMs, selection.endMs);
  const chapterNodes = structure.filter((n) => n.level === 'chapter');
  const targets: ShotSectionTarget[] = [];
  for (const chapter of chapterNodes) {
    for (const section of childrenOf(structure, chapter.id, 'section')) {
      const range = ranges.get(section.id);
      if (!range) continue;
      const startMs = Math.max(range.startMs, selStart);
      const endMs = Math.min(range.endMs, selEnd);
      if (endMs > startMs) {
        targets.push({ id: section.id, startMs, endMs });
      }
    }
  }
  if (targets.length === 0) {
    return { ok: false, message: '时间选区没有落在任何段落内，请扩大范围。' };
  }
  targets.sort((a, b) => a.startMs - b.startMs);
  return {
    ok: true,
    target: {
      label: `时间选区 · ${formatTimeMs(selStart)} — ${formatTimeMs(selEnd)}`,
      sections: targets,
      rangeStartMs: targets[0]!.startMs,
      rangeEndMs: targets[targets.length - 1]!.endMs,
    },
  };
}

/** 目标内是否存在可被重新识别的镜头（非占位、未锁定、用户手动均计入）。 */
export function countEditableShots(
  structure: readonly StructureNode[],
  target: ShotTarget,
): number {
  let count = 0;
  for (const section of target.sections) {
    for (const shot of childrenOf(structure, section.id, 'shot')) {
      if (!isPlaceholderShot(shot)) {
        count += 1;
      }
    }
  }
  return count;
}
