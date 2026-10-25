import { describe, expect, it } from 'vitest';
import type { CurveNode } from '../src/shared/api-types';
import {
  bezierControls,
  clampAllHandles,

  createCurveEvaluator,
  evaluateCurveAt,
  findSegmentIndex,
  insertNodeAtTime,
  insertNodeWithValue,
  moveNodes,
  removeNode,
  replaceRange,
  setSegmentOutMode,
  simplifyPolyline,
  solveBezierParam,
} from '../src/shared/geometry';

/**
 * 曲线几何核心测试（规格 5）。
 * 重点：自动平滑无过冲、贝塞尔按时间反解、节点增删移动夹紧、
 * 自由画局部替换区间外不变与边界连续。
 */

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `n${idCounter}`;
}

function node(
  id: string,
  timeMs: number,
  value: number,
  outMode: CurveNode['outMode'] = 'auto',
): CurveNode {
  return { id, timeMs, value, outMode, inHandle: null, outHandle: null };
}

describe('computeAutoTangents / 自动平滑（规格 5.3 形状保持）', () => {
  it('单调数据不产生超范围过冲（0—100 内）', () => {
    const nodes = [node('a', 0, 0), node('b', 5_000, 100), node('c', 10_000, 20)];
    const evaluator = createCurveEvaluator(nodes);
    const points = evaluator.sample(0, 10_000, 400);
    const values = points.map((p) => p.value);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(100);
  });

  it('平坦段切线与端点值一致（水平线保持水平）', () => {
    const nodes = [node('a', 0, 50), node('b', 10_000, 50)];
    const evaluator = createCurveEvaluator(nodes);
    for (let t = 0; t <= 10_000; t += 1_000) {
      expect(evaluator.at(t)).toBeCloseTo(50, 6);
    }
  });

  it('端点处取值等于节点值', () => {
    const nodes = [node('a', 0, 10), node('b', 10_000, 90)];
    const evaluator = createCurveEvaluator(nodes);
    expect(evaluator.at(0)).toBeCloseTo(10, 6);
    expect(evaluator.at(10_000)).toBeCloseTo(90, 6);
  });
});

describe('findSegmentIndex / 线性段', () => {
  it('定位段并做线性插值', () => {
    const nodes = [node('a', 0, 0, 'linear'), node('b', 10_000, 100, 'linear')];
    expect(findSegmentIndex(nodes, 5_000)).toBe(0);
    expect(evaluateCurveAt(nodes, 5_000)).toBeCloseTo(50, 6);
    expect(evaluateCurveAt(nodes, 2_500)).toBeCloseTo(25, 6);
  });
});

describe('贝塞尔按时间反解（规格 5.3）', () => {
  it('缺失手柄的贝塞尔段退化为直线', () => {
    const nodes = [node('a', 0, 0, 'bezier'), node('b', 10_000, 100, 'auto')];
    expect(evaluateCurveAt(nodes, 5_000)).toBeCloseTo(50, 4);
    expect(evaluateCurveAt(nodes, 2_500)).toBeCloseTo(25, 4);
  });

  it('solveBezierParam 单调：给定时间反解的参数使 X(u)=t', () => {
    const { c1x, c2x } = bezierControls(node('a', 0, 0, 'bezier'), node('b', 10_000, 100));
    const u = solveBezierParam(0, c1x, c2x, 10_000, 3_000);
    const x = cubicPoint(0, c1x, c2x, 10_000, u);
    expect(Math.abs(x - 3_000)).toBeLessThan(0.5);
  });

  it('显式控制柄改变曲线形状但不越界', () => {
    const a = node('a', 0, 0, 'bezier');
    a.outHandle = { dtMs: 2_000, dv: 60 };
    const b = node('b', 10_000, 100, 'auto');
    b.inHandle = { dtMs: -2_000, dv: 40 };
    const values = createCurveEvaluator([a, b]).sample(0, 10_000, 200).map((p) => p.value);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(100);
    // 上凸控制柄使中点高于直线。
    expect(evaluateCurveAt([a, b], 5_000)).toBeGreaterThan(50);
  });
});

function cubicPoint(a: number, b: number, c: number, d: number, u: number): number {
  const mu = 1 - u;
  return mu * mu * mu * a + 3 * mu * mu * u * b + 3 * mu * u * u * c + u * u * u * d;
}

