import type { CurveNode, SegmentOutMode } from './api-types';

/**
 * 曲线几何核心（规格 5：初始曲线、节点、自动平滑、贝塞尔控制柄、
 * 自由画局部替换、夹紧与去重）——纯函数，无 DOM / 文件系统依赖。
 *
 * 关键约定（规格 5.1 / 5.3 / 11.2）：
 * - 节点时间严格递增，最小相邻差 1ms；首尾节点时间固定为 0 / durationMs。
 * - 段 [node[i], node[i+1]] 的模式由**左节点** outMode 决定。
 * - auto（自动平滑）：形状保持的分段三次（单调性保持的 Hermite），
 *   保证 0—100 值域内不产生超范围尖峰（规格 5.3）。
 * - bezier：使用左节点出柄 + 右节点入柄，缺失时按段 1/3、2/3 的直线
 *   控制点补全；按时间求值必须反解参数 u（二分），不得把归一化时间当 u。
 * - 控制柄约束：x0 ≤ c1x ≤ c2x ≤ x1（时间单调），纵值限制 0—100。
 *
 * 所有编辑函数返回**新数组**（不修改入参），便于配合撤销/重做快照。
 */

export const VALUE_MIN = 0;
export const VALUE_MAX = 100;
/** 相邻节点最小时间差（规格 5.1）。 */
export const MIN_NODE_GAP_MS = 1;

export interface Point {
  timeMs: number;
  value: number;
}

export function clamp(value: number, min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (Number.isNaN(value)) {
    return lo;
  }
  return Math.min(hi, Math.max(lo, value));
}

function clampValue(value: number): number {
  return clamp(value, VALUE_MIN, VALUE_MAX);
}

/** 返回 timeMs 所在段的左端点下标；位于首节点之前返回 0，末节点之后返回 n-2。 */
export function findSegmentIndex(nodes: readonly CurveNode[], timeMs: number): number {
  const n = nodes.length;
  if (n < 2) {
    return 0;
  }
  const first = nodes[0];
  const last = nodes[n - 1];
  if (first === undefined || last === undefined) {
    return 0;
  }
  if (timeMs <= first.timeMs) {
    return 0;
  }
  if (timeMs >= last.timeMs) {
    return n - 2;
  }
  // 二分：节点时间严格递增，找最大的 i 使 nodes[i].timeMs ≤ timeMs。
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    const node = nodes[mid];
    if (node !== undefined && node.timeMs <= timeMs) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/* ------------------------------------------------------------------ */
/* 自动平滑：形状保持的单调三次 Hermite（Fritsch–Carlson 限幅）             */
/* ------------------------------------------------------------------ */

/**
 * 计算每个节点的切线斜率（dv/dx），并施加 Fritsch–Carlson 单调性限幅。
 * 结果保证：分段三次 Hermite 在相邻节点之间单调（不越过端点值），
 * 因而对 0—100 的节点不会产生超范围尖峰。
 */
export function computeAutoTangents(nodes: readonly CurveNode[]): number[] {
  const n = nodes.length;
  const m = new Array<number>(n).fill(0);
  if (n < 2) {
    return m;
  }
  const slope = new Array<number>(n - 1).fill(0);
  for (let i = 0; i < n - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (a === undefined || b === undefined) {
      continue;
    }
    const dx = b.timeMs - a.timeMs;
    slope[i] = dx > 0 ? (b.value - a.value) / dx : 0;
  }
  const first = slope[0] ?? 0;
  const lastSlope = slope[n - 2] ?? 0;
  m[0] = first;
  m[n - 1] = lastSlope;
  for (let i = 1; i < n - 1; i++) {
    const s0 = slope[i - 1] ?? 0;
    const s1 = slope[i] ?? 0;
    m[i] = s0 * s1 <= 0 ? 0 : (s0 + s1) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    const s = slope[i] ?? 0;
    if (s === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] ?? 0) / s;
    const b = (m[i + 1] ?? 0) / s;
    const sum = a * a + b * b;
    if (sum > 9) {
      const tau = 3 / Math.sqrt(sum);
      m[i] = tau * a * s;
      m[i + 1] = tau * b * s;
    }
  }
  return m;
}

