import { describe, expect, it } from 'vitest';
import {
  computePlotXGeometry,
  computePlotYGeometry,
  panRange,
  pageForwardRange,
  timeToX,
  valueToY,
  xToTime,
  yToValue,
  zoomAroundAnchor,
} from '../src/renderer/editor/editor-geometry';
import {
  buildTicks,
  chooseTickStepMs,
  sliderFromSpan,
  spanFromSlider,
} from '../src/renderer/editor/timeline-math';
import { createPlayheadStore } from '../src/renderer/editor/playhead-store';

/**
 * 工作台骨架纯函数测试（任务 A-T6）。
 *
 * 重点覆盖阶段 B 验收 B01/B02 的几何基础（规格 2.5 左右对齐铁律与
 * 3.1 唯一时间坐标）：VideoCanvas 与 Timeline 共用同一份 plotLeft/
 * plotWidth 时，同一时间必须映射到相同 X。
 */

describe('computePlotXGeometry（规格 2.5 左右对齐）', () => {
  it('同一容器宽度在两处计算得到完全相同的绘图区几何', () => {
    // 模拟 VideoCanvas 与 Timeline 各自以中央列宽度调用同一函数。
    const canvasGeo = computePlotXGeometry(1280);
    const timelineGeo = computePlotXGeometry(1280);
    expect(timelineGeo).toEqual(canvasGeo);
    expect(canvasGeo).toEqual({ plotLeft: 12, plotWidth: 1256 });
  });

  it('过小容器宽度防御：plotWidth 至少为 1', () => {
    expect(computePlotXGeometry(0).plotWidth).toBeGreaterThanOrEqual(1);
    expect(computePlotXGeometry(10).plotWidth).toBeGreaterThanOrEqual(1);
  });

  it('绘图区关于容器左右对称（两侧共同扣除相等 padding）', () => {
    const geo = computePlotXGeometry(800);
    expect(geo.plotLeft).toBe(800 - geo.plotLeft - geo.plotWidth);
  });
});

describe('timeToX / xToTime（规格 3.1 唯一时间坐标）', () => {
  const range = { viewStartMs: 20_000, viewEndMs: 40_000 };
  const geo = computePlotXGeometry(1000);

  it('区间端点映射到绘图区左右边缘', () => {
    expect(timeToX(20_000, range, geo)).toBeCloseTo(geo.plotLeft, 6);
    expect(timeToX(40_000, range, geo)).toBeCloseTo(geo.plotLeft + geo.plotWidth, 6);
  });

  it('中点映射到绘图区中心（B01：60 秒视频的 30 秒节点在横向中点）', () => {
    const full = { viewStartMs: 0, viewEndMs: 60_000 };
    const x = timeToX(30_000, full, geo);
    expect(x).toBeCloseTo(geo.plotLeft + geo.plotWidth / 2, 6);
  });

  it('x → time → x 往返误差 < 0.5 像素（整数毫秒取整）', () => {
    for (let i = 0; i <= 40; i++) {
      const t = 20_000 + i * 500;
      const x = timeToX(t, range, geo);
      const back = xToTime(x, range, geo);
      const x2 = timeToX(back, range, geo);
      expect(Math.abs(back - t)).toBeLessThanOrEqual(1); // 1ms 内取整误差
      expect(Math.abs(x2 - x)).toBeLessThan(0.5);
    }
  });

  it('同一时间在两份相同几何下映射结果一致（对齐铁律的直接验证）', () => {
    const geoA = computePlotXGeometry(960);
    const geoB = computePlotXGeometry(960);
    const r = { viewStartMs: 5_000, viewEndMs: 15_000 };
    expect(timeToX(7_500, r, geoA)).toBe(timeToX(7_500, r, geoB));
  });
});

