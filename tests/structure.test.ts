import { describe, expect, it } from 'vitest';
import type { StructureNode } from '../src/shared/api-types';
import {
  buildNumbering,
  childrenOf,
  createStructureNode,
  deriveRanges,
  descendantsOf,
  formatNumber,
  mergeNode,
  nearestChildBoundary,
  reparentNode,
  resolveNodeAt,
  splitNode,
  updateStructureNode,
  validateStructure,
} from '../src/shared/structure';

/**
 * 三级结构数据模型与编辑纯函数测试（规格 3.2 / 4 / 5）。
 */

const DURATION = 10_000;

/** 标准样例：1 章节 / 2 段落 / 3 镜头，覆盖全片且无空洞。 */
function sample(): StructureNode[] {
  return [
    createStructureNode({ id: 'A', level: 'chapter', parentId: null, name: '开头', startMs: 0 }),
    createStructureNode({ id: 'A1', level: 'section', parentId: 'A', name: '人物出场', startMs: 0 }),
    createStructureNode({ id: 'A2', level: 'section', parentId: 'A', name: '抛出问题', startMs: 5000 }),
    createStructureNode({ id: 'A1a', level: 'shot', parentId: 'A1', name: '镜头 01', startMs: 0 }),
    createStructureNode({ id: 'A1b', level: 'shot', parentId: 'A1', name: '镜头 02', startMs: 2000 }),
    createStructureNode({ id: 'A2a', level: 'shot', parentId: 'A2', name: '镜头 03', startMs: 5000 }),
  ];
}

describe('deriveRanges（共享边界 / 末位取父级 end）', () => {
  it('章节末位结束于视频时长，子级末位结束于父级 end', () => {
    const ranges = deriveRanges(sample(), DURATION);
    expect(ranges.get('A')).toEqual({ startMs: 0, endMs: DURATION });
    expect(ranges.get('A1')).toEqual({ startMs: 0, endMs: 5000 });
    expect(ranges.get('A2')).toEqual({ startMs: 5000, endMs: DURATION });
    expect(ranges.get('A1a')).toEqual({ startMs: 0, endMs: 2000 });
    expect(ranges.get('A1b')).toEqual({ startMs: 2000, endMs: 5000 });
    expect(ranges.get('A2a')).toEqual({ startMs: 5000, endMs: DURATION });
  });

  it('多章节时前一章节结束于下一章节起点', () => {
    const structure = [
      ...sample(),
      createStructureNode({ id: 'B', level: 'chapter', parentId: null, name: '结尾', startMs: 6000 }),
    ];
    // B 覆盖 [6000, DURATION]，A 变为 [0, 6000]，A2 变为 [5000, 6000]。
    const ranges = deriveRanges(structure, DURATION);
    expect(ranges.get('A')?.endMs).toBe(6000);
    expect(ranges.get('A2')).toEqual({ startMs: 5000, endMs: 6000 });
  });
});

describe('validateStructure（不变量）', () => {
  it('合法结构通过', () => {
    expect(validateStructure(sample(), DURATION)).toEqual([]);
  });

  it('第一个章节必须从 0 开始', () => {
    const structure = sample().map((n) => (n.id === 'A' ? { ...n, startMs: 100 } : n));
    expect(validateStructure(structure, DURATION).some((i) => i.includes('从 0 开始'))).toBe(true);
  });

  it('子级未与父级起点对齐时报错', () => {
    // 段落与镜头整体后移 1000ms：段落起点 1000 ≠ 章节起点 0。
    const structure = sample().map((n) =>
      n.id === 'A1' || n.id === 'A1a' ? { ...n, startMs: 1000 } : n,
    );
    const issues = validateStructure(structure, DURATION);
    expect(issues.some((i) => i.includes('起点对齐'))).toBe(true);
  });

  it('引用不存在的父级时报错', () => {
    const structure = sample().map((n) => (n.id === 'A1' ? { ...n, parentId: 'ghost' } : n));
    expect(validateStructure(structure, DURATION).some((i) => i.includes('父级'))).toBe(true);
  });

  it('层级父级类型不匹配时报错', () => {
    // 把段落挂到镜头下。
    const structure = sample().map((n) => (n.id === 'A1' ? { ...n, parentId: 'A1a' } : n));
    expect(validateStructure(structure, DURATION).some((i) => i.includes('层级'))).toBe(true);
  });
});

