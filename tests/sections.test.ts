import { describe, expect, it } from 'vitest';
import type { Boundary, Section } from '../src/shared/api-types';
import {
  addBoundary,
  mergeNotes,
  moveBoundary,
  nextSectionDefaultName,
  removeBoundary,
  resolveSectionForTime,
  sectionRanges,
  setBoundaryLocked,
  setSectionNote,
} from '../src/shared/sections';

/** 分段结构操作测试（规格 7）。 */

const DURATION = 60_000;

function buildDoc(internalTimes: number[] = []): { boundaries: Boundary[]; sections: Section[] } {
  const boundaries: Boundary[] = [
    { id: 'start', timeMs: 0, fixed: true, locked: true },
    ...internalTimes.map((t, i) => ({ id: `b${i + 1}`, timeMs: t, fixed: false, locked: false })),
    { id: 'end', timeMs: DURATION, fixed: true, locked: true },
  ].sort((a, b) => a.timeMs - b.timeMs);
  const starts = boundaries.slice(0, boundaries.length - 1);
  const sections: Section[] = starts.map((b, i) => ({
    id: `s${i + 1}`,
    startBoundaryId: b.id,
    name: `段落 ${i + 1}`,
    note: '',
  }));
  return { boundaries, sections };
}

describe('addBoundary（规格 7.2）', () => {
  it('在段内新增边界：左段保留名与备注，右段默认名与空备注', () => {
    const { boundaries, sections } = buildDoc();
    sections[0] = { ...sections[0]!, note: '开场说明' };
    const result = addBoundary(boundaries, sections, 20_000, 'bNew', 'sNew', DURATION);
    expect(result.ok).toBe(true);
    expect(result.boundaries).toHaveLength(3);
    expect(result.sections).toHaveLength(2);
    const left = result.sections.find((s) => s.startBoundaryId === 'start');
    const right = result.sections.find((s) => s.startBoundaryId === 'bNew');
    expect(left?.name).toBe('段落 1');
    expect(left?.note).toBe('开场说明');
    expect(right?.name).toBe('段落 2');
    expect(right?.note).toBe('');
  });

  it('间隔小于 100ms 被拒绝并给出可操作提示', () => {
    const { boundaries, sections } = buildDoc([1_000]);
    const result = addBoundary(boundaries, sections, 1_050, 'bNew', 'sNew', DURATION);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('0.1 秒');
  });

  it('端点或与既有边界重合被拒绝', () => {
    const { boundaries, sections } = buildDoc([1_000]);
    expect(addBoundary(boundaries, sections, 0, 'x', 'y', DURATION).ok).toBe(false);
    expect(addBoundary(boundaries, sections, DURATION, 'x', 'y', DURATION).ok).toBe(false);
    expect(addBoundary(boundaries, sections, 1_000, 'x', 'y', DURATION).ok).toBe(false);
  });
});

describe('nextSectionDefaultName（规格 7.1：不重编号）', () => {
  it('默认名取“最大序号与段数”的较大者 +1（第 K 段即段落 K，避免冲突）', () => {
    expect(
      nextSectionDefaultName([
        { id: 'a', startBoundaryId: 'a', name: '段落 1', note: '' },
        { id: 'b', startBoundaryId: 'b', name: '段落 2', note: '' },
        { id: 'c', startBoundaryId: 'c', name: '开场钩子', note: '' },
      ]),
    ).toBe('段落 4');
  });

  it('插入到段落 1 之前时，新段默认名不冲掉既有编号', () => {
    const { boundaries, sections } = buildDoc();
    // 在段落 1 之前没有空间（start 在 0），改为在既有“段落 1”后再插入。
    const first = addBoundary(boundaries, sections, 20_000, 'bNew', 'sNew', DURATION);
    expect(first.ok).toBe(true);
    const renamed = first.sections.map((s) =>
      s.startBoundaryId === 'bNew' ? { ...s, name: '高潮' } : s,
    );
    // 再插入一个：默认名应为“段落 3”（既有段落 1、2 → 最大 2）。
    const second = addBoundary(first.boundaries, renamed, 40_000, 'bNew2', 'sNew2', DURATION);
    expect(second.ok).toBe(true);
    expect(second.sections.find((s) => s.startBoundaryId === 'bNew2')?.name).toBe('段落 3');
  });
});

