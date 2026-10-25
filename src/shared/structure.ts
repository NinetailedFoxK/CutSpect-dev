import type { Boundary, Section, StructureLevel, StructureNode, StructureSource } from './api-types';
import { mergeNotes, sectionRanges } from './sections';
import { PLACEHOLDER_SHOT_NAME } from './shots';

/**
 * 三级结构（章节 / 段落 / 镜头）数据模型与编辑纯函数。
 *
 * 设计要点：
 * - 扁平数组 + level/parentId 表达固定三级树；
 * - 每个节点只保存 startMs（唯一时间真值），endMs 由 deriveRanges 派生；
 * - 同级共享边界：相邻结构的交界就是右侧结构的 startMs，天然无缝隙、无重叠；
 * - 子级连续覆盖父级范围（段落覆盖章节；镜头覆盖段落），没有未覆盖空洞；
 * - 顶层章节从 0 开始、最后一个结束于视频时长。
 *
 * 本模块无 Node / DOM 依赖，main / renderer / vitest 均可复用。所有编辑均返回
 * 新数组且保持上述不变量；无法安全执行时返回 ok:false 与面向用户的中文提示，
 * 绝不生成非法结构（“不能静默生成非法数据”）。
 */

/* ------------------------------------------------------------------ */
/* 常量                                                                 */
/* ------------------------------------------------------------------ */

/** 章节维度名（固定三级，不做无限嵌套）。 */
export const LEVELS: readonly StructureLevel[] = ['chapter', 'section', 'shot'];

const LEVEL_LABEL: Record<StructureLevel, string> = {
  chapter: '章节',
  section: '段落',
  shot: '镜头',
};

/** 每个层级的子级层级；镜头为叶子（null）。 */
const CHILD_LEVEL: Record<StructureLevel, StructureLevel | null> = {
  chapter: 'section',
  section: 'shot',
  shot: null,
};

/** 叙事作用快捷值（“自定义”表示自由文本，仍以字符串保存）。 */
export const NARRATIVE_ROLES = [
  '钩子',
  '交代',
  '铺垫',
  '冲突',
  '转折',
  '高潮',
  '解释',
  '收束',
  '自定义',
] as const;
export type NarrativeRole = (typeof NARRATIVE_ROLES)[number];

/** 各层级默认显示色（低饱和，避免高饱和随机色）。 */
export const LEVEL_DEFAULT_COLOR: Record<StructureLevel, string> = {
  chapter: '#A9B4C6',
  section: '#78A6FF',
  shot: '#8B93A1',
};

/** 名称与标签长度上限（与 schema 校验保持一致）。 */
export const STRUCTURE_NAME_MAX = 200;
export const STRUCTURE_NOTE_MAX = 5000;
export const STRUCTURE_MAX_TAGS = 20;
export const STRUCTURE_TAG_MAX = 40;

export function levelLabel(level: StructureLevel): string {
  return LEVEL_LABEL[level];
}

export function isStructureLevel(value: unknown): value is StructureLevel {
  return value === 'chapter' || value === 'section' || value === 'shot';
}

export function childLevelOf(level: StructureLevel): StructureLevel | null {
  return CHILD_LEVEL[level];
}

export function parentLevelOf(level: StructureLevel): StructureLevel | null {
  if (level === 'section') {
    return 'chapter';
  }
  if (level === 'shot') {
    return 'section';
  }
  return null;
}

/** 层级的默认名称（新增结构时使用）。 */
export function defaultNameForLevel(level: StructureLevel, index: number): string {
  return `${LEVEL_LABEL[level]} ${index}`;
}

/* ------------------------------------------------------------------ */
/* 查询与派生                                                            */
/* ------------------------------------------------------------------ */

export interface StructureRange {
  startMs: number;
  endMs: number;
}

function levelNodes(structure: readonly StructureNode[], level: StructureLevel): StructureNode[] {
  return structure.filter((node) => node.level === level);
}

/** 某父级下的直接子级（按 startMs 升序）。 */
export function childrenOf(
  structure: readonly StructureNode[],
  parentId: string | null,
  level: StructureLevel,
): StructureNode[] {
  return structure
    .filter((node) => node.level === level && node.parentId === parentId)
    .sort((a, b) => a.startMs - b.startMs);
}

