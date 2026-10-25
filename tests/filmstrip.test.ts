import { describe, expect, it } from 'vitest';
import {
  FILMSTRIP_MAX_SLOTS,
  buildFilmstrip,
  nearestThumbnail,
} from '../src/renderer/editor/filmstrip';
import type { TimelineThumbnail } from '../src/shared/api-types';

/** 时间线帧带布局测试（规格 4.3 / 9）：纯函数，DOM 数量与时间对齐是关键不变量。 */

function thumbs(times: number[]): TimelineThumbnail[] {
  return times.map((t) => ({
    timeMs: t,
    mediaUrl: `laipian-media://p/m/thumb/thumb-${String(t).padStart(3, '0')}.jpg`,
    width: 160,
    height: 90,
  }));
}

const BASE = thumbs([0, 1000, 2000, 3000, 4000]);

describe('nearestThumbnail', () => {
  it('空数组返回 null', () => {
    expect(nearestThumbnail([], 1234)).toBeNull();
  });

  it('取时间上最近的缩略图', () => {
    expect(nearestThumbnail(BASE, 1400)?.timeMs).toBe(1000);
    expect(nearestThumbnail(BASE, 1600)?.timeMs).toBe(2000);
    expect(nearestThumbnail(BASE, -100)?.timeMs).toBe(0);
    expect(nearestThumbnail(BASE, 9999)?.timeMs).toBe(4000);
  });

  it('等距时取较小时间（确定性）', () => {
    expect(nearestThumbnail(BASE, 1500)?.timeMs).toBe(1000);
  });
});

describe('buildFilmstrip', () => {
  it('非法范围或零宽返回空数组', () => {
    expect(buildFilmstrip(1000, 1000, 800, BASE)).toEqual([]);
    expect(buildFilmstrip(2000, 1000, 800, BASE)).toEqual([]);
    expect(buildFilmstrip(0, 1000, 0, BASE)).toEqual([]);
  });

  it('槽位连续无缝覆盖可见区间，首尾对齐', () => {
    const frames = buildFilmstrip(0, 10_000, 960, BASE);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?.startTimeMs).toBe(0);
    expect(frames[frames.length - 1]?.endTimeMs).toBe(10_000);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]?.startTimeMs).toBe(frames[i - 1]?.endTimeMs);
    }
  });

  it('同屏槽位不超过上限，宽视口取上限、窄视口更少', () => {
    const wide = buildFilmstrip(0, 100_000, 4000, BASE);
    expect(wide.length).toBe(FILMSTRIP_MAX_SLOTS);

    const narrow = buildFilmstrip(0, 100_000, 200, BASE);
    expect(narrow.length).toBeLessThan(FILMSTRIP_MAX_SLOTS);
    expect(narrow.length).toBeGreaterThanOrEqual(1);
  });

  it('每槽填充与其中心时间最近的缩略图（放大时重复使用基础帧）', () => {
    const frames = buildFilmstrip(0, 5000, 960, BASE);
    for (const frame of frames) {
      const center = (frame.startTimeMs + frame.endTimeMs) / 2;
      expect(frame.thumbnail).toEqual(nearestThumbnail(BASE, center));
    }
    // 放大到基础帧间隔以上：相邻槽位会复用同一张基础帧（需求允许）。
    const hasRepeat =
      frames.length > 1 &&
      frames.some((f, i) => i > 0 && f.thumbnail?.timeMs === frames[i - 1]?.thumbnail?.timeMs);
    expect(hasRepeat).toBe(true);
  });

  it('无缩略图时槽位仍铺满、thumbnail 为 null（深色占位）', () => {
    const frames = buildFilmstrip(0, 8000, 960, []);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.thumbnail === null)).toBe(true);
  });
});