describe('编号与查询', () => {
  it('编号为 1 / 1.1 / 1.1.1', () => {
    const numbering = buildNumbering(sample());
    expect(formatNumber(numbering.get('A')!)).toBe('1');
    expect(formatNumber(numbering.get('A1')!)).toBe('1.1');
    expect(formatNumber(numbering.get('A2')!)).toBe('1.2');
    expect(formatNumber(numbering.get('A1a')!)).toBe('1.1.1');
    expect(formatNumber(numbering.get('A1b')!)).toBe('1.1.2');
    expect(formatNumber(numbering.get('A2a')!)).toBe('1.2.1');
  });

  it('childrenOf / descendantsOf', () => {
    const structure = sample();
    expect(childrenOf(structure, 'A', 'section').map((n) => n.id)).toEqual(['A1', 'A2']);
    expect(descendantsOf(structure, 'A').map((n) => n.id)).toEqual(['A1', 'A1a', 'A1b', 'A2', 'A2a']);
  });

  it('时间归属：边界归右侧、终点归最后一段', () => {
    const structure = sample();
    expect(resolveNodeAt(structure, 'section', 0, DURATION)?.id).toBe('A1');
    expect(resolveNodeAt(structure, 'section', 5000, DURATION)?.id).toBe('A2');
    expect(resolveNodeAt(structure, 'section', 4999, DURATION)?.id).toBe('A1');
    expect(resolveNodeAt(structure, 'section', DURATION, DURATION)?.id).toBe('A2');
    expect(resolveNodeAt(structure, 'shot', 2000, DURATION)?.id).toBe('A1b');
    expect(resolveNodeAt(structure, 'chapter', 9999, DURATION)?.id).toBe('A');
  });

  it('nearestChildBoundary 吸附到最近子级边界', () => {
    const structure = sample();
    expect(nearestChildBoundary(structure, 'A', 4600, DURATION)).toBe(5000);
    expect(nearestChildBoundary(structure, 'A', 900, DURATION)).toBe(0);
    // 镜头层无子级：候选为自身 start 与末位；1000 到 0 与 2000 等距，取先遇到的自身起点。
    expect(nearestChildBoundary(structure, 'A1a', 1000, DURATION)).toBe(0);
    expect(nearestChildBoundary(structure, 'A1a', 1800, DURATION)).toBe(2000);
  });
});

describe('splitNode（拆分当前层级）', () => {
  it('拆分章节需与段落边界对齐，子级重新归属', () => {
    const result = splitNode(sample(), 'A', 5000, 'B', DURATION);
    expect(result.ok).toBe(true);
    const structure = result.structure;
    expect(validateStructure(structure, DURATION)).toEqual([]);
    const ranges = deriveRanges(structure, DURATION);
    expect(ranges.get('A')).toEqual({ startMs: 0, endMs: 5000 });
    expect(ranges.get('B')).toEqual({ startMs: 5000, endMs: DURATION });
    expect(structure.find((n) => n.id === 'A2')?.parentId).toBe('B');
  });

  it('拆分章节边界未与段落对齐时拒绝', () => {
    const result = splitNode(sample(), 'A', 3000, 'B', DURATION);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('对齐');
  });

  it('拆分段落需与镜头边界对齐，镜头重新归属', () => {
    const result = splitNode(sample(), 'A1', 2000, 'A1x', DURATION);
    expect(result.ok).toBe(true);
    expect(validateStructure(result.structure, DURATION)).toEqual([]);
    const ranges = deriveRanges(result.structure, DURATION);
    expect(ranges.get('A1')).toEqual({ startMs: 0, endMs: 2000 });
    expect(ranges.get('A1x')).toEqual({ startMs: 2000, endMs: 5000 });
    expect(result.structure.find((n) => n.id === 'A1b')?.parentId).toBe('A1x');
  });

  it('拆分镜头可在任意位置', () => {
    const result = splitNode(sample(), 'A1a', 1000, 'A1a2', DURATION);
    expect(result.ok).toBe(true);
    const ranges = deriveRanges(result.structure, DURATION);
    expect(ranges.get('A1a')).toEqual({ startMs: 0, endMs: 1000 });
    expect(ranges.get('A1a2')).toEqual({ startMs: 1000, endMs: 2000 });
  });

  it('锁定结构不可拆分', () => {
    const structure = sample().map((n) => (n.id === 'A1a' ? { ...n, locked: true } : n));
    const result = splitNode(structure, 'A1a', 1000, 'x', DURATION);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('锁定');
  });
});

