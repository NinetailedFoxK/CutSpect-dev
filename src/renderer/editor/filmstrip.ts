import type { TimelineThumbnail } from '@shared/api-types';

/**
 * 时间线帧带布局（规格 4.3 / 9）。
 *
 * 纯函数：把「可见时间范围 + 绘图区像素宽 + 已生成的缩略图」映射为一组槽位。
 * - 槽位数量随缩放自适应：可见区窄时少、宽时多，但恒不超过 MAX_SLOTS，
 *   保证长视频下真实图片 DOM 数量受控（规格 4.3 / 9）。
 * - 每个槽位用「与槽位中心时间最近的缩略图」填充；放大到基础帧间隔以上时
 *   同一张缩略图会被重复用到相邻槽位，帧带仍铺满、不出现大量空白（规格 4.3）。
 * - 槽位按时间连续无缝排列，左边缘对齐槽位起始时间，从而与同一 timeToX 映射
 *  严格对应（规格 3.1 / 4.2）。
 */

/** 同屏真实图片 DOM 上限（规格 4.3：建议最多 24 个真实图片 DOM）。 */
export const FILMSTRIP_MAX_SLOTS = 24;

/** 单个画面建议显示宽度（规格 4.3：72—120px，取中值作为目标密度）。 */
export const FILMSTRIP_TARGET_WIDTH_PX = 96;

export interface FilmstripFrame {
  /** 槽位起始时间（左边缘对应时间）。 */
  startTimeMs: number;
  /** 槽位结束时间（右边缘对应时间）。 */
  endTimeMs: number;
  /** 选中的缩略图；无可用缩略图时为 null（渲染层显示深色占位）。 */
  thumbnail: TimelineThumbnail | null;
}

/** 与给定时间点最近的缩略图；空数组返回 null。缩略图按时间升序时用二分查找。 */
export function nearestThumbnail(
  thumbnails: readonly TimelineThumbnail[],
  timeMs: number,
): TimelineThumbnail | null {
  if (thumbnails.length === 0) {
    return null;
  }
  let lo = 0;
  let hi = thumbnails.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const candidate = thumbnails[mid];
    if (candidate === undefined) {
      break;
    }
    if (candidate.timeMs < timeMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const after = thumbnails[lo];
  const before = thumbnails[lo - 1];
  if (after === undefined) {
    return before ?? null;
  }
  if (before === undefined) {
    return after;
  }
  // 等距时取较小时间（更早的帧），保证确定性。
  return Math.abs(after.timeMs - timeMs) < Math.abs(timeMs - before.timeMs) ? after : before;
}

/**
 * 生成帧带槽位。viewEndMs ≤ viewStartMs 或绘图区宽 ≤ 0 时返回空数组。
 * slotCount = clamp(ceil(plotWidth / 目标宽), 1, maxSlots)。
 */
export function buildFilmstrip(
  viewStartMs: number,
  viewEndMs: number,
  plotWidth: number,
  thumbnails: readonly TimelineThumbnail[],
  maxSlots = FILMSTRIP_MAX_SLOTS,
): FilmstripFrame[] {
  const span = viewEndMs - viewStartMs;
  if (!(span > 0) || !(plotWidth > 0)) {
    return [];
  }
  const limit = Math.max(1, Math.min(maxSlots, FILMSTRIP_MAX_SLOTS));
  const slotCount = Math.max(1, Math.min(limit, Math.ceil(plotWidth / FILMSTRIP_TARGET_WIDTH_PX)));
  const slotSpan = span / slotCount;
  const frames: FilmstripFrame[] = [];
  for (let i = 0; i < slotCount; i++) {
    const startTimeMs = viewStartMs + i * slotSpan;
    const endTimeMs = i === slotCount - 1 ? viewEndMs : startTimeMs + slotSpan;
    const mid = (startTimeMs + endTimeMs) / 2;
    frames.push({
      startTimeMs,
      endTimeMs,
      thumbnail: nearestThumbnail(thumbnails, mid),
    });
  }
  return frames;
}