export function findNode(structure: readonly StructureNode[], id: string): StructureNode | undefined {
  return structure.find((node) => node.id === id);
}

/**
 * 派生每个节点的 [start, end]：end = 下一个同级兄弟的 start，末位取父级 end
 * （顶层章节取视频时长）。返回 Map，未命中的 id 表示结构异常。
 */
export function deriveRanges(
  structure: readonly StructureNode[],
  durationMs: number,
): Map<string, StructureRange> {
  const map = new Map<string, StructureRange>();
  const chapters = levelNodes(structure, 'chapter').sort((a, b) => a.startMs - b.startMs);
  chapters.forEach((chapter, index) => {
    const endMs = index + 1 < chapters.length ? chapters[index + 1]!.startMs : durationMs;
    map.set(chapter.id, { startMs: chapter.startMs, endMs });
  });
  for (const chapter of chapters) {
    const chapterEnd = map.get(chapter.id)?.endMs ?? durationMs;
    const sections = childrenOf(structure, chapter.id, 'section');
    sections.forEach((section, index) => {
      const endMs = index + 1 < sections.length ? sections[index + 1]!.startMs : chapterEnd;
      map.set(section.id, { startMs: section.startMs, endMs });
    });
    for (const section of sections) {
      const sectionEnd = map.get(section.id)?.endMs ?? chapterEnd;
      const shots = childrenOf(structure, section.id, 'shot');
      shots.forEach((shot, index) => {
        const endMs = index + 1 < shots.length ? shots[index + 1]!.startMs : sectionEnd;
        map.set(shot.id, { startMs: shot.startMs, endMs });
      });
    }
  }
  return map;
}

/** 节点所属父级 id 集合（自顶向下）。 */
export function ancestorsOf(structure: readonly StructureNode[], id: string): StructureNode[] {
  const result: StructureNode[] = [];
  let current = findNode(structure, id);
  while (current && current.parentId !== null) {
    const parent = findNode(structure, current.parentId);
    if (!parent) {
      break;
    }
    result.push(parent);
    current = parent;
  }
  return result;
}

/** 节点的全部后代（深度优先）。 */
export function descendantsOf(structure: readonly StructureNode[], id: string): StructureNode[] {
  const result: StructureNode[] = [];
  const walk = (parentId: string): void => {
    for (const child of structure.filter((node) => node.parentId === parentId)) {
      result.push(child);
      walk(child.id);
    }
  };
  walk(id);
  return result;
}

/**
 * 层级编号：章节 1、2…；段落 1.1、1.2…；镜头 1.1.1、1.1.2…。
 * 返回 Map<id, number[] 段> 便于导出时拼字符串。
 */