describe('mergeNode（合并 = 删除起始边界）', () => {
  it('合并镜头：备注并入左邻', () => {
    const structure = sample().map((n) =>
      n.id === 'A1b' ? { ...n, note: '第二个镜头备注' } : n,
    );
    const result = mergeNode(structure, 'A1b', DURATION);
    expect(result.ok).toBe(true);
    expect(result.structure.some((n) => n.id === 'A1b')).toBe(false);
    expect(result.structure.find((n) => n.id === 'A1a')?.note).toContain('第二个镜头备注');
    expect(validateStructure(result.structure, DURATION)).toEqual([]);
  });

  it('合并段落：镜头并入左邻段落', () => {
    const result = mergeNode(sample(), 'A2', DURATION);
    expect(result.ok).toBe(true);
    const structure = result.structure;
    expect(validateStructure(structure, DURATION)).toEqual([]);
    expect(structure.find((n) => n.id === 'A2a')?.parentId).toBe('A1');
    const ranges = deriveRanges(structure, DURATION);
    expect(ranges.get('A1')).toEqual({ startMs: 0, endMs: DURATION });
  });

  it('第一个结构不能向前合并', () => {
    const result = mergeNode(sample(), 'A1a', DURATION);
    expect(result.ok).toBe(false);
  });

  it('锁定结构不可合并', () => {
    const structure = sample().map((n) => (n.id === 'A1b' ? { ...n, locked: true } : n));
    expect(mergeNode(structure, 'A1b', DURATION).ok).toBe(false);
  });
});

describe('updateStructureNode（属性修改）', () => {
  it('改名、备注、叙事作用与标签', () => {
    const result = updateStructureNode(sample(), 'A1a', {
      name: '特写',
      note: '面部特写',
      narrativeRole: '钩子',
      tags: ['特写', '人物'],
    });
    expect(result.ok).toBe(true);
    const node = result.structure.find((n) => n.id === 'A1a')!;
    expect(node.name).toBe('特写');
    expect(node.note).toBe('面部特写');
    expect(node.narrativeRole).toBe('钩子');
    expect(node.tags).toEqual(['特写', '人物']);
  });

  it('名称超长拒绝', () => {
    expect(updateStructureNode(sample(), 'A1a', { name: 'x'.repeat(300) }).ok).toBe(false);
  });

  it('标签数量超限拒绝', () => {
    expect(
      updateStructureNode(sample(), 'A1a', { tags: Array.from({ length: 25 }, (_, i) => `t${i}`) })
        .ok,
    ).toBe(false);
  });

  it('锁定状态与代表帧可更新', () => {
    const result = updateStructureNode(sample(), 'A1a', { locked: true, coverTimeMs: 1234 });
    expect(result.ok).toBe(true);
    const node = result.structure.find((n) => n.id === 'A1a')!;
    expect(node.locked).toBe(true);
    expect(node.coverTimeMs).toBe(1234);
  });
});

describe('reparentNode（移动父级，受限版）', () => {
  it('同父级移动为无操作并返回成功', () => {
    const result = reparentNode(sample(), 'A2', 'A', DURATION);
    expect(result.ok).toBe(true);
  });

  it('跨父级移动：时间范围不匹配时明确拒绝，绝不生成非法结构', () => {
    // 受限实现：目标父级需存在完全对齐的占位子级；同级结构时间互不重叠，
    // 因此跨段落移动镜头会被明确拒绝，而不是静默产生重叠/空洞。
    const result = reparentNode(sample(), 'A1b', 'A2', DURATION);
    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
    // 失败时原结构保持不变。
    expect(result.structure).toHaveLength(sample().length);
  });

  it('镜头不可移动到章节下（层级不匹配）', () => {
    const result = reparentNode(sample(), 'A1a', 'A', DURATION);
    expect(result.ok).toBe(false);
  });
});