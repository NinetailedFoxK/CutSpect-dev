import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMELINE_HEIGHT,
  MIN_ANALYSIS_HEIGHT,
  MIN_TIMELINE_HEIGHT,
  clampTimelineHeight,
  defaultTimelineHeight,
  heightFromDrag,
  nudgeTimelineHeight,
  resolveTimelineLimits,
  splitterCommitHeight,
  splitterIdle,
  splitterReducer,
  resolvePanelLimits,
  widthFromDrag,
  defaultPanelWidth,
} from '../src/renderer/editor/layout';

/** 分割线高度限制与拖动状态机（需求 1.3 / 1.4 / 1.5 / 4.1）。 */

describe('resolveTimelineLimits', () => {
  it('窗口缩小后上限随工作区收窄（分析区保留最小高度）', () => {
    const big = resolveTimelineLimits(1200);
    const small = resolveTimelineLimits(700);
    expect(small.max).toBeLessThan(big.max);
    // 上限保证分析监视器 ≥ 240（扣除分割线自身）。
    expect(small.max).toBeLessThanOrEqual(700 - 10 - MIN_ANALYSIS_HEIGHT);
  });

  it('上限不超过工作区的 62%', () => {
    const limits = resolveTimelineLimits(2000);
    expect(limits.max).toBeLessThanOrEqual(Math.floor(2000 * 0.62));
  });

  it('下限固定为时间线最小高度', () => {
    expect(resolveTimelineLimits(1200).min).toBe(MIN_TIMELINE_HEIGHT);
  });

  it('窗口极矮时保证 min ≤ max（不产生非法区间）', () => {
    const limits = resolveTimelineLimits(260);
    expect(limits.min).toBeLessThanOrEqual(limits.max);
  });

  it('首帧未测量（totalHeight≤0）回退到宽松区间', () => {
    const limits = resolveTimelineLimits(0);
    expect(limits.min).toBe(MIN_TIMELINE_HEIGHT);
    expect(limits.max).toBeGreaterThan(MIN_TIMELINE_HEIGHT);
  });
});

describe('clampTimelineHeight', () => {
  it('夹紧到 [min,max]', () => {
    const limits = { min: 160, max: 500 };
    expect(clampTimelineHeight(50, limits)).toBe(160);
    expect(clampTimelineHeight(900, limits)).toBe(500);
    expect(clampTimelineHeight(300, limits)).toBe(300);
  });

  it('非有限数回退到下限', () => {
    expect(clampTimelineHeight(Number.NaN, { min: 160, max: 500 })).toBe(160);
  });
});

describe('heightFromDrag', () => {
  const limits = { min: 160, max: 600 };

  it('向上拖动（deltaY<0）扩大时间线', () => {
    expect(heightFromDrag(300, -120, limits)).toBe(420);
  });

  it('向下拖动（deltaY>0）缩小时间线', () => {
    expect(heightFromDrag(300, 80, limits)).toBe(220);
  });

  it('拖动不会超过上下限', () => {
    expect(heightFromDrag(300, -9999, limits)).toBe(600);
    expect(heightFromDrag(300, 9999, limits)).toBe(160);
  });
});

describe('nudgeTimelineHeight 与 defaultTimelineHeight', () => {
  const limits = { min: 160, max: 600 };

  it('方向键 up 扩大、down 缩小，Shift 使用更大步长', () => {
    expect(nudgeTimelineHeight(300, 'up', 10, limits)).toBe(310);
    expect(nudgeTimelineHeight(300, 'down', 10, limits)).toBe(290);
    expect(nudgeTimelineHeight(300, 'up', 40, limits)).toBe(340);
  });

  it('双击恢复默认值并夹紧', () => {
    expect(defaultTimelineHeight(limits)).toBe(DEFAULT_TIMELINE_HEIGHT);
    const tiny = { min: 200, max: 300 };
    expect(defaultTimelineHeight(tiny)).toBe(300);
  });
});

describe('splitterReducer（拖动状态机）', () => {
  const limits = { min: 160, max: 600 };

  const begin = () =>
    splitterReducer(splitterIdle(300), { type: 'begin', pointerId: 7, y: 100 });

  it('drag 开始 → move 产生预览 → end 结束并保留最终高度', () => {
    let state = begin();
    expect(state.dragging).toBe(true);
    state = splitterReducer(state, { type: 'move', y: 40, limits });
    expect(state.preview).toBe(360);
    expect(splitterCommitHeight(state)).toBe(360);
    state = splitterReducer(state, { type: 'end' });
    expect(state.dragging).toBe(false);
    expect(state.preview).toBeNull();
  });

  it('取消（Escape / 失焦 / pointercancel）丢弃预览并结束拖动', () => {
    const state = splitterReducer(begin(), { type: 'move', y: 40, limits });
    const cancelled = splitterReducer(state, { type: 'cancel' });
    expect(cancelled.dragging).toBe(false);
    expect(cancelled.preview).toBeNull();
    // 未提交时读取到的是起始高度（不提交半途值）。
    expect(splitterCommitHeight(cancelled)).toBe(300);
  });

  it('未在拖动时 move / end 不产生副作用', () => {
    const idle = splitterIdle(300);
    expect(splitterReducer(idle, { type: 'move', y: 0, limits })).toBe(idle);
    expect(splitterReducer(idle, { type: 'end' })).toBe(idle);
  });

  it('sync 在非拖动时更新起始高度', () => {
    const synced = splitterReducer(splitterIdle(300), { type: 'sync', height: 420 });
    expect(synced.startHeight).toBe(420);
    const dragging = splitterReducer(begin(), { type: 'sync', height: 999 });
    expect(dragging.startHeight).toBe(300);
  });
});
describe('检查器宽度限制（方案 §4：默认 320 / 280–440）', () => {
  it('默认宽度 320，且夹紧在容器允许范围', () => {
    const limits = resolvePanelLimits(1600);
    expect(limits.min).toBe(280);
    expect(limits.max).toBe(440);
    expect(defaultPanelWidth(limits)).toBe(320);
  });

  it('容器过窄时上限随容器收窄，但不低于最小宽度', () => {
    const limits = resolvePanelLimits(500);
    expect(limits.max).toBeLessThanOrEqual(440);
    expect(limits.max).toBeGreaterThanOrEqual(280);
    expect(limits.min).toBeLessThanOrEqual(limits.max);
  });

  it('未测量容器回退到绝对区间', () => {
    const limits = resolvePanelLimits(0);
    expect(limits).toEqual({ min: 280, max: 440 });
  });

  it('向左拖动（deltaX<0）使面板变宽，向右拖动变窄，并夹紧', () => {
    const limits = { min: 280, max: 440 };
    expect(widthFromDrag(320, -100, limits)).toBe(420);
    expect(widthFromDrag(320, 60, limits)).toBe(280);
    expect(widthFromDrag(320, -9999, limits)).toBe(440);
  });
});
