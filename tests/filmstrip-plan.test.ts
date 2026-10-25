import { describe, expect, it } from 'vitest';
import {
  FILMSTRIP_MAX_FRAMES,
  FRAME_REQUEST_MAX_WIDTH,
  FRAME_REQUEST_MIN_WIDTH,
  frameRequestSize,
  planTimelineFrames,
} from '../src/renderer/editor/filmstrip-plan';
import {
  FRAME_QUEUE_CONCURRENCY,
  MAX_BATCH_FRAMES,
  frameBatchArgs,
  frameBatchKey,
  frameTimeMsAt,
} from '../src/main/services/frame-queue';

/**
 * 时间线画面帧带（可视窗口统一生成）与抽帧队列（批处理）的纯函数测试。
 *
 * 本轮重构：帧带不再按镜头生成（无 NODE_MAX_FRAMES 概念）；帧槽按"可视范围 × 缩放"
 * 等宽铺满，请求走应用级队列（全局并发 2、批处理、去重）。
 */

describe('planTimelineFrames（整条可视范围，等宽铺满）', () => {
  it('帧数 = ceil(绘图宽 / 目标帧宽)，另有两侧预加载', () => {
    const plan = planTimelineFrames(0, 10_000, 960);
    // ceil(960/96)=10 + 每侧 1 = 12
    expect(plan.frames).toHaveLength(12);
    expect(plan.slotWidthPx).toBeCloseTo(96, 5);
  });

  it('全部帧槽等宽（长镜头不再靠单图拉伸）', () => {
    const plan = planTimelineFrames(0, 60_000, 700);
    const widths = plan.frames.map((f) => f.widthPx);
    expect(new Set(widths.map((w) => Math.round(w))).size).toBe(1);
  });

  it('可视范围内的帧槽首尾相接（连续、无缝）', () => {
    const plan = planTimelineFrames(0, 10_000, 960);
    const visible = plan.frames.filter((f) => f.startTimeMs >= 0 && f.endTimeMs <= 10_000);
    for (let i = 1; i < visible.length; i++) {
      expect(visible[i]?.startTimeMs ?? 0).toBeCloseTo(visible[i - 1]?.endTimeMs ?? 0, 5);
    }
  });

  it('帧数受上限约束（DOM/请求受控）', () => {
    const plan = planTimelineFrames(0, 60_000, 20_000);
    expect(plan.frames.length).toBeLessThanOrEqual(FILMSTRIP_MAX_FRAMES + 2);
  });

  it('放大（可视区间变小）→ 帧槽时间点更密（改变密度而非拉伸单图）', () => {
    const wide = planTimelineFrames(0, 60_000, 960);
    const zoomed = planTimelineFrames(20_000, 30_000, 960);
    const gap = (p: ReturnType<typeof planTimelineFrames>): number =>
      Math.abs((p.frames[1]?.timeMs ?? 0) - (p.frames[0]?.timeMs ?? 0));
    expect(gap(zoomed)).toBeLessThan(gap(wide));
  });

  it('空范围或零宽度返回空', () => {
    expect(planTimelineFrames(0, 0, 960).frames).toHaveLength(0);
    expect(planTimelineFrames(0, 10_000, 0).frames).toHaveLength(0);
  });
});

describe('frameRequestSize（按槽位像素宽决定请求清晰度）', () => {
  it('槽位像素宽越大请求越大（放大更清晰）', () => {
    const small = frameRequestSize(60, 16 / 9, 1);
    const large = frameRequestSize(600, 16 / 9, 1);
    expect(large.width).toBeGreaterThan(small.width);
  });

  it('请求宽度被夹在 [下限, 上限]', () => {
    expect(frameRequestSize(10, 16 / 9, 1).width).toBe(FRAME_REQUEST_MIN_WIDTH);
    expect(frameRequestSize(5000, 16 / 9, 1).width).toBe(FRAME_REQUEST_MAX_WIDTH);
  });
});

describe('抽帧队列纯函数（批处理 / 去重 / 并发约束）', () => {
  it('全局并发上限为 2（验收：ffmpeg 进程始终 ≤ 2）', () => {
    expect(FRAME_QUEUE_CONCURRENCY).toBe(2);
  });

  it('缓存键含 视频 + 范围 + 帧数 + 尺寸（去重且不错误复用）', () => {
    const base = { sha256: 'a', startMs: 0, endMs: 10_000, count: 12, width: 320, height: 180 };
    const key = frameBatchKey(base);
    expect(key).toHaveLength(16);
    expect(frameBatchKey({ ...base, count: 13 })).not.toBe(key);
    expect(frameBatchKey({ ...base, width: 640 })).not.toBe(key);
    expect(frameBatchKey({ ...base, startMs: 1 })).not.toBe(key);
  });

  it('批处理参数含 fps 滤镜与帧数上限（一次进程抽一批）', () => {
    const args = frameBatchArgs('/v.mp4', 0, 12_000, 12, 320, 180, '/out/f-%04d.jpg');
    const vfIndex = args.indexOf('-vf');
    const vf = args[vfIndex + 1] ?? '';
    expect(vf).toContain('fps=');
    expect(vf).toContain('scale=320:180');
    expect(vf).toContain('force_original_aspect_ratio=decrease');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('12');
    expect(args[args.length - 1]).toBe('/out/f-%04d.jpg');
  });

  it('批处理帧数上限为正', () => {
    expect(MAX_BATCH_FRAMES).toBeGreaterThan(0);
  });

  it('帧时间点落在范围内且递增（等间隔槽中心）', () => {
    expect(frameTimeMsAt(0, 10_000, 0, 10)).toBe(500);
    expect(frameTimeMsAt(0, 10_000, 1, 10)).toBe(1500);
    const last = frameTimeMsAt(0, 10_000, 9, 10);
    expect(last).toBeLessThan(10_000);
    expect(last).toBeGreaterThanOrEqual(0);
  });
});