describe('insertNodeAtTime（规格 5.3）', () => {
  it('auto 段插点：值取原曲线该时间值，且原曲线形状基本保持', () => {
    const nodes = [node('a', 0, 0), node('b', 10_000, 100)];
    const before = createCurveEvaluator(nodes).at(4_000);
    const inserted = insertNodeAtTime(nodes, 4_000, nextId());
    expect(inserted).toHaveLength(3);
    const mid = inserted.find((n) => n.timeMs === 4_000);
    expect(mid?.value).toBeCloseTo(before, 6);
  });

  it('bezier 段插点：de Casteljau 分割保持形状', () => {
    const a = node('a', 0, 0, 'bezier');
    a.outHandle = { dtMs: 3_000, dv: 70 };
    const b = node('b', 10_000, 100, 'auto');
    b.inHandle = { dtMs: -3_000, dv: -20 };
    const before = createCurveEvaluator([a, b]);
    const inserted = insertNodeAtTime([a, b], 5_000, nextId());
    expect(inserted).toHaveLength(3);
    const after = createCurveEvaluator(inserted);
    for (let t = 0; t <= 10_000; t += 500) {
      expect(Math.abs(after.at(t) - before.at(t))).toBeLessThan(1);
    }
  });

  it('端点或已有节点处不插入', () => {
    const nodes = [node('a', 0, 0), node('b', 10_000, 100)];
    expect(insertNodeAtTime(nodes, 0, nextId())).toHaveLength(2);
    expect(insertNodeAtTime(nodes, 10_000, nextId())).toHaveLength(2);
  });
});

describe('insertNodeWithValue（节点工具：按点击值插入）', () => {
  it('按点击时间与值插入并夹紧到端点内侧', () => {
    const nodes = [node('a', 0, 50), node('b', 10_000, 50)];
    const next = insertNodeWithValue(nodes, 5_000, 80, nextId());
    expect(next).toHaveLength(3);
    const mid = next.find((n) => n.timeMs === 5_000);
    expect(mid?.value).toBe(80);
  });

  it('与已有节点间隔不足 1ms 时不插入', () => {
    const nodes = [node('a', 0, 50), node('b', 10_000, 50)];
    expect(insertNodeWithValue(nodes, 0, 80, nextId())).toHaveLength(2);
    expect(insertNodeWithValue(nodes, 10_000, 80, nextId())).toHaveLength(2);
  });
});

describe('removeNode / moveNodes（规格 5.3）', () => {
  it('删除普通节点后连接段恢复自动平滑；首尾不可删', () => {
    const nodes = [node('a', 0, 0), node('m', 5_000, 50, 'bezier'), node('b', 10_000, 100)];
    const removed = removeNode(nodes, 'm');
    expect(removed).toHaveLength(2);
    expect(removeNode(nodes, 'a')).toHaveLength(3);
    expect(removeNode(nodes, 'b')).toHaveLength(3);
  });

  it('多节点统一时间夹紧（不逐个挤压）', () => {
    const nodes = [node('a', 0, 0), node('m', 4_000, 40), node('n', 6_000, 60), node('b', 10_000, 100)];
    // 右侧邻居 b 在 10000：组 [m,n] 最右 n(6000) 可右移最多 10000-6000-1=3999。
    const result = moveNodes(nodes, ['m', 'n'], 9_999, 0);
    expect(result.appliedTimeMs).toBe(3_999);
    expect(result.nodes.find((x) => x.id === 'n')?.timeMs).toBe(9_999);
    expect(result.nodes.find((x) => x.id === 'm')?.timeMs).toBe(7_999);
  });

  it('包含端点时横向位移固定为 0，纵向仍可移动', () => {
    const nodes = [node('a', 0, 20), node('b', 10_000, 80)];
    const result = moveNodes(nodes, ['a'], 5_000, 30);
    expect(result.appliedTimeMs).toBe(0);
    expect(result.nodes[0]?.timeMs).toBe(0);
    expect(result.nodes[0]?.value).toBe(50);
  });

  it('值位移统一夹紧到 0—100', () => {
    const nodes = [node('a', 0, 0), node('m', 5_000, 90), node('b', 10_000, 100)];
    const result = moveNodes(nodes, ['m'], 0, 50);
    expect(result.nodes.find((x) => x.id === 'm')?.value).toBe(100);
  });
});