describe('valueToY / yToValue（规格 3.1 纵轴 0—100）', () => {
  const plot = computePlotYGeometry(400);

  it('值域端点映射：100 → 顶部，0 → 底部', () => {
    expect(valueToY(100, plot)).toBeCloseTo(plot.plotTop, 6);
    expect(valueToY(0, plot)).toBeCloseTo(plot.plotTop + plot.plotHeight, 6);
  });

  it('越界值夹紧到 [0,100]', () => {
    expect(yToValue(valueToY(120, plot), plot)).toBe(100);
    expect(yToValue(valueToY(-10, plot), plot)).toBe(0);
  });

  it('往返一致', () => {
    for (let v = 0; v <= 100; v += 10) {
      expect(Math.round(yToValue(valueToY(v, plot), plot))).toBe(v);
    }
  });
});

describe('chooseTickStepMs（规格 2.5 刻度密度自适应）', () => {
  it('窄区间选整秒档', () => {
    // span 10s、宽 1256px：1s ≈ 125px ≥ 90px。
    expect(chooseTickStepMs(10_000, 1256)).toBe(1_000);
  });

  it('区间变宽升档到 5 秒 / 30 秒', () => {
    // span 60s：1s≈21px、5s≈105px ≥ 90。
    expect(chooseTickStepMs(60_000, 1256)).toBe(5_000);
    // span 600s：5s≈10px、30s≈63px <90、？30s*1256/600000=62.8px <90 → 60s=125px。
    expect(chooseTickStepMs(600_000, 1256)).toBe(60_000);
  });

  it('全片 3 分钟在 1256px 下选 30 秒档（5 秒间距仅 35px，过密升档）', () => {
    expect(chooseTickStepMs(180_000, 1256)).toBe(30_000);
  });

  it('超长片防御：覆盖全部候选仍不够密时返回最大档', () => {
    expect(chooseTickStepMs(2 * 3_600_000 * 1000, 800)).toBe(10_800_000);
  });

  it('非法输入防御', () => {
    expect(chooseTickStepMs(0, 1000)).toBe(1_000);
    expect(chooseTickStepMs(1000, 0)).toBe(1_000);
  });
});

describe('buildTicks', () => {
  it('主刻度对齐步长网格且首刻度不早于 viewStart', () => {
    const ticks = buildTicks(2_300, 9_700, 1_000);
    const majors = ticks.filter((t) => t.major);
    expect(majors.map((t) => t.timeMs)).toEqual([3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000]);
    expect(ticks[0]?.timeMs).toBeGreaterThanOrEqual(2_300);
  });

  it('includeMinor=false 时只含主刻度', () => {
    const ticks = buildTicks(0, 10_000, 1_000, { includeMinor: false });
    expect(ticks.every((t) => t.major)).toBe(true);
    expect(ticks).toHaveLength(11);
  });

  it('空区间与非法步长返回空数组', () => {
    expect(buildTicks(5_000, 5_000, 1_000)).toEqual([]);
    expect(buildTicks(0, 10_000, 0)).toEqual([]);
  });
});

describe('spanFromSlider / sliderFromSpan（规格 3.3 缩放映射）', () => {
  it('t=0 为全片，t=1 为最短可见区间 min(1000ms, durationMs)', () => {
    expect(spanFromSlider(0, 180_000)).toBe(180_000);
    expect(spanFromSlider(1, 180_000)).toBe(1000);
    expect(spanFromSlider(1, 600)).toBe(600); // 短视频：全长即最短区间。
  });

  it('往返一致（span → t → span）', () => {
    const duration = 180_000;
    for (const span of [180_000, 90_000, 30_000, 5_000, 1_000]) {
      const t = sliderFromSpan(span, duration);
      expect(spanFromSlider(t, duration)).toBe(span);
    }
  });

  it('span 越界时滑杆值 clamp 到 [0,1]', () => {
    expect(sliderFromSpan(999_999, 180_000)).toBe(0);
    expect(sliderFromSpan(1, 180_000)).toBe(1);
  });
});