function hermite(x0: number, v0: number, x1: number, v1: number, m0: number, m1: number, t: number): number {
  const h = x1 - x0;
  if (h <= 0) {
    return clampValue(v0);
  }
  const s = (t - x0) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return h00 * v0 + h10 * h * m0 + h01 * v1 + h11 * h * m1;
}

/* ------------------------------------------------------------------ */
/* 贝塞尔：按时间反解参数 u                                              */
/* ------------------------------------------------------------------ */

function cubicAt(a: number, b: number, c: number, d: number, u: number): number {
  const mu = 1 - u;
  return mu * mu * mu * a + 3 * mu * mu * u * b + 3 * mu * u * u * c + u * u * u * d;
}

/** 反解 X(u) = t 的参数 u（X 关于 u 单调时唯一；二分足够精度）。 */
export function solveBezierParam(x0: number, c1x: number, c2x: number, x1: number, t: number): number {
  if (t <= x0) {
    return 0;
  }
  if (t >= x1) {
    return 1;
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (cubicAt(x0, c1x, c2x, x1, mid) < t) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

export interface BezierControls {
  c1x: number;
  c1v: number;
  c2x: number;
  c2v: number;
}

/** 计算段的绝对控制点（缺失柄按 1/3、2/3 直线补全；并夹紧顺序与纵值）。 */
export function bezierControls(a: CurveNode, b: CurveNode): BezierControls {
  const x0 = a.timeMs;
  const x1 = b.timeMs;
  const third = (x1 - x0) / 3;
  // 缺失手柄按段 1/3、2/3 的“直线控制点”补全：控制点落在两端的直线上，
  // 故该段退化为直线（X、Y 关于 u 均为线性）。
  const dvThird = (b.value - a.value) / 3;
  let c1x = a.outHandle ? x0 + a.outHandle.dtMs : x0 + third;
  let c1v = a.outHandle ? a.value + a.outHandle.dv : a.value + dvThird;
  let c2x = b.inHandle ? x1 + b.inHandle.dtMs : x1 - third;
  let c2v = b.inHandle ? b.value + b.inHandle.dv : b.value - dvThird;
  c1x = clamp(c1x, x0, x1);
  c2x = clamp(c2x, x0, x1);
  if (c1x > c2x) {
    const mid = (c1x + c2x) / 2;
    c1x = mid;
    c2x = mid;
  }
  c1v = clampValue(c1v);
  c2v = clampValue(c2v);
  return { c1x, c1v, c2x, c2v };
}

/* ------------------------------------------------------------------ */
/* 曲线求值器                                                            */
/* ------------------------------------------------------------------ */

export interface CurveEvaluator {
  /** 曲线在 timeMs 的值（0—100）。 */
  at(timeMs: number): number;
  /** 在 [fromMs, toMs] 均匀采样 count 个点（含端点），供 SVG 折线绘制。 */
  sample(fromMs: number, toMs: number, count: number): Point[];
}

/**
 * 创建求值器：预计算整条曲线的自动平滑切线（避免逐点重复 O(n) 计算）。
 * evaluator.at 对 auto 段复用预计算切线；bezier 段按其控制点反解。
 */
export function createCurveEvaluator(nodes: readonly CurveNode[]): CurveEvaluator {
  const m = computeAutoTangents(nodes);
  const n = nodes.length;

  const at = (timeMs: number): number => {
    if (n === 0) {
      return 0;
    }
    const firstNode = nodes[0];
    const lastNode = nodes[n - 1];
    if (firstNode === undefined) {
      return 0;
    }
    if (n === 1) {
      return clampValue(firstNode.value);
    }
    if (lastNode === undefined) {
      return clampValue(firstNode.value);
    }
    if (timeMs <= firstNode.timeMs) {
      return clampValue(firstNode.value);
    }
    if (timeMs >= lastNode.timeMs) {
      return clampValue(lastNode.value);
    }
    const i = findSegmentIndex(nodes, timeMs);
    const a = nodes[i];
    const b = nodes[i + 1];
    if (a === undefined || b === undefined) {
      return clampValue(firstNode.value);
    }
    switch (a.outMode) {
      case 'linear': {
        const span = b.timeMs - a.timeMs;
        const ratio = span > 0 ? (timeMs - a.timeMs) / span : 0;
        return clampValue(a.value + ratio * (b.value - a.value));
      }
      case 'bezier': {
        const { c1x, c1v, c2x, c2v } = bezierControls(a, b);
        const u = solveBezierParam(a.timeMs, c1x, c2x, b.timeMs, timeMs);
        return clampValue(cubicAt(a.value, c1v, c2v, b.value, u));
      }
      case 'auto':
      default:
        return clampValue(
          hermite(a.timeMs, a.value, b.timeMs, b.value, m[i] ?? 0, m[i + 1] ?? 0, timeMs),
        );
    }
  };

  const sample = (fromMs: number, toMs: number, count: number): Point[] => {
    const points: Point[] = [];
    const steps = Math.max(1, Math.floor(count) - 1);
    if (toMs <= fromMs) {
      return [{ timeMs: fromMs, value: at(fromMs) }];
    }
    for (let k = 0; k <= steps; k++) {
      const t = fromMs + ((toMs - fromMs) * k) / steps;
      points.push({ timeMs: t, value: at(t) });
    }
    return points;
  };

  return { at, sample };
}

/** 便捷封装：对少量调用点直接求值（内部临时建求值器）。 */
export function evaluateCurveAt(nodes: readonly CurveNode[], timeMs: number): number {
  return createCurveEvaluator(nodes).at(timeMs);
}

/* ------------------------------------------------------------------ */
/* 控制柄夹紧                                                            */
/* ------------------------------------------------------------------ */

/** 逐段夹紧贝塞尔控制点，保持 x0 ≤ c1x ≤ c2x ≤ x1 与纵值 0—100。 */
export function clampAllHandles(nodes: readonly CurveNode[]): CurveNode[] {
  const out: CurveNode[] = nodes.map((node) => ({
    ...node,
    inHandle: node.inHandle ? { ...node.inHandle } : null,
    outHandle: node.outHandle ? { ...node.outHandle } : null,
  }));
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i];
    const b = out[i + 1];
    if (a === undefined || b === undefined || a.outMode !== 'bezier') {
      continue;
    }
    const x0 = a.timeMs;
    const x1 = b.timeMs;
    const { c1x, c1v, c2x, c2v } = bezierControls(a, b);
    a.outHandle = { dtMs: c1x - x0, dv: c1v - a.value };
    b.inHandle = { dtMs: c2x - x1, dv: c2v - b.value };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 节点插入 / 删除 / 移动                                                */
/* ------------------------------------------------------------------ */

/**
 * 在 timeMs 插入节点（保持原曲线形状）：
 * - bezier 段：de Casteljau 分割，保持形状与两侧控制柄；
 * - auto/linear 段：新节点值取原曲线该时间值，模式 auto（相邻自动段允许重新求形）。
 * 时间落在端点或已有节点上时返回原数组（不变）。
 */
export function insertNodeAtTime(
  nodes: readonly CurveNode[],
  timeMs: number,
  newId: string,
): CurveNode[] {
  const n = nodes.length;
  if (n < 2) {
    return [...nodes];
  }
  const first = nodes[0];
  const last = nodes[n - 1];
  if (first === undefined || last === undefined) {
    return [...nodes];
  }
  if (timeMs <= first.timeMs || timeMs >= last.timeMs) {
    return [...nodes];
  }
  const i = findSegmentIndex(nodes, timeMs);
  const a = nodes[i];
  const b = nodes[i + 1];
  if (a === undefined || b === undefined) {
    return [...nodes];
  }
  if (a.timeMs === timeMs || b.timeMs === timeMs) {
    return [...nodes];
  }

  const out = nodes.map((node) => ({ ...node }));
  const aCopy = out[i];
  const bCopy = out[i + 1];
  if (aCopy === undefined || bCopy === undefined) {
    return [...nodes];
  }

  if (a.outMode === 'bezier') {
    const { c1x, c1v, c2x, c2v } = bezierControls(a, b);
    const u = solveBezierParam(a.timeMs, c1x, c2x, b.timeMs, timeMs);
    const lerp = (p: number, q: number): number => p + (q - p) * u;
    const q0x = lerp(a.timeMs, c1x);
    const q0v = lerp(a.value, c1v);
    const q1x = lerp(c1x, c2x);
    const q1v = lerp(c1v, c2v);
    const q2x = lerp(c2x, b.timeMs);
    const q2v = lerp(c2v, b.value);
    const r0x = lerp(q0x, q1x);
    const r0v = lerp(q0v, q1v);
    const r1x = lerp(q1x, q2x);
    const r1v = lerp(q1v, q2v);
    const sx = lerp(r0x, r1x);
    const sv = lerp(r0v, r1v);
    const inserted: CurveNode = {
      id: newId,
      timeMs: sx,
      value: clampValue(sv),
      outMode: 'bezier',
      inHandle: { dtMs: r0x - sx, dv: r0v - sv },
      outHandle: { dtMs: r1x - sx, dv: r1v - sv },
    };
    aCopy.outHandle = { dtMs: q0x - a.timeMs, dv: q0v - a.value };
    bCopy.inHandle = { dtMs: q2x - b.timeMs, dv: q2v - b.value };
    out.splice(i + 1, 0, inserted);
    return clampAllHandles(out);
  }

  const value = createCurveEvaluator(nodes).at(timeMs);
  const inserted: CurveNode = {
    id: newId,
    timeMs,
    value: clampValue(value),
    outMode: 'auto',
    inHandle: null,
    outHandle: null,
  };
  out.splice(i + 1, 0, inserted);
  return out;
}

/**
 * 按点击值插入节点（节点工具）：值为点击高度，模式 auto（形成自动平滑曲线）。
 * 时间夹紧到端点内侧；与相邻节点间隔不足 1ms 时不插入（返回原数组）。
 */
export function insertNodeWithValue(
  nodes: readonly CurveNode[],
  timeMs: number,
  value: number,
  newId: string,
): CurveNode[] {
  const n = nodes.length;
  if (n < 2) {
    return [...nodes];
  }
  const first = nodes[0];
  const last = nodes[n - 1];
  if (first === undefined || last === undefined) {
    return [...nodes];
  }
  const t = Math.round(timeMs);
  // 端点处不新增节点（端点高度用端点编辑/属性面板修改）；也不允许贴太近。
  if (t <= first.timeMs || t >= last.timeMs) {
    return [...nodes];
  }
  let insertAt = 1;
  while (insertAt < n && (nodes[insertAt]?.timeMs ?? 0) <= t) {
    insertAt += 1;
  }
  const left = nodes[insertAt - 1];
  const right = nodes[insertAt];
  if (right !== undefined && right.timeMs - t < MIN_NODE_GAP_MS) {
    return [...nodes];
  }
  if (left !== undefined && t - left.timeMs < MIN_NODE_GAP_MS) {
    return [...nodes];
  }
  const out = nodes.map((node) => ({ ...node }));
  out.splice(insertAt, 0, {
    id: newId,
    timeMs: t,
    value: clampValue(value),
    outMode: 'auto',
    inHandle: null,
    outHandle: null,
  });
  return clampAllHandles(out);
}

/** 删除普通节点；首尾节点保留。删除后连接段恢复自动平滑（清除相邻显式柄）。 */
export function removeNode(nodes: readonly CurveNode[], id: string): CurveNode[] {
  const index = nodes.findIndex((node) => node.id === id);
  if (index <= 0 || index >= nodes.length - 1) {
    return [...nodes];
  }
  const out = nodes.filter((_, k) => k !== index).map((node) => ({ ...node }));
  const prev = out[index - 1];
  const next = out[index];
  if (prev !== undefined) {
    prev.outMode = 'auto';
    prev.outHandle = null;
  }
  if (next !== undefined) {
    next.inHandle = null;
  }
  return out;
}

export interface MoveNodesResult {
  nodes: CurveNode[];
  /** 实际施加的时间位移（可能被夹紧）。 */
  appliedTimeMs: number;
  /** 实际施加的值位移。 */
  appliedValue: number;
}

/**
 * 多节点统一位移（规格 5.3）：
 * - 时间位移对整组统一夹紧（不能逐个夹紧导致相互挤压）；
 * - 组内包含首尾端点时横向位移固定为 0，纵向仍可整体移动至边界；
 * - 值位移统一夹紧，使所有被移动节点仍在 0—100；
 * - 控制柄随节点一同移动，随后重新夹紧受影响段。
 */
export function moveNodes(
  nodes: readonly CurveNode[],
  ids: readonly string[],
  dTimeMs: number,
  dValue: number,
): MoveNodesResult {
  const idSet = new Set(ids);
  const indices = nodes
    .map((node, index) => ({ node, index }))
    .filter((entry) => idSet.has(entry.node.id))
    .map((entry) => entry.index);
  if (indices.length === 0) {
    return { nodes: [...nodes], appliedTimeMs: 0, appliedValue: 0 };
  }

  const n = nodes.length;
  const first = nodes[0];
  const last = nodes[n - 1];
  const containsEndpoint =
    indices.includes(0) || indices.includes(n - 1) ||
    (first !== undefined && indices.some((i) => nodes[i]?.timeMs === first.timeMs)) ||
    (last !== undefined && indices.some((i) => nodes[i]?.timeMs === last.timeMs));

  let appliedTime = containsEndpoint ? 0 : Math.round(dTimeMs);

  if (appliedTime !== 0) {
    // 统一夹紧：仅考虑“移动组边界处未被移动的邻居”。
    let maxShift = Number.POSITIVE_INFINITY;
    let minShift = Number.NEGATIVE_INFINITY;
    for (const i of indices) {
      const node = nodes[i];
      if (node === undefined) {
        continue;
      }
      const rightNeighbor = nodes[i + 1];
      if (rightNeighbor !== undefined && !idSet.has(rightNeighbor.id)) {
        maxShift = Math.min(maxShift, rightNeighbor.timeMs - node.timeMs - MIN_NODE_GAP_MS);
      }
      const leftNeighbor = nodes[i - 1];
      if (leftNeighbor !== undefined && !idSet.has(leftNeighbor.id)) {
        minShift = Math.max(minShift, leftNeighbor.timeMs - node.timeMs + MIN_NODE_GAP_MS);
      }
    }
    appliedTime = clamp(appliedTime, minShift, maxShift);
  }

  // 值位移统一夹紧。
  let maxValueShift = Number.POSITIVE_INFINITY;
  let minValueShift = Number.NEGATIVE_INFINITY;
  for (const i of indices) {
    const node = nodes[i];
    if (node === undefined) {
      continue;
    }
    maxValueShift = Math.min(maxValueShift, VALUE_MAX - node.value);
    minValueShift = Math.max(minValueShift, VALUE_MIN - node.value);
  }
  const appliedValue = clamp(dValue, minValueShift, maxValueShift);

  const out = nodes.map((node, index) => {
    if (!indices.includes(index)) {
      return { ...node };
    }
    return {
      ...node,
      timeMs: node.timeMs + appliedTime,
      value: clampValue(node.value + appliedValue),
    };
  });
  return { nodes: clampAllHandles(out), appliedTimeMs: appliedTime, appliedValue };
}

/* ------------------------------------------------------------------ */
/* 段模式切换                                                            */
/* ------------------------------------------------------------------ */

/**
 * 设置段 [i, i+1] 的模式（规格 5.3）：
 * - 切到 bezier：把当前 auto/linear 段转换为**等形**的显式三次贝塞尔
 *   （用当前切线计算 1/3、2/3 控制点），形状不跳变；
 * - 切到 linear/auto：清除该段两侧显式柄。
 */
export function setSegmentOutMode(
  nodes: readonly CurveNode[],
  i: number,
  mode: SegmentOutMode,
): CurveNode[] {
  const n = nodes.length;
  if (i < 0 || i >= n - 1) {
    return [...nodes];
  }
  const out = nodes.map((node) => ({ ...node }));
  const a = out[i];
  const b = out[i + 1];
  if (a === undefined || b === undefined) {
    return [...nodes];
  }
  if (mode !== 'bezier') {
    a.outMode = mode;
    a.outHandle = null;
    b.inHandle = null;
    return out;
  }
  // 等形转换：用当前切线构造控制点。
  const h = b.timeMs - a.timeMs;
  let m0: number;
  let m1: number;
  if (a.outMode === 'auto') {
    const tangents = computeAutoTangents(nodes);
    m0 = tangents[i] ?? 0;
    m1 = tangents[i + 1] ?? 0;
  } else {
    const slope = h > 0 ? (b.value - a.value) / h : 0;
    m0 = slope;
    m1 = slope;
  }
  const c1x = a.timeMs + h / 3;
  const c1v = clampValue(a.value + (m0 * h) / 3);
  const c2x = b.timeMs - h / 3;
  const c2v = clampValue(b.value - (m1 * h) / 3);
  a.outMode = 'bezier';
  a.outHandle = { dtMs: c1x - a.timeMs, dv: c1v - a.value };
  b.inHandle = { dtMs: c2x - b.timeMs, dv: c2v - b.value };
  return out;
}

/* ------------------------------------------------------------------ */
/* 自由画 / 直线的局部替换（规格 5.4）                                    */
/* ------------------------------------------------------------------ */

function ensureBoundary(
  nodes: CurveNode[],
  evaluator: CurveEvaluator,
  timeMs: number,
  idFactory: () => string,
): { nodes: CurveNode[]; index: number } {
  const exact = nodes.findIndex((node) => node.timeMs === timeMs);
  if (exact >= 0) {
    return { nodes, index: exact };
  }
  const inserted = insertNodeAtTime(nodes, timeMs, idFactory());
  const index = inserted.findIndex((node) => node.timeMs === timeMs);
  if (index < 0) {
    // 极少数浮点/边界情形：退化为最近节点。
    const value = evaluator.at(timeMs);
    inserted.push({ id: idFactory(), timeMs, value: clampValue(value), outMode: 'auto', inHandle: null, outHandle: null });
    inserted.sort((p, q) => p.timeMs - q.timeMs);
    return { nodes: inserted, index: inserted.findIndex((node) => node.timeMs === timeMs) };
  }
  return { nodes: inserted, index };
}

export interface ReplaceRangeOptions {
  /** 直线工具：起止之间不插中间点，且起段模式设为 linear。 */
  lineMode?: boolean;
  /** 中间采样点（不含起止），按时间升序、值 0—100。 */
  interior: readonly Point[];
  /** 项目时长；用于判断端点是否位于视频首尾（可修改端点高度）。 */
  durationMs: number;
  idFactory: () => string;
}

/**
 * 用一段新轨迹局部替换 [startMs, endMs]（规格 5.4）：
 * - 区间外节点与曲段原形保留（通过边界处“等形插点 + 删除区间内节点”实现）；
 * - 新轨迹两端与旧线在边界处连续：普通局部重画边界值取原曲线值；
 *   startMs ≤ 0 或 endMs ≥ durationMs 时可直接修改对应端点高度；
 * - 区间外标注时间不受影响（由调用方保证：本函数只改节点）。
 *
 * 调用方需保证 startMs < endMs；返回新节点数组。
 */
export function replaceRange(
  nodes: readonly CurveNode[],
  startMs: number,
  endMs: number,
  options: ReplaceRangeOptions,
): CurveNode[] {
  if (!(startMs < endMs)) {
    return [...nodes];
  }
  const durationMs = options.durationMs;
  const evaluator = createCurveEvaluator(nodes);
  const originalStartValue = evaluator.at(startMs);

  // 1) 在边界处等形插点（保持区间外原形）。
  let working = nodes.map((node) => ({ ...node }));
  const startRes = ensureBoundary(working, evaluator, startMs, options.idFactory);
  working = startRes.nodes;
  const startIndex = startRes.index;
  const endRes = ensureBoundary(working, evaluator, endMs, options.idFactory);
  working = endRes.nodes;
  const endIndex = endRes.index;
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    return [...nodes];
  }

  // 2) 删除区间内部节点。
  const startNode = working[startIndex];
  const endNode = working[endIndex];
  if (startNode === undefined || endNode === undefined) {
    return [...nodes];
  }
  const kept: CurveNode[] = working.filter((_, k) => k <= startIndex || k >= endIndex);

  // 3) 端点吸附：普通局部重画取原曲线边界值；首/尾端点可直接改高度。
  if (startMs > 0) {
    startNode.value = clampValue(originalStartValue);
  } else {
    const firstInterior = options.interior[0];
    if (firstInterior !== undefined) {
      startNode.value = clampValue(firstInterior.value);
    }
  }
  if (endMs < durationMs) {
    endNode.value = clampValue(evaluator.at(endMs));
  } else {
    const lastInterior = options.interior[options.interior.length - 1];
    if (lastInterior !== undefined) {
      endNode.value = clampValue(lastInterior.value);
    }
  }

  // 4) 插入中间采样点（直线模式不插）。
  const insertedInterior: CurveNode[] = options.lineMode
    ? []
    : options.interior.map((point) => ({
        id: options.idFactory(),
        timeMs: Math.round(clamp(point.timeMs, startMs + MIN_NODE_GAP_MS, endMs - MIN_NODE_GAP_MS)),
        value: clampValue(point.value),
        outMode: 'auto' as SegmentOutMode,
        inHandle: null,
        outHandle: null,
      }));

  // 5) 段模式：起段直线/自动；末节点保留原 outMode（其右侧段形状不变）。
  startNode.outMode = options.lineMode ? 'linear' : 'auto';
  startNode.inHandle = null;
  startNode.outHandle = null;

  const merged: CurveNode[] = [];
  for (const node of kept) {
    merged.push(node);
    if (node === startNode) {
      for (const inner of insertedInterior) {
        merged.push(inner);
      }
    }
  }
  // 去重 + 排序（防御：中间点可能落在边界外被夹紧后重合）。
  const deduped: CurveNode[] = [];
  for (const node of merged.sort((p, q) => p.timeMs - q.timeMs)) {
    const prev = deduped[deduped.length - 1];
    if (prev !== undefined && node.timeMs - prev.timeMs < MIN_NODE_GAP_MS) {
      continue;
    }
    deduped.push(node);
  }
  return clampAllHandles(deduped);
}

/* ------------------------------------------------------------------ */
/* 折线简化（RDP，按像素容差调用，规格 5.4 第 3 条）                       */
/* ------------------------------------------------------------------ */

export interface PolyPoint {
  x: number;
  y: number;
}

function perpendicularDistance(p: PolyPoint, a: PolyPoint, b: PolyPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

/**
 * Ramer–Douglas–Peucker 简化（输入须为与容差同量纲的坐标，通常为像素）。
 * 返回保留的点（保持首尾）。调用方负责像素↔时间/值换算。
 */
export function simplifyPolyline(points: readonly PolyPoint[], tolerance: number): PolyPoint[] {
  if (points.length <= 2) {
    return [...points];
  }
  const tol = Math.max(0, tolerance);
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) {
    return [...points];
  }
  let maxDist = 0;
  let index = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    if (p === undefined) {
      continue;
    }
    const dist = perpendicularDistance(p, first, last);
    if (dist > maxDist) {
      maxDist = dist;
      index = i;
    }
  }
  if (maxDist <= tol || index < 0) {
    return [first, last];
  }
  const left = simplifyPolyline(points.slice(0, index + 1), tol);
  const right = simplifyPolyline(points.slice(index), tol);
  return [...left.slice(0, -1), ...right];
}