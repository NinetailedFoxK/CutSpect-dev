/**
 * 曲线编辑工具状态机与命中优先级（规格 5.2 / 5.5 / 14）。
 *
 * 纯逻辑（无 DOM）：工具定义、快捷键映射、命中候选的优先级挑选。
 * 具体几何与手势在 CurveLayer 组件内实现；本模块保证“工具 ↔ 快捷键 ↔
 * 命中优先级”单一来源，便于单测与避免散落。
 */

export type ToolId = 'select' | 'node' | 'freehand' | 'line' | 'note' | 'section';

export interface ToolMeta {
  id: ToolId;
  label: string;
  /** 快捷键小写字母（规格 14）。 */
  shortcut: string;
  /** 展示用大写键位。 */
  keyHint: string;
  description: string;
}

export const TOOLS: readonly ToolMeta[] = [
  { id: 'select', label: '选择', shortcut: 'v', keyHint: 'V', description: '选择/移动节点、框选、双击加节点' },
  { id: 'node', label: '节点', shortcut: 'p', keyHint: 'P', description: '点击画布添加节点' },
  { id: 'freehand', label: '自由画', shortcut: 'b', keyHint: 'B', description: '按住指针从左往右绘制' },
  { id: 'line', label: '直线', shortcut: 'd', keyHint: 'D', description: '拖拽把一段替换为直线' },
  { id: 'note', label: '标注', shortcut: 'n', keyHint: 'N', description: '在曲线上添加标注（阶段 C）' },
  { id: 'section', label: '分段', shortcut: 's', keyHint: 'S', description: '添加分段边界（阶段 C）' },
];

/** 阶段 C 已实现的工具（标注 M / 分段 S 已接入）。 */
export const IMPLEMENTED_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>([
  'select',
  'node',
  'freehand',
  'line',
  'note',
  'section',
]);

/** 快捷键 → 工具（仅单字母，大小写不敏感；无匹配返回 null）。 */
export function toolForShortcut(key: string): ToolId | null {
  if (key.length !== 1) {
    return null;
  }
  const lower = key.toLowerCase();
  return TOOLS.find((tool) => tool.shortcut === lower)?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* 命中优先级（规格 5.5）                                                 */
/* ------------------------------------------------------------------ */

export type HitKind = 'handle' | 'node' | 'annotation' | 'boundary' | 'section' | 'curve';

export interface HitCandidate {
  kind: HitKind;
  /** 命中的对象 id（节点/标注/边界/段左节点）。 */
  id: string;
  /** 与指针的像素距离。 */
  distancePx: number;
  /** 控制柄命中的侧别。 */
  side?: 'in' | 'out';
}

/** 命中优先级：活动控制柄 > 曲线节点 > 标注点 > 分段线 > 段落名 > 曲线 > 空白。 */
const PICK_ORDER: readonly HitKind[] = [
  'handle',
  'node',
  'annotation',
  'boundary',
  'section',
  'curve',
];

/**
 * 在候选集合中按优先级挑选命中项：优先取更高优先级类别中距离最近、
 * 且在半径内的候选；半径内无任何候选返回 null（空白）。
 */
export function pickHit(candidates: readonly HitCandidate[], radiusPx = 8): HitCandidate | null {
  for (const kind of PICK_ORDER) {
    let best: HitCandidate | null = null;
    for (const candidate of candidates) {
      if (candidate.kind !== kind || candidate.distancePx > radiusPx) {
        continue;
      }
      if (best === null || candidate.distancePx < best.distancePx) {
        best = candidate;
      }
    }
    if (best !== null) {
      return best;
    }
  }
  return null;
}