import { describe, expect, it } from 'vitest';
import type { StructureNode } from '../src/shared/api-types';
import {
  childrenOf,
  createStructureNode,
  deriveRanges,
  sortStructure,
  validateStructure,
} from '../src/shared/structure';
import {
  countEditableShots,
  isDefaultShotName,
  isPlaceholderShot,
  isProtectedShot,
  planShotsInRange,
  resolveShotTarget,
} from '../src/shared/structure-shots';
import { PLACEHOLDER_SHOT_NAME } from '../src/shared/shots';

/** 局部智能分镜（选中段落）纯逻辑测试：需求 4.2 的核心不变量。 */

const DURATION = 20_000;

function shotRange(structure: readonly StructureNode[], id: string): { startMs: number; endMs: number } {
  const range = deriveRanges(structure, DURATION).get(id);
  if (!range) throw new Error(`no range for ${id}`);
  return range;
}

function buildBasic(): StructureNode[] {
  return sortStructure([
    createStructureNode({ id: 'c1', level: 'chapter', parentId: null, name: '章节 1', startMs: 0 }),
    createStructureNode({ id: 's1', level: 'section', parentId: 'c1', name: '第一次尝试', startMs: 0, source: 'manual' }),
    createStructureNode({ id: 's1-shot-1', level: 'shot', parentId: 's1', name: PLACEHOLDER_SHOT_NAME, startMs: 0 }),
    createStructureNode({ id: 's2', level: 'section', parentId: 'c1', name: '第二次尝试', startMs: 10_000, source: 'manual' }),
    createStructureNode({ id: 's2-shot-1', level: 'shot', parentId: 's2', name: PLACEHOLDER_SHOT_NAME, startMs: 10_000 }),
  ]);
}

function shotsOf(structure: readonly StructureNode[], parentId: string): StructureNode[] {
  return childrenOf(structure, parentId, 'shot');
}

describe('isPlaceholderShot / isProtectedShot / isDefaultShotName', () => {
  it('占位镜头可被替换，用户手动或锁定镜头受保护', () => {
    const placeholder = createStructureNode({ id: 'x', level: 'shot', parentId: 's', name: PLACEHOLDER_SHOT_NAME, startMs: 0 });
    expect(isPlaceholderShot(placeholder)).toBe(true);
    expect(isProtectedShot(placeholder)).toBe(false);

    const manual = createStructureNode({ id: 'y', level: 'shot', parentId: 's', name: '开场', startMs: 0, source: 'manual' });
    expect(isProtectedShot(manual)).toBe(true);

    const locked = createStructureNode({ id: 'z', level: 'shot', parentId: 's', name: '镜头 3', startMs: 0, source: 'auto', locked: true });
    expect(isProtectedShot(locked)).toBe(true);
  });

  it('默认名称判定覆盖空名、占位名与“镜头 N”', () => {
    expect(isDefaultShotName('')).toBe(true);
    expect(isDefaultShotName(PLACEHOLDER_SHOT_NAME)).toBe(true);
    expect(isDefaultShotName('镜头 12')).toBe(true);
    expect(isDefaultShotName('开场')).toBe(false);
  });
});