export function buildNumbering(structure: readonly StructureNode[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  const chapters = levelNodes(structure, 'chapter').sort((a, b) => a.startMs - b.startMs);
  chapters.forEach((chapter, chapterIndex) => {
    const chapterNo = [chapterIndex + 1];
    map.set(chapter.id, chapterNo);
    const sections = childrenOf(structure, chapter.id, 'section');
    sections.forEach((section, sectionIndex) => {
      const sectionNo = [...chapterNo, sectionIndex + 1];
      map.set(section.id, sectionNo);
      const shots = childrenOf(structure, section.id, 'shot');
      shots.forEach((shot, shotIndex) => {
        map.set(shot.id, [...sectionNo, shotIndex + 1]);
      });
    });
  });
  return map;
}

/** 编号字符串，如 "2.3.4"。 */
export function formatNumber(parts: readonly number[]): string {
  return parts.join('.');
}

/**
 * 时间归属某层级的节点（规格：边界归属右侧结构，视频终点归属最后一个结构）。
 * - chapter 直接按 startMs 归属；
 * - section 先定位章节，再在该章节内归属；
 * - shot 先定位章节与段落，再在该段落内归属。
 */
export function resolveNodeAt(
  structure: readonly StructureNode[],
  level: StructureLevel,
  timeMs: number,
  durationMs: number,
): StructureNode | null {
  const pick = (nodes: readonly StructureNode[]): StructureNode | null => {
    let matched: StructureNode | null = null;
    for (const node of nodes) {
      if (node.startMs <= timeMs) {
        matched = node;
      } else {
        break;
      }
    }
    if (matched === null && nodes.length > 0 && timeMs >= durationMs) {
      return nodes[nodes.length - 1]!;
    }
    return matched;
  };

  const chapters = levelNodes(structure, 'chapter').sort((a, b) => a.startMs - b.startMs);
  const chapter = pick(chapters);
  if (chapter === null) {
    return null;
  }
  if (level === 'chapter') {
    return chapter;
  }
  const sections = childrenOf(structure, chapter.id, 'section');
  const section = pick(sections);
  if (section === null) {
    return null;
  }
  if (level === 'section') {
    return section;
  }
  const shots = childrenOf(structure, section.id, 'shot');
  return pick(shots);
}

/* ------------------------------------------------------------------ */
/* 不变量校验                                                            */
/* ------------------------------------------------------------------ */

function isIntegerMs(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * 校验三级结构不变量，返回问题列表（空数组即通过）。
 * 覆盖：id 唯一、层级与父级关系、章节起止覆盖全片、每个父级被子级连续覆盖。
 */
export function validateStructure(
  structure: readonly StructureNode[],
  durationMs: number,
): string[] {
  const issues: string[] = [];
  if (structure.length === 0) {
    issues.push('三级结构为空。');
    return issues;
  }

  const ids = new Set<string>();
  for (const node of structure) {
    if (ids.has(node.id)) {
      issues.push(`结构 ID 重复：${node.id}`);
    }
    ids.add(node.id);
    if (!isStructureLevel(node.level)) {
      issues.push(`结构 ${node.id} 的层级非法：${String(node.level)}`);
    }
    if (!isIntegerMs(node.startMs)) {
      issues.push(`结构 ${node.id} 的开始时间必须是非负整数毫秒。`);
    }
    if (node.startMs > durationMs) {
      issues.push(`结构 ${node.id} 的开始时间超出视频时长。`);
    }
    if (node.locked !== true && node.locked !== false) {
      issues.push(`结构 ${node.id} 的锁定状态非法。`);
    }
  }

  const chapters = levelNodes(structure, 'chapter').sort((a, b) => a.startMs - b.startMs);
  if (chapters.length === 0) {
    issues.push('缺少章节层结构。');
    return issues;
  }
  const firstChapter = chapters[0]!;
  const lastChapter = chapters[chapters.length - 1]!;
  if (firstChapter.startMs !== 0) {
    issues.push('第一个章节必须从 0 开始。');
  }
  if (lastChapter.startMs >= durationMs) {
    issues.push('最后一个章节的起点必须早于视频时长。');
  }

  // 章节：严格递增、无重叠空洞（共享边界模型下由递增即保证）。
  for (let i = 1; i < chapters.length; i++) {
    const prev = chapters[i - 1]!;
    const curr = chapters[i]!;
    if (curr.startMs <= prev.startMs) {
      issues.push(`章节 ${prev.id} 与 ${curr.id} 的时间未严格递增。`);
    }
  }

  const chapterIds = new Set(chapters.map((c) => c.id));
  // 段落 / 镜头：父级存在、连续覆盖、严格递增。
  for (const node of structure) {
    if (node.level === 'chapter') {
      if (node.parentId !== null) {
        issues.push(`章节 ${node.id} 不应有父级。`);
      }
      continue;
    }
    if (node.parentId === null) {
      issues.push(`结构 ${node.id} 缺少父级。`);
      continue;
    }
    const parent = findNode(structure, node.parentId);
    if (!parent) {
      issues.push(`结构 ${node.id} 引用了不存在的父级 ${node.parentId}。`);
      continue;
    }
    const expectedParentLevel = parentLevelOf(node.level);
    if (parent.level !== expectedParentLevel) {
      issues.push(`结构 ${node.id} 的父级层级应为 ${String(expectedParentLevel)}。`);
    }
    if (node.level === 'section' && !chapterIds.has(parent.id)) {
      issues.push(`段落 ${node.id} 的父级不是章节。`);
    }
  }

  // 每个父级必须被子级连续覆盖：第一个子 start = 父 start，末个子 end = 父 end。
  const ranges = deriveRanges(structure, durationMs);
  const checkCoverage = (
    parent: StructureNode,
    childLevel: StructureLevel,
  ): void => {
    const parentRange = ranges.get(parent.id);
    if (!parentRange) {
      return;
    }
    const children = childrenOf(structure, parent.id, childLevel);
    if (children.length === 0) {
      issues.push(`${LEVEL_LABEL[parent.level]} ${parent.id} 没有覆盖其范围的${LEVEL_LABEL[childLevel]}。`);
      return;
    }
    const first = children[0]!;
    const last = children[children.length - 1]!;
    if (first.startMs !== parentRange.startMs) {
      issues.push(
        `${LEVEL_LABEL[childLevel]} ${first.id} 必须与父级起点对齐（${parentRange.startMs}ms）。`,
      );
    }
    const lastRange = ranges.get(last.id);
    if (!lastRange || lastRange.endMs !== parentRange.endMs) {
      issues.push(`${LEVEL_LABEL[childLevel]} ${last.id} 必须与父级终点对齐。`);
    }
    for (let i = 1; i < children.length; i++) {
      const prev = children[i - 1]!;
      const curr = children[i]!;
      if (curr.startMs <= prev.startMs) {
        issues.push(`${LEVEL_LABEL[childLevel]} ${prev.id} 与 ${curr.id} 时间未严格递增。`);
      }
    }
  };
  for (const chapter of chapters) {
    checkCoverage(chapter, 'section');
  }
  for (const node of levelNodes(structure, 'section')) {
    checkCoverage(node, 'shot');
  }

  return issues;
}

/* ------------------------------------------------------------------ */
/* 编辑操作（返回新数组，失败不改动）                                     */
/* ------------------------------------------------------------------ */

export interface StructureEdit {
  ok: boolean;
  message?: string;
  structure: StructureNode[];
}

function fail(message: string, structure: readonly StructureNode[]): StructureEdit {
  return { ok: false, message, structure: [...structure] };
}

/** 稳定重排：按树深度优先输出，便于落盘与测试比对。 */
export function sortStructure(structure: readonly StructureNode[]): StructureNode[] {
  const ordered: StructureNode[] = [];
  const byParent = (parentId: string | null, level: StructureLevel): StructureNode[] =>
    structure
      .filter((node) => node.level === level && node.parentId === parentId)
      .sort((a, b) => a.startMs - b.startMs);
  for (const chapter of byParent(null, 'chapter')) {
    ordered.push({ ...chapter });
    for (const section of byParent(chapter.id, 'section')) {
      ordered.push({ ...section });
      for (const shot of byParent(section.id, 'shot')) {
        ordered.push({ ...shot });
      }
    }
  }
  return ordered;
}

export interface NewNodeInput {
  id: string;
  level: StructureLevel;
  parentId: string | null;
  name: string;
  startMs: number;
  note?: string;
  narrativeRole?: string;
  tags?: string[];
  color?: string;
  locked?: boolean;
  coverTimeMs?: number | null;
  source?: StructureSource;
  confidence?: number | null;
}

export function createStructureNode(input: NewNodeInput): StructureNode {
  return {
    id: input.id,
    level: input.level,
    parentId: input.parentId,
    name: input.name,
    startMs: input.startMs,
    note: input.note ?? '',
    narrativeRole: input.narrativeRole ?? '',
    tags: input.tags ?? [],
    color: input.color ?? LEVEL_DEFAULT_COLOR[input.level],
    locked: input.locked ?? false,
    coverTimeMs: input.coverTimeMs ?? null,
    source: input.source ?? 'manual',
    confidence: input.confidence ?? null,
  };
}

/**
 * 把 timeMs 吸附到某节点子级的最近边界（含节点自身 start）。无子级边界可用时
 * 返回 timeMs 本身（镜头层或段落层无镜头时）。用于拆分与拖动时的边界对齐。
 */
export function nearestChildBoundary(
  structure: readonly StructureNode[],
  nodeId: string,
  timeMs: number,
  durationMs: number,
): number {
  const node = findNode(structure, nodeId);
  if (!node) {
    return timeMs;
  }
  const childLevel = childLevelOf(node.level);
  const candidates: number[] = [node.startMs];
  if (childLevel !== null) {
    for (const child of childrenOf(structure, node.id, childLevel)) {
      candidates.push(child.startMs);
    }
  }
  const range = deriveRanges(structure, durationMs).get(node.id);
  if (range) {
    candidates.push(range.endMs);
  }
  let best = timeMs;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - timeMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * 在 boundaryMs 处拆分节点：
 * - 左块保留原 id、名称、备注与全部属性；
 * - 右块使用给定的 newId 与默认名称（空备注）；
 * - 章节拆分要求边界与大层级段落边界对齐（否则吸附或报错），段落拆分要求与镜头边界对齐；
 * - 子级按 boundaryMs 重新归属到右块；锁定节点不可拆分。
 */
export function splitNode(
  structure: readonly StructureNode[],
  nodeId: string,
  boundaryMs: number,
  newId: string,
  durationMs: number,
): StructureEdit {
  const node = findNode(structure, nodeId);
  if (!node) {
    return fail('找不到要拆分的结构。', structure);
  }
  if (node.locked) {
    return fail(`${levelLabel(node.level)}已锁定，请先解锁。`, structure);
  }
  if (structure.some((item) => item.id === newId)) {
    return fail(`结构 ID 已存在：${newId}`, structure);
  }
  const range = deriveRanges(structure, durationMs).get(nodeId);
  if (!range) {
    return fail('结构时间范围异常，无法拆分。', structure);
  }
  const timeMs = Math.round(boundaryMs);
  if (timeMs <= range.startMs || timeMs >= range.endMs) {
    return fail(`拆分点必须落在${levelLabel(node.level)}范围内。`, structure);
  }

  const childLevel = childLevelOf(node.level);
  let next = structure.map((item) => ({ ...item }));
  if (childLevel !== null) {
    const children = childrenOf(structure, node.id, childLevel);
    const hasAlignedBoundary = children.some((child) => child.startMs === timeMs);
    if (!hasAlignedBoundary) {
      return fail(
        `${levelLabel(node.level)}边界必须与${levelLabel(childLevel)}边界对齐，请吸附到最近的分界。`,
        structure,
      );
    }
    next = next.map((item) =>
      item.level === childLevel && item.parentId === node.id && item.startMs >= timeMs
        ? { ...item, parentId: newId }
        : item,
    );
  }

  const right = createStructureNode({
    id: newId,
    level: node.level,
    parentId: node.parentId,
    name: defaultNameForLevel(node.level, 0),
    startMs: timeMs,
    color: node.color,
  });
  next.push(right);
  return { ok: true, structure: sortStructure(next) };
}

/**
 * 合并节点到其左邻（删除该节点起始边界）：
 * - 保留左邻名称；双方备注用分隔符合并（不静默丢文字）；
 * - 子级并入左邻；
 * - 锁定节点、或左邻锁定、或没有左邻时拒绝。
 */
export function mergeNode(
  structure: readonly StructureNode[],
  nodeId: string,
  durationMs: number,
): StructureEdit {
  const node = findNode(structure, nodeId);
  if (!node) {
    return fail('找不到要合并的结构。', structure);
  }
  if (node.locked) {
    return fail(`${levelLabel(node.level)}已锁定，请先解锁。`, structure);
  }
  const siblings = childrenOf(structure, node.parentId, node.level);
  const index = siblings.findIndex((item) => item.id === nodeId);
  if (index <= 0) {
    return fail('第一个结构不能向前合并。', structure);
  }
  const left = siblings[index - 1]!;
  if (left.locked) {
    return fail('左侧结构已锁定，请先解锁。', structure);
  }

  const childLevel = childLevelOf(node.level);
  let next = structure.filter((item) => item.id !== nodeId).map((item) => ({ ...item }));
  if (childLevel !== null) {
    next = next.map((item) =>
      item.level === childLevel && item.parentId === node.id
        ? { ...item, parentId: left.id }
        : item,
    );
  }
  next = next.map((item) =>
    item.id === left.id ? { ...item, note: mergeNotes(left.note, node.note) } : item,
  );
  if (validateStructure(next, durationMs).length > 0) {
    return fail('合并后会产生非法结构，已取消。', structure);
  }
  return { ok: true, structure: sortStructure(next) };
}

export interface StructurePatch {
  name?: string;
  note?: string;
  narrativeRole?: string;
  tags?: string[];
  color?: string;
  locked?: boolean;
  coverTimeMs?: number | null;
  source?: StructureSource;
  confidence?: number | null;
}

/** 修改结构属性（名称/备注/叙事作用/标签/颜色/锁定/代表帧等）。 */
export function updateStructureNode(
  structure: readonly StructureNode[],
  id: string,
  patch: StructurePatch,
): StructureEdit {
  const node = findNode(structure, id);
  if (!node) {
    return fail('找不到该结构。', structure);
  }
  if (patch.name !== undefined && patch.name.length > STRUCTURE_NAME_MAX) {
    return fail(`名称最多 ${STRUCTURE_NAME_MAX} 个字符。`, structure);
  }
  if (patch.note !== undefined && patch.note.length > STRUCTURE_NOTE_MAX) {
    return fail(`备注最多 ${STRUCTURE_NOTE_MAX} 个字符。`, structure);
  }
  if (patch.tags !== undefined) {
    if (patch.tags.length > STRUCTURE_MAX_TAGS) {
      return fail(`标签最多 ${STRUCTURE_MAX_TAGS} 个。`, structure);
    }
    if (patch.tags.some((tag) => tag.length > STRUCTURE_TAG_MAX)) {
      return fail(`单个标签最多 ${STRUCTURE_TAG_MAX} 个字符。`, structure);
    }
  }
  const next = structure.map((item) =>
    item.id === id
      ? {
          ...item,
          name: patch.name ?? item.name,
          note: patch.note ?? item.note,
          narrativeRole: patch.narrativeRole ?? item.narrativeRole,
          tags: patch.tags ?? item.tags,
          color: patch.color ?? item.color,
          locked: patch.locked ?? item.locked,
          coverTimeMs: patch.coverTimeMs !== undefined ? patch.coverTimeMs : item.coverTimeMs,
          source: patch.source ?? item.source,
          confidence: patch.confidence !== undefined ? patch.confidence : item.confidence,
        }
      : { ...item },
  );
  return { ok: true, structure: next };
}

/**
 * 移动结构到其他父级（受限版）：
 * - 仅当目标父级内存在与该结构时间范围完全一致的子级时替换其归属，
 *   否则返回明确提示，绝不产生重叠/空洞的非法结构（后续版本再支持自动挖空）。
 */
export function reparentNode(
  structure: readonly StructureNode[],
  nodeId: string,
  newParentId: string,
  durationMs: number,
): StructureEdit {
  const node = findNode(structure, nodeId);
  if (!node) {
    return fail('找不到要移动的结构。', structure);
  }
  if (node.locked) {
    return fail(`${levelLabel(node.level)}已锁定，请先解锁。`, structure);
  }
  if (node.parentId === newParentId) {
    return { ok: true, structure: sortStructure(structure) };
  }
  const parent = findNode(structure, newParentId);
  if (!parent) {
    return fail('找不到目标父级。', structure);
  }
  const childLevel = childLevelOf(parent.level);
  if (childLevel !== node.level) {
    return fail(`只能把${levelLabel(node.level)}移动到${levelLabel(parent.level)}下。`, structure);
  }
  const ranges = deriveRanges(structure, durationMs);
  const nodeRange = ranges.get(nodeId);
  const parentRange = ranges.get(newParentId);
  if (!nodeRange || !parentRange) {
    return fail('结构时间范围异常。', structure);
  }
  if (nodeRange.startMs < parentRange.startMs || nodeRange.endMs > parentRange.endMs) {
    return fail('该结构的时间范围超出目标父级，无法移动。', structure);
  }
  const slot = childrenOf(structure, newParentId, childLevel).find(
    (child) => child.startMs === nodeRange.startMs,
  );
  if (!slot || (ranges.get(slot.id)?.endMs ?? -1) !== nodeRange.endMs) {
    return fail('目标父级在该时间段已有内容，请先调整后再移动。', structure);
  }
  const next = structure.map((item) => {
    if (item.id === nodeId) {
      return { ...item, parentId: newParentId };
    }
    if (item.id === slot.id) {
      // 目标位置的占位子级被替换：并入被移动结构的名称/备注，避免丢文字。
      return { ...item, parentId: '__merged__' };
    }
    return { ...item };
  });
  // 占位子级直接删除（其时间范围由被移动结构接管）。
  const filtered = next
    .filter((item) => item.parentId !== '__merged__')
    .map((item) => ({ ...item }));
  if (validateStructure(filtered, durationMs).length > 0) {
    return fail('移动后会产生非法结构，已取消。', structure);
  }
  return { ok: true, structure: sortStructure(filtered) };
}

/* ------------------------------------------------------------------ */
/* 旧项目迁移                                                            */
/* ------------------------------------------------------------------ */

export interface LegacyStructureMigrationInput {
  projectId: string;
  durationMs: number;
  boundaries: readonly Boundary[];
  sections: readonly Section[];
}

/**
 * 由旧单层分段生成三级结构（规格 3.3）：
 * - 新建覆盖全片的默认章节“完整视频”；
 * - 旧分段全部迁移为第二层段落，保留名称、备注与锁定状态；
 * - 第三层为每个段落创建一个“未划分镜头”，连续覆盖其段落范围
 *   （保证子级覆盖父级、无空洞；用户运行镜头识别后可整体替换）。
 * 旧项目的曲线、标注、边界与视图状态不在本函数内改动。
 */
export function buildLegacyStructure(input: LegacyStructureMigrationInput): StructureNode[] {
  const { projectId, boundaries, sections } = input;
  const chapterId = `${projectId}-chapter-1`;
  const nodes: StructureNode[] = [
    createStructureNode({
      id: chapterId,
      level: 'chapter',
      parentId: null,
      name: '完整视频',
      startMs: 0,
      color: LEVEL_DEFAULT_COLOR.chapter,
    }),
  ];

  const ranges = sectionRanges(boundaries, sections);
  const ordered = ranges
    .filter((range) => range.endMs > range.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (ordered.length === 0) {
    // 旧结构异常（无有效段落）：补一个覆盖全片的段落，保证不变量成立。
    const fallbackId = `${projectId}-section-1`;
    nodes.push(
      createStructureNode({
        id: fallbackId,
        level: 'section',
        parentId: chapterId,
        name: '段落 1',
        startMs: 0,
        color: LEVEL_DEFAULT_COLOR.section,
      }),
    );
    nodes.push(
      createStructureNode({
        id: `${projectId}-shot-1`,
        level: 'shot',
        parentId: fallbackId,
        name: PLACEHOLDER_SHOT_NAME,
        startMs: 0,
        color: LEVEL_DEFAULT_COLOR.shot,
      }),
    );
    return sortStructure(nodes);
  }

  ordered.forEach((range) => {
    const locked = boundaries.find((b) => b.timeMs === range.startMs)?.locked ?? false;
    nodes.push(
      createStructureNode({
        id: range.section.id,
        level: 'section',
        parentId: chapterId,
        name: range.section.name,
        startMs: range.startMs,
        note: range.section.note,
        color: LEVEL_DEFAULT_COLOR.section,
        locked,
        source: 'manual',
      }),
    );
    nodes.push(
      createStructureNode({
        id: `${range.section.id}-shot-1`,
        level: 'shot',
        parentId: range.section.id,
        name: PLACEHOLDER_SHOT_NAME,
        startMs: range.startMs,
        color: LEVEL_DEFAULT_COLOR.shot,
        source: 'manual',
      }),
    );
  });
  return sortStructure(nodes);
}