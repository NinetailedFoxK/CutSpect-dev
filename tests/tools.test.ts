import { describe, expect, it } from 'vitest';
import { IMPLEMENTED_TOOLS, TOOLS, pickHit, toolForShortcut } from '../src/renderer/editor/tools';
import type { HitCandidate } from '../src/renderer/editor/tools';

/**
 * 工具状态机测试（规格 5.2 / 5.5 / 14）。
 */

describe('toolForShortcut（v1.1 需求 6.2：V/P/B/D/N/S）', () => {
  it('映射单字母快捷键（大小写不敏感）', () => {
    expect(toolForShortcut('v')).toBe('select');
    expect(toolForShortcut('V')).toBe('select');
    expect(toolForShortcut('P')).toBe('node');
    expect(toolForShortcut('b')).toBe('freehand');
    expect(toolForShortcut('D')).toBe('line');
    expect(toolForShortcut('n')).toBe('note');
    expect(toolForShortcut('s')).toBe('section');
  });

  it('旧键位已让位：L 归还播放控制、M 归还播放头标注', () => {
    expect(toolForShortcut('l')).toBeNull();
    expect(toolForShortcut('m')).toBeNull();
  });

  it('非单字母或未绑定键返回 null', () => {
    expect(toolForShortcut('')).toBeNull();
    expect(toolForShortcut('Enter')).toBeNull();
    expect(toolForShortcut('x')).toBeNull();
  });

  it('快捷键唯一且与工具一一对应', () => {
    const keys = TOOLS.map((t) => t.shortcut);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('已实现工具集合正确（阶段 C 含标注与分段）', () => {
    expect([...IMPLEMENTED_TOOLS].sort()).toEqual([
      'freehand',
      'line',
      'node',
      'note',
      'section',
      'select',
    ]);
  });
});

describe('pickHit（规格 5.5 命中优先级）', () => {
  const candidates: HitCandidate[] = [
    { kind: 'curve', id: 'c', distancePx: 1 },
    { kind: 'node', id: 'n', distancePx: 5 },
    { kind: 'handle', id: 'h', distancePx: 7 },
  ];

  it('高优先级类别胜出（控制柄 > 节点 > 曲线）', () => {
    expect(pickHit(candidates)?.kind).toBe('handle');
    // 移除控制柄后节点胜出。
    expect(pickHit(candidates.filter((c) => c.kind !== 'handle'))?.kind).toBe('node');
    // 仅剩曲线。
    expect(pickHit([{ kind: 'curve', id: 'c', distancePx: 3 }])?.id).toBe('c');
  });

  it('同类取距离最近者', () => {
    const picked = pickHit([
      { kind: 'node', id: 'far', distancePx: 7 },
      { kind: 'node', id: 'near', distancePx: 2 },
    ]);
    expect(picked?.id).toBe('near');
  });

  it('超出命中半径返回 null（空白）', () => {
    expect(pickHit([{ kind: 'node', id: 'n', distancePx: 20 }])).toBeNull();
    expect(pickHit([], 8)).toBeNull();
  });

  it('更高优先级但超半径时，让位给半径内的低优先级', () => {
    const picked = pickHit([
      { kind: 'handle', id: 'h', distancePx: 20 },
      { kind: 'node', id: 'n', distancePx: 4 },
    ]);
    expect(picked?.id).toBe('n');
  });
});