describe('planShotsInRange：局部生成', () => {
  it('只在选中段落内生成镜头，覆盖完整且连续无空洞', () => {
    const result = planShotsInRange({
      structure: buildBasic(),
      durationMs: DURATION,
      parentId: 's1',
      cutTimes: [2800, 6200, 8600],
      idSeed: 'test',
    });
    expect(result.ok).toBe(true);
    const shots = shotsOf(result.structure, 's1');
    expect(shots.map((s) => s.name)).toEqual(['镜头 1', '镜头 2', '镜头 3', '镜头 4']);
    expect(shotRange(result.structure, shots[0]!.id)).toEqual({ startMs: 0, endMs: 2800 });
    expect(shotRange(result.structure, shots[3]!.id)).toEqual({ startMs: 8600, endMs: 10_000 });
    // 连续覆盖：每个镜头 end 等于下一个 start。
    for (let i = 0; i < shots.length - 1; i++) {
      expect(shotRange(result.structure, shots[i]!.id).endMs).toBe(shots[i + 1]!.startMs);
    }
    expect(result.detectedCount).toBe(3);
    expect(validateStructure(result.structure, DURATION)).toEqual([]);
  });

  it('选区外的段落与其他结构完全不变', () => {
    const before = buildBasic();
    const result = planShotsInRange({
      structure: before,
      durationMs: DURATION,
      parentId: 's1',
      cutTimes: [4000],
      idSeed: 'test',
    });
    const s2Before = shotsOf(before, 's2');
    const s2After = shotsOf(result.structure, 's2');
    expect(s2After.map((s) => s.id)).toEqual(s2Before.map((s) => s.id));
    expect(s2After.map((s) => s.name)).toEqual(s2Before.map((s) => s.name));
    // 章节与其他段落本身不变。
    expect(result.structure.find((n) => n.id === 's2')).toEqual(before.find((n) => n.id === 's2'));
  });

  it('选区外的检测切点被忽略，且不写入其他段落', () => {
    const result = planShotsInRange({
      structure: buildBasic(),
      durationMs: DURATION,
      parentId: 's1',
      cutTimes: [3000, 12_000, 15_000],
      idSeed: 'test',
    });
    const s1Shots = shotsOf(result.structure, 's1');
    expect(s1Shots.map((s) => s.startMs)).toEqual([0, 3000]);
    // s2 未被改动（仍是占位镜头）。
    expect(shotsOf(result.structure, 's2').map((s) => s.name)).toEqual([PLACEHOLDER_SHOT_NAME]);
  });

  it('没有任何内部切点时保留一个覆盖整个区域的镜头', () => {
    const result = planShotsInRange({
      structure: buildBasic(),
      durationMs: DURATION,
      parentId: 's1',
      cutTimes: [],
      idSeed: 'test',
    });
    const shots = shotsOf(result.structure, 's1');
    expect(shots).toHaveLength(1);
    expect(shots[0]!.name).toBe('镜头 1');
    expect(shotRange(result.structure, shots[0]!.id)).toEqual({ startMs: 0, endMs: 10_000 });
    expect(result.detectedCount).toBe(0);
  });

  it('靠近起点/终点与彼此过近的切点被去重/丢弃', () => {
    const result = planShotsInRange({
      structure: buildBasic(),
      durationMs: DURATION,
      parentId: 's1',
      // 100 距起点 < 最短镜头；3000 与 3200 过近；9900 距终点过近。
      cutTimes: [100, 3000, 3200, 4500, 4500, 9900],
      idSeed: 'test',
    });
    const starts = shotsOf(result.structure, 's1').map((s) => s.startMs);
    expect(starts).toEqual([0, 3000, 4500]);
  });

  it('最短镜头限制生效（过短的镜头被合并）', () => {
    const result = planShotsInRange({
      structure: buildBasic(),
      durationMs: DURATION,
      parentId: 's1',
      minShotMs: 1000,
      cutTimes: [400, 2500, 2600],
      idSeed: 'test',
    });
    const starts = shotsOf(result.structure, 's1').map((s) => s.startMs);
    // 400 与起点 0 相距 <1000 丢弃；2600 与 2500 相距 <1000 丢弃。
    expect(starts).toEqual([0, 2500]);
  });
});