describe('moveBoundary（规格 7.2 夹紧）', () => {
  it('夹紧到相邻边界内侧，不倒序', () => {
    const { boundaries, sections } = buildDoc([20_000, 40_000]);
    const left = moveBoundary(boundaries, sections, 'b1', 100);
    expect(left.boundaries.find((b) => b.id === 'b1')?.timeMs).toBe(100);
    const right = moveBoundary(boundaries, sections, 'b1', 39_999);
    expect(right.boundaries.find((b) => b.id === 'b1')?.timeMs).toBe(39_900);
  });

  it('首尾边界不可拖动', () => {
    const { boundaries, sections } = buildDoc();
    expect(moveBoundary(boundaries, sections, 'start', 5_000).ok).toBe(false);
    expect(moveBoundary(boundaries, sections, 'end', 5_000).ok).toBe(false);
  });
});

describe('removeBoundary（规格 7.2 合并）', () => {
  it('合并相邻段落：保留左段名，右段备注以分隔符保留', () => {
    const { boundaries, sections } = buildDoc([20_000]);
    const withNotes = sections.map((s) =>
      s.startBoundaryId === 'start'
        ? { ...s, note: '左段备注' }
        : { ...s, note: '右段备注' },
    );
    const result = removeBoundary(boundaries, withNotes, 'b1');
    expect(result.ok).toBe(true);
    expect(result.boundaries).toHaveLength(2);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.name).toBe('段落 1');
    expect(result.sections[0]?.note).toContain('左段备注');
    expect(result.sections[0]?.note).toContain('右段备注');
  });

  it('锁定边界拒绝删除；首尾拒绝删除', () => {
    const { boundaries, sections } = buildDoc([20_000]);
    const locked = boundaries.map((b) => (b.id === 'b1' ? { ...b, locked: true } : b));
    expect(removeBoundary(locked, sections, 'b1').ok).toBe(false);
    expect(removeBoundary(boundaries, sections, 'start').ok).toBe(false);
  });
});

describe('resolveSectionForTime（规格 13.2 归属）', () => {
  it('内部边界处归属右侧段落；durationMs 归属最后一段', () => {
    const { boundaries, sections } = buildDoc([20_000, 40_000]);
    expect(resolveSectionForTime(boundaries, sections, 10_000)?.startBoundaryId).toBe('start');
    expect(resolveSectionForTime(boundaries, sections, 20_000)?.startBoundaryId).toBe('b1');
    expect(resolveSectionForTime(boundaries, sections, 40_000)?.startBoundaryId).toBe('b2');
    expect(resolveSectionForTime(boundaries, sections, DURATION)?.startBoundaryId).toBe('b2');
  });
});

describe('sectionRanges / setBoundaryLocked / mergeNotes', () => {
  it('段落起止连续覆盖完整视频', () => {
    const { boundaries, sections } = buildDoc([20_000, 40_000]);
    const ranges = sectionRanges(boundaries, sections);
    expect(ranges.map((r) => [r.startMs, r.endMs])).toEqual([
      [0, 20_000],
      [20_000, 40_000],
      [40_000, DURATION],
    ]);
  });

  it('内部边界可锁定/解锁，首尾拒绝', () => {
    const { boundaries, sections } = buildDoc([20_000]);
    expect(setBoundaryLocked(boundaries, sections, 'b1', true).ok).toBe(true);
    expect(setBoundaryLocked(boundaries, sections, 'start', false).ok).toBe(false);
  });

  it('mergeNotes 空值不引入分隔符', () => {
    expect(mergeNotes('', '右侧')).toBe('右侧');
    expect(mergeNotes('左侧', '')).toBe('左侧');
    expect(mergeNotes('左', '右')).toBe('左\n\n———\n\n右');
  });

  it('setSectionNote 修改指定段落备注', () => {
    const { sections } = buildDoc([20_000]);
    const next = setSectionNote(sections, 's1', '备注');
    expect(next.find((s) => s.id === 's1')?.note).toBe('备注');
    expect(next.find((s) => s.id === 's2')?.note).toBe('');
  });
});