describe('setSegmentOutMode / clampAllHandles（规格 5.3 控制柄约束）', () => {
  it('auto → bezier 等形转换：形状不跳变', () => {
    const nodes = [node('a', 0, 0), node('b', 5_000, 80), node('c', 10_000, 40)];
    const before = createCurveEvaluator(nodes);
    const converted = setSegmentOutMode(nodes, 0, 'bezier');
    const after = createCurveEvaluator(converted);
    // 段 0 形状保持；段 1 仍为 auto。
    for (let t = 0; t <= 5_000; t += 250) {
      expect(Math.abs(after.at(t) - before.at(t))).toBeLessThan(1);
    }
    expect(converted[0]?.outMode).toBe('bezier');
    expect(converted[0]?.outHandle).not.toBeNull();
  });

  it('clampAllHandles 保证 x0 ≤ c1x ≤ c2x ≤ x1 与纵值 0—100', () => {
    const a = node('a', 0, 10, 'bezier');
    a.outHandle = { dtMs: 9_999, dv: 500 }; // 越界柄
    const b = node('b', 10_000, 20, 'auto');
    b.inHandle = { dtMs: -1, dv: -500 };
    const clamped = clampAllHandles([a, b]);
    const controls = bezierControls(clamped[0]!, clamped[1]!);
    expect(controls.c1x).toBeGreaterThanOrEqual(0);
    expect(controls.c1x).toBeLessThanOrEqual(controls.c2x);
    expect(controls.c2x).toBeLessThanOrEqual(10_000);
    expect(controls.c1v).toBeGreaterThanOrEqual(0);
    expect(controls.c1v).toBeLessThanOrEqual(100);
    expect(controls.c2v).toBeGreaterThanOrEqual(0);
    expect(controls.c2v).toBeLessThanOrEqual(100);
  });
});

describe('replaceRange（规格 5.4 自由画局部替换）', () => {
  it('区间外节点与曲线不变，区间内被替换', () => {
    const nodes = [node('a', 0, 0), node('b', 3_000, 30), node('c', 7_000, 70), node('d', 10_000, 100)];
    const replaced = replaceRange(nodes, 4_000, 6_000, {
      interior: [
        { timeMs: 4_500, value: 10 },
        { timeMs: 5_500, value: 90 },
      ],
      durationMs: 10_000,
      idFactory: nextId,
    });
    const evaluator = createCurveEvaluator(replaced);
    // 区间外（用节点定位）：0、3000、10000 处的节点仍存在。
    expect(replaced.some((n) => n.timeMs === 0)).toBe(true);
    expect(replaced.some((n) => n.timeMs === 3_000)).toBe(true);
    expect(replaced.some((n) => n.timeMs === 10_000)).toBe(true);
    // 区间外的曲线值保持（3000 之前与边界值一致）。
    expect(evaluator.at(3_000)).toBeCloseTo(30, 3);
  });

  it('两端与原曲线在边界处连续（普通局部重画取原曲线边界值）', () => {
    const nodes = [node('a', 0, 20), node('b', 10_000, 60)];
    const original = createCurveEvaluator(nodes);
    const startValue = original.at(4_000);
    const endValue = original.at(6_000);
    const replaced = replaceRange(nodes, 4_000, 6_000, {
      interior: [{ timeMs: 5_000, value: 5 }],
      durationMs: 10_000,
      idFactory: nextId,
    });
    const after = createCurveEvaluator(replaced);
    // 边界值连续（允许极小数值误差）。
    expect(Math.abs(after.at(4_000) - startValue)).toBeLessThan(0.5);
    expect(Math.abs(after.at(6_000) - endValue)).toBeLessThan(0.5);
  });

  it('起点在视频首端时可直接修改端点高度', () => {
    const nodes = [node('a', 0, 50), node('b', 10_000, 50)];
    const replaced = replaceRange(nodes, 0, 4_000, {
      interior: [{ timeMs: 2_000, value: 80 }],
      durationMs: 10_000,
      idFactory: nextId,
    });
    expect(replaced[0]?.timeMs).toBe(0);
    expect(replaced[0]?.value).toBeCloseTo(80, 0);
  });

  it('直线模式：起段变为直线', () => {
    const nodes = [node('a', 0, 0), node('b', 10_000, 100)];
    const replaced = replaceRange(nodes, 2_000, 8_000, {
      interior: [],
      lineMode: true,
      durationMs: 10_000,
      idFactory: nextId,
    });
    const start = replaced.find((n) => n.timeMs === 2_000);
    expect(start?.outMode).toBe('linear');
    expect(createCurveEvaluator(replaced).at(5_000)).toBeCloseTo(50, 0);
  });
});

describe('simplifyPolyline（规格 5.4 第 3 条：显示尺度简化）', () => {
  it('共线点被简化为端点', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];
    expect(simplifyPolyline(pts, 0.5)).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
    ]);
  });

  it('偏离超过容差的点被保留', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 5 },
      { x: 2, y: 0 },
    ];
    expect(simplifyPolyline(pts, 0.5)).toHaveLength(3);
  });
});