describe('planShotsInRange：与已有镜头共存', () => {
  function withExisting(): StructureNode[] {
    return sortStructure([
      createStructureNode({ id: 'c1', level: 'chapter', parentId: null, name: '章节 1', startMs: 0 }),
      createStructureNode({ id: 's1', level: 'section', parentId: 'c1', name: '段落', startMs: 0, source: 'manual' }),
      createStructureNode({ id: 's1-shot-a', level: 'shot', parentId: 's1', name: '开场', startMs: 0, source: 'manual' }),
      createStructureNode({ id: 's1-shot-b', level: 'shot', parentId: 's1', name: PLACEHOLDER_SHOT_NAME, startMs: 4000 }),
      createStructureNode({ id: 's1-shot-c', level: 'shot', parentId: 's1', name: PLACEHOLDER_SHOT_NAME, startMs: 8000 }),
    ]);
  }

  it('锁定 / 手动镜头被保留，自动镜头被重新识别替换', () => {
    const result = planShotsInRange({
      structure: withExisting(),
      durationMs: DURATION,
      parentId: 's1',
      cutTimes: [6000],
      strategy: 'replace-auto',
      idSeed: 'test',
    });
    const shots = shotsOf(result.structure, 's1');
    // 保留“开场”（0—4000），选区内 4000 之后由 6000 切分为 2 镜头。
    expect(shots[0]!.name).toBe('开场');
    expect(shotRange(result.structure, shots[0]!.id)).toEqual({ startMs: 0, endMs: 4000 });
    const starts = shots.map((s) => s.startMs);
    expect(starts).toEqual([0, 4000, 6000]);
    expect(result.preservedCount).toBe(1);
    expect(validateStructure(result.structure, DURATION)).toEqual([]);
  });

  it('锁定镜头不会被删除或移动', () => {
    const structure = sortStructure([
      createStructureNode({ id: 'c1', level: 'chapter', parentId: null, name: '章节 1', startMs: 0 }),
      createStructureNode({ id: 's1', level: 'section', parentId: 'c1', name: '段落', startMs: 0, source: 'manual' }),
      createStructureNode({ id: 's1-shot-a', level: 'shot', parentId: 's1', name: '锁定镜头', startMs: 0, source: 'auto', locked: true }),
      createStructureNode({ id: 's1-shot-b', level: 'shot', parentId: 's1', name: PLACEHOLDER_SHOT_NAME, startMs: 3000 }),
    ]);
    const result = planShotsInRange({
      structure,
      durationMs: DURATION,
      parentId: 's1',
      cutTimes: [1500, 5000], // 1500 落在锁定镜头内部 → 被忽略
      idSeed: 'test',
    });
    const locked = result.structure.find((n) => n.id === 's1-shot-a');
    expect(locked).toBeDefined();
    expect(locked?.locked).toBe(true);
    expect(shotRange(result.structure, 's1-shot-a')).toEqual({ startMs: 0, endMs: 3000 });
    expect(validateStructure(result.structure, DURATION)).toEqual([]);
  });

  it('用户自定义名称不因重新编号被覆盖', () => {
    const structure = sortStructure([
      createStructureNode({ id: 'c1', level: 'chapter', parentId: null, name: '章节 1', startMs: 0 }),
      createStructureNode({ id: 's1', level: 'section', parentId: 'c1', name: '段落', startMs: 0, source: 'manual' }),
      createStructureNode({ id: 's1-shot-a', level: 'shot', parentId: 's1', name: '自定义名', startMs: 0, source: 'auto' }),
      createStructureNode({ id: 's1-shot-b', level: 'shot', parentId: 's1', name: PLACEHOLDER_SHOT_NAME, startMs: 4000 }),
    ]);
    const result = planShotsInRange({
      structure,
      durationMs: DURATION,
      parentId: 's1',
      cutTimes: [],
      strategy: 'supplement',
      idSeed: 'test',
    });
    const shots = shotsOf(result.structure, 's1');
    expect(shots.find((s) => s.id === 's1-shot-a')?.name).toBe('自定义名');
  });

  it('“保留并补充”策略保留自动镜头边界，只插入新切点', () => {
    const structure = buildBasic();
    // 先手工构造两个自动镜头。
    const withAuto = sortStructure([
      ...structure.filter((n) => !(n.level === 'shot' && n.parentId === 's1')),
      createStructureNode({ id: 's1-shot-1', level: 'shot', parentId: 's1', name: '镜头 1', startMs: 0, source: 'auto' }),
      createStructureNode({ id: 's1-shot-2', level: 'shot', parentId: 's1', name: '镜头 2', startMs: 3000, source: 'auto' }),
    ]);
    const result = planShotsInRange({
      structure: withAuto,
      durationMs: DURATION,
      parentId: 's1',
      cutTimes: [6000],
      strategy: 'supplement',
      idSeed: 'test',
    });
    expect(shotsOf(result.structure, 's1').map((s) => s.startMs)).toEqual([0, 3000, 6000]);
  });
});

