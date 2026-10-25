/**
 * 时间线画面帧带规划（规格 4.3 / 8；本轮修复"单图拉伸"）。
 *
 * 纯函数：把「可视时间范围 + 绘图区像素宽 + 缩放」映射为一组**等宽帧槽**，
 * 供时间线帧带与镜头轨按需抽帧。核心约定：
 * - 每个帧槽固定显示宽度（FRAME_TARGET_WIDTH_PX），不随镜头长短拉伸单张图；
 * - 帧槽数量 = ceil(绘图宽 / 目标帧宽)，受 MAX 上限约束（DOM 与请求数受控）；
 * - 缩放放大 → 同样像素宽覆盖更短时间 → 槽内时间点更密（抽帧更密）；
 *   缩放缩小 → 槽数按绘图宽重算，仍不拉伸单张图；
 * - 只输出"当前可视区（可选两侧预加载）"的槽，避免一次加载整条视频。
 *
 * 与请求层配合：每个帧槽在渲染时按 FRAME_REQUEST_TARGET 计算请求尺寸，
 * 实测像素宽越大请求的图越大 => 放大时更清晰（缓存键含范围/帧数/尺寸）。
 */

/** 单个帧槽目标显示宽度（像素）；越小越密。 */
export const FRAME_TARGET_WIDTH_PX = 96;

/** 单帧最小显示宽度：低于此值不再细分（避免过密）。 */
export const FRAME_MIN_WIDTH_PX = 56;

/** 同屏帧槽上限（DOM 与并发请求受控）。 */
export const FILMSTRIP_MAX_FRAMES = 72;

/** 镜头块内单帧上限（长镜头也不无限细分）。 */
export const NODE_MAX_FRAMES = 12;

/** 两侧预加载槽位数（可视区外各多规划几帧）。 */
export const FILMSTRIP_PRELOAD_SLOTS = 1;

/** 请求图片宽度的下限 / 上限（像素）。 */
export const FRAME_REQUEST_MIN_WIDTH = 160;
export const FRAME_REQUEST_MAX_WIDTH = 768;

export interface FrameSlot {
  /** 抽帧时间（槽位中心时间，毫秒）。 */
  timeMs: number;
  /** 槽位起始/结束时间（渲染时经 timeToX 定位，保证与刻度/播放头同一映射）。 */
  startTimeMs: number;
  endTimeMs: number;
  /** 槽位左边缘相对绘图区左边缘的像素位置（widthPx/绘图宽 换算用）。 */
  leftPx: number;
  /** 槽位宽度（像素）。 */
  widthPx: number;
}

export interface TimelineFramePlan {
  frames: FrameSlot[];
  /** 单槽宽度（全部等宽，便于渲染等分）。 */
  slotWidthPx: number;
}

const DEFAULT_ASPECT = 16 / 9;

/**
 * 规划整条可视范围（含预加载）的等宽帧槽。
 * viewEndMs ≤ viewStartMs 或 plotWidth ≤ 0 时返回空。
 */
export function planTimelineFrames(
  viewStartMs: number,
  viewEndMs: number,
  plotWidth: number,
  options: { targetWidthPx?: number; maxFrames?: number; preloadSlots?: number } = {},
): TimelineFramePlan {
  const span = viewEndMs - viewStartMs;
  if (!(span > 0) || !(plotWidth > 0)) {
    return { frames: [], slotWidthPx: 0 };
  }
  const target = Math.max(FRAME_MIN_WIDTH_PX, options.targetWidthPx ?? FRAME_TARGET_WIDTH_PX);
  const maxFrames = Math.max(1, Math.min(options.maxFrames ?? FILMSTRIP_MAX_FRAMES, FILMSTRIP_MAX_FRAMES));
  const preload = Math.max(0, Math.min(options.preloadSlots ?? FILMSTRIP_PRELOAD_SLOTS, 4));

  // 可视槽数 + 两侧预加载（时间上外扩，像素位置允许为负/超出，渲染时被容器裁剪）。
  const visibleCount = Math.max(1, Math.min(maxFrames, Math.ceil(plotWidth / target)));
  const slotWidthPx = plotWidth / visibleCount;
  const slotMs = span / visibleCount;
  const frames: FrameSlot[] = [];
  for (let i = -preload; i < visibleCount + preload; i++) {
    const startTimeMs = viewStartMs + i * slotMs;
    frames.push({
      startTimeMs,
      endTimeMs: startTimeMs + slotMs,
      timeMs: startTimeMs + slotMs / 2,
      leftPx: i * slotWidthPx,
      widthPx: slotWidthPx,
    });
  }
  return { frames, slotWidthPx };
}

/**
 * 由"该帧槽在当前缩放下占用的实际像素宽"计算请求图片尺寸：
 * 放大后槽位像素宽更大 => 请求更大更清晰的图；始终不低于下限。
 */
export function frameRequestSize(
  slotWidthPx: number,
  aspectRatio = DEFAULT_ASPECT,
  dpr = 1,
): { width: number; height: number } {
  const ratio = aspectRatio > 0 ? aspectRatio : DEFAULT_ASPECT;
  const raw = Math.round(slotWidthPx * Math.max(1, dpr));
  const width = Math.max(FRAME_REQUEST_MIN_WIDTH, Math.min(FRAME_REQUEST_MAX_WIDTH, raw));
  const height = Math.max(90, Math.round(width / ratio));
  return { width, height };
}