import { describe, expect, it } from 'vitest';
import type { Boundary, Section } from '../src/shared/api-types';
import {
  applyShotCuts,
  countConflictingCuts,
  filterCandidateTimes,
} from '../src/renderer/editor/shot-apply';

/** 候选切点 → 正式分段 的纯函数测试（不覆盖手动分段、100ms 去重、镜头命名、可整批撤销）。 */

const DURATION = 10_000;

function baseBoundaries(): Boundary[] {
  return [
    { id: 'b-start', timeMs: 0, fixed: true, locked: true },
    { id: 'b-end', timeMs: DURATION, fixed: true, locked: true },
  ];
}

function baseSections(): Section[] {
  return [{ id: 's-start', startBoundaryId: 'b-start', name: '段落 1', note: '' }];
}

describe('filterCandidateTimes', () => {
  it('排序、去重、滤除与现有边界相距 < 100ms 的候选', () => {
    const boundaries: Boundary[] = [
      { id: 'b0', timeMs: 0, fixed: true, locked: true },
      { id: 'm1', timeMs: 5000, fixed: false, locked: true },
      { id: 'b1', timeMs: DURATION, fixed: true, locked: true },
    ];
    const times = filterCandidateTimes(boundaries, [7000, 3000, 5050, 3000, 4800]);
    // 5050 距手动边界 5000 为 50ms → 剔除；3000 去重；4800 距 5000 为 200ms → 保留。
    expect(times).toEqual([3000, 4800, 7000]);
  });

  it('countConflictingCuts 统计重复数', () => {
    const boundaries: Boundary[] = [{ id: 'm', timeMs: 5000, fixed: false, locked: true }];
    expect(countConflictingCuts(boundaries, [{ timeMs: 5050, score: 1 }, { timeMs: 3000, score: 2 }])).toBe(1);
  });
});

describe('applyShotCuts', () => {
  it('生成边界与「镜头 NNN」段落，保留已有段落名称与结构', () => {
    const result = applyShotCuts(baseBoundaries(), baseSections(), [3000, 7000, 5000], DURATION, 'a');
    expect(result.appliedCount).toBe(3);
    // 端点 + 3 个新边界。
    expect(result.boundaries.map((b) => b.timeMs)).toEqual([0, 3000, 5000, 7000, DURATION]);
    // 原“段落 1”保留，新增 3 段命名为镜头 001/002/003（按时间）。
    const names = result.sections.map((s) => s.name);
    expect(names).toContain('段落 1');
    const shotNames = result.sections
      .filter((s) => s.name.startsWith('镜头 '))
      .map((s) => s.name);
    expect(shotNames).toEqual(['镜头 001', '镜头 002', '镜头 003']);
    // 段落与非终点边界一一对应。
    expect(result.sections).toHaveLength(result.boundaries.length - 1);
  });

  it('与已有手动/锁定边界重复的候选被跳过（不覆盖手动分段）', () => {
    const boundaries = baseBoundaries();
    boundaries.splice(1, 0, { id: 'manual', timeMs: 6000, fixed: false, locked: true });
    const sections = baseSections();
    sections.push({ id: 's-manual', startBoundaryId: 'manual', name: '手动段', note: '备注' });

    const result = applyShotCuts(boundaries, sections, [6050, 3000], DURATION, 'b');
    // 6050 距手动 6000 仅 50ms → 跳过；仅 3000 生效。
    expect(result.appliedCount).toBe(1);
    expect(result.boundaries.map((b) => b.timeMs)).toEqual([0, 3000, 6000, DURATION]);
    // 手动段落名称与备注未变。
    const manual = result.sections.find((s) => s.startBoundaryId === 'manual');
    expect(manual?.name).toBe('手动段');
    expect(manual?.note).toBe('备注');
  });

  it('端点/超范围候选被 addBoundary 拒绝（不新增）', () => {
    const result = applyShotCuts(baseBoundaries(), baseSections(), [0, DURATION], DURATION, 'c');
    expect(result.appliedCount).toBe(0);
    expect(result.boundaries).toHaveLength(2);
    expect(result.sections).toHaveLength(1);
  });

  it('不修改传入的原数组（便于一次 commit / 整批撤销）', () => {
    const boundaries = baseBoundaries();
    const sections = baseSections();
    const snapshotB = JSON.stringify(boundaries);
    const snapshotS = JSON.stringify(sections);
    applyShotCuts(boundaries, sections, [4000], DURATION, 'd');
    expect(JSON.stringify(boundaries)).toBe(snapshotB);
    expect(JSON.stringify(sections)).toBe(snapshotS);
  });
});