describe('planShotsInRange：选区与无效输入', () => {
  it('对完整段落运行：首尾与父级范围一致', () => {
    const result = planShotsInRange({
      structure: buildBasic(),
      durationMs: DURATION,
      parentId: 's1',
      cutTimes: [5000],
      idSeed: 'test',
    });
    const shots = shotsOf(result.structure, 's1');
    expect(shots[0]!.startMs).toBe(0);
    expect(shotRange(result.structure, shots[shots.length - 1]!.id).endMs).toBe(10_000);
  });

  it('非段落父级（章节）被拒绝', () => {
    const result = planShotsInRange({
      structure: buildBasic(),
      durationMs: DURATION,
      parentId: 'c1',
      cutTimes: [5000],
      idSeed: 'test',
    });
    expect(result.ok).toBe(false);
    expect(result.didChange).toBe(false);
  });

  it('无变化时 didChange=false（避免多余撤销记录）', () => {
    const base = buildBasic();
    const first = planShotsInRange({ structure: base, durationMs: DURATION, parentId: 's1', cutTimes: [3000], idSeed: 'a' });
    const second = planShotsInRange({
      structure: first.structure,
      durationMs: DURATION,
      parentId: 's1',
      cutTimes: [3000],
      idSeed: 'b',
    });
    expect(second.didChange).toBe(false);
  });
});
describe('resolveShotTarget / countEditableShots', () => {
  it('选中段落 → 目标为该段落完整范围', () => {
    const result = resolveShotTarget(buildBasic(), DURATION, { kind: 'node', id: 's1' });
    expect(result.ok).toBe(true);
    expect(result.target?.sections).toEqual([{ id: 's1', startMs: 0, endMs: 10_000 }]);
    expect(result.target?.label).toContain('第一次尝试');
  });

  it('选中章节 → 目标为其下全部段落', () => {
    const result = resolveShotTarget(buildBasic(), DURATION, { kind: 'node', id: 'c1' });
    expect(result.ok).toBe(true);
    expect(result.target?.sections.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(result.target?.rangeStartMs).toBe(0);
    expect(result.target?.rangeEndMs).toBe(DURATION);
  });

  it('选中镜头 → 拒绝并提示先选段落', () => {
    const result = resolveShotTarget(buildBasic(), DURATION, { kind: 'node', id: 's1-shot-1' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('段落');
  });

  it('无选区 → 给出禁用提示', () => {
    const result = resolveShotTarget(buildBasic(), DURATION, null);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('请先');
  });

  it('时间范围选区 → 与相交段落求交集', () => {
    const result = resolveShotTarget(buildBasic(), DURATION, { kind: 'range', startMs: 4000, endMs: 12_000 });
    expect(result.ok).toBe(true);
    expect(result.target?.sections).toEqual([
      { id: 's1', startMs: 4000, endMs: 10_000 },
      { id: 's2', startMs: 10_000, endMs: 12_000 },
    ]);
  });

  it('countEditableShots 忽略占位镜头，统计手动/自动镜头', () => {
    const withShots = sortStructure([
      createStructureNode({ id: 'c1', level: 'chapter', parentId: null, name: '章节', startMs: 0 }),
      createStructureNode({ id: 's1', level: 'section', parentId: 'c1', name: '段落', startMs: 0, source: 'manual' }),
      createStructureNode({ id: 'sh1', level: 'shot', parentId: 's1', name: '镜头 1', startMs: 0, source: 'auto' }),
      createStructureNode({ id: 'sh2', level: 'shot', parentId: 's1', name: PLACEHOLDER_SHOT_NAME, startMs: 5000 }),
    ]);
    const target = resolveShotTarget(withShots, DURATION, { kind: 'node', id: 's1' }).target!;
    expect(countEditableShots(withShots, target)).toBe(1);
  });
});
