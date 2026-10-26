import { describe, expect, it } from 'vitest';
import { visibleSpanOf } from '../src/renderer/editor/timeline-visible-range';

/**
 * 跨视口可见交集（第 5 节 / 8.1）：章节、段落、镜头叠加层共用同一套交集函数。
 */

describe('visibleSpanOf（跨视口可见交集）', () => {
  it('块完全覆盖视口：交集即视口，左右均标记延续', () => {
    const span = visibleSpanOf({ startMs: 29_000, endMs: 872_000 }, 300_000, 540_000);
    expect(span).toEqual({
      startMs: 300_000,
      endMs: 540_000,
      clippedStart: true,
      clippedEnd: true,
      empty: false,
    });
  });

  it('真实起点在视口内、终点在右：只标记右延续', () => {
    const span = visibleSpanOf({ startMs: 320_000, endMs: 872_000 }, 300_000, 540_000);
    expect(span.startMs).toBe(320_000);
    expect(span.endMs).toBe(540_000);
    expect(span.clippedStart).toBe(false);
    expect(span.clippedEnd).toBe(true);
  });

  it('完全在视口左侧 / 右侧均为 empty', () => {
    expect(visibleSpanOf({ startMs: 0, endMs: 100_000 }, 300_000, 540_000).empty).toBe(true);
    expect(visibleSpanOf({ startMs: 700_000, endMs: 800_000 }, 300_000, 540_000).empty).toBe(true);
  });

  it('恰好等于视口：无延续、非空', () => {
    const span = visibleSpanOf({ startMs: 300_000, endMs: 540_000 }, 300_000, 540_000);
    expect(span.empty).toBe(false);
    expect(span.clippedStart).toBe(false);
    expect(span.clippedEnd).toBe(false);
  });
});