describe('pageForwardRange（规格 3.3 越界整页后移）', () => {
  it('播放头越过右边界后置于新区间 90% 处（保留 10% 前文）', () => {
    const next = pageForwardRange(41_000, 20_000, 180_000);
    expect(next.viewStartMs).toBe(39_000);
    expect(next.viewEndMs).toBe(59_000);
  });

  it('结果不越出 [0, durationMs]', () => {
    const next = pageForwardRange(179_000, 20_000, 180_000);
    expect(next.viewEndMs).toBe(180_000);
    expect(next.viewStartMs).toBe(160_000);
  });

  it('span 大于 duration 时夹紧为全片', () => {
    const next = pageForwardRange(50, 500_000, 180_000);
    expect(next).toEqual({ viewStartMs: 0, viewEndMs: 180_000 });
  });
});

describe('zoomAroundAnchor（规格 3.3 缩放锚点）', () => {
  it('锚点在缩放前后相对位置保持不变', () => {
    const next = zoomAroundAnchor(30_000, 20_000, 0.5, 180_000);
    expect(next.viewStartMs).toBe(20_000);
    expect(next.viewEndMs).toBe(40_000);
  });

  it('结果 clamp 在 [0, durationMs] 且保持跨度', () => {
    const next = zoomAroundAnchor(5_000, 20_000, 0.5, 180_000);
    expect(next.viewStartMs).toBeGreaterThanOrEqual(0);
    expect(next.viewEndMs - next.viewStartMs).toBe(20_000);
  });

  it('锚点贴边时整体平移入界（B02 基础：20—40 秒缩放后节点仍在范围内）', () => {
    const next = zoomAroundAnchor(30_000, 20_000, 0.5, 180_000);
    expect(next.viewStartMs).toBeLessThanOrEqual(30_000);
    expect(next.viewEndMs).toBeGreaterThanOrEqual(30_000);
  });
});

describe('panRange（规格 3.3 平移）', () => {
  it('正向平移：区间整体右移指定毫秒', () => {
    const next = panRange({ viewStartMs: 20_000, viewEndMs: 40_000 }, 30_000, 180_000);
    expect(next).toEqual({ viewStartMs: 50_000, viewEndMs: 70_000 });
  });

  it('平移量越界时 clamp 在 [0, durationMs - span]', () => {
    const far = panRange({ viewStartMs: 20_000, viewEndMs: 40_000 }, 300_000, 180_000);
    expect(far).toEqual({ viewStartMs: 160_000, viewEndMs: 180_000 });
    const back = panRange({ viewStartMs: 20_000, viewEndMs: 40_000 }, -100_000, 180_000);
    expect(back).toEqual({ viewStartMs: 0, viewEndMs: 20_000 });
  });
});

describe('createPlayheadStore（规格 12.3 播放头分发）', () => {
  it('publish 推送到全部订阅者，退订后不再收到', () => {
    const store = createPlayheadStore(0);
    const receivedA: number[] = [];
    const receivedB: number[] = [];
    const offA = store.subscribe((ms) => receivedA.push(ms));
    store.subscribe((ms) => receivedB.push(ms));
    store.publish(1_000);
    offA();
    store.publish(2_000);
    expect(receivedA).toEqual([1_000]);
    expect(receivedB).toEqual([1_000, 2_000]);
  });

  it('相同值不重复推送；非法值防御性归零', () => {
    const store = createPlayheadStore(500);
    const received: number[] = [];
    store.subscribe((ms) => received.push(ms));
    store.publish(500);
    store.publish(Number.NaN);
    store.publish(-100);
    expect(store.get()).toBe(0);
    expect(received).toEqual([0]);
  });

  it('单个订阅者抛错不阻断其余订阅者', () => {
    const store = createPlayheadStore(0);
    const received: number[] = [];
    store.subscribe(() => {
      throw new Error('consumer failure');
    });
    store.subscribe((ms) => received.push(ms));
    store.publish(1_000);
    expect(received).toEqual([1_000]);
  });
});