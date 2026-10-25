/**
 * 工作台布局几何与时间/数值 ↔ 像素映射（规格 2.5 / 3.1）。
 *
 * 左右对齐铁律（规格 2.5）：时间线的有效起止 X 与上方曲线绘图区左右边缘
 * 严格对齐。实现方式：Editor 用 ResizeObserver 测量中央列容器宽度，经
 * computePlotXGeometry 得到唯一一份 { plotLeft, plotWidth }，同时下发给
 * VideoCanvas 与 Timeline；两处禁止各自计算 padding 或时间比例。
 *
 * 本模块是 renderer 侧映射的唯一入口（规格 3.1：曲线、节点、标注、分段线、
 * 时间刻度、缩略图、播放头使用同一个坐标模块）。shared/geometry.ts
 * （并行任务）交付后应切换为从那里导入同义 API，本模块保留为适配层。
 */
import { clamp } from '@shared/time';

/** 左侧工具栏宽度（阶段 B 接工具状态机，本阶段仅渲染禁用的“选择”工具位）。 */
export const TOOLBAR_WIDTH = 48;

/** 右侧属性面板展开宽度（规格 2.5：280；默认收起为 0）。 */
export const PANEL_WIDTH = 280;

/** 绘图区与时间线有效区共同的左右内边距（两处共同扣除，规格 2.5）。 */
export const PLOT_PADDING_X = 12;

/** 画布绘图区上/下内边距（纵轴“低—高”域的呼吸空间）。 */
export const PLOT_PADDING_Y = 16;

/** 绘图区横向几何（以中央列容器内容区为参照系）。 */
export interface PlotXGeometry {
  /** 绘图区左边缘相对容器内容区的 X 偏移（px）。 */
  plotLeft: number;
  /** 绘图区宽度（px，≥1）。 */
  plotWidth: number;
}

/** 绘图区纵向几何（以画布容器内容区为参照系）。 */
export interface PlotYGeometry {
  plotTop: number;
  plotHeight: number;
}

/**
 * 由中央列容器内容区宽度计算绘图区横向几何。
 * VideoCanvas 与 Timeline 必须使用同一容器宽度调用本函数（或直接共享结果）。
 */
export function computePlotXGeometry(containerWidth: number): PlotXGeometry {
  const width = Math.max(1, containerWidth - PLOT_PADDING_X * 2);
  return { plotLeft: PLOT_PADDING_X, plotWidth: width };
}

/** 由画布容器内容区高度计算绘图区纵向几何。 */
export function computePlotYGeometry(containerHeight: number): PlotYGeometry {
  const height = Math.max(1, containerHeight - PLOT_PADDING_Y * 2);
  return { plotTop: PLOT_PADDING_Y, plotHeight: height };
}

/** 可见时间区间（规格 3.1 的 viewStartMs/viewEndMs）。 */
export interface TimeRange {
  viewStartMs: number;
  viewEndMs: number;
}

/** 规格 3.1：timeMs → x。span ≤ 0 时按视口左边缘处理（防御）。 */
export function timeToX(timeMs: number, range: TimeRange, geo: PlotXGeometry): number {
  const span = range.viewEndMs - range.viewStartMs;
  const ratio = span > 0 ? (timeMs - range.viewStartMs) / span : 0;
  return geo.plotLeft + ratio * geo.plotWidth;
}

/** 规格 3.1：x → timeMs（四舍五入到整数毫秒）。 */
export function xToTime(x: number, range: TimeRange, geo: PlotXGeometry): number {
  const span = range.viewEndMs - range.viewStartMs;
  const ratio = geo.plotWidth > 0 ? (x - geo.plotLeft) / geo.plotWidth : 0;
  return Math.round(range.viewStartMs + ratio * span);
}

/** 规格 3.1：value(0—100) → y，顶部为 100。 */
export function valueToY(value: number, geo: PlotYGeometry): number {
  return geo.plotTop + (1 - clamp(value, 0, 100) / 100) * geo.plotHeight;
}

/** 规格 3.1：y → value，夹紧到 [0,100]。 */
export function yToValue(y: number, geo: PlotYGeometry): number {
  const ratio = geo.plotHeight > 0 ? (y - geo.plotTop) / geo.plotHeight : 0;
  return clamp((1 - ratio) * 100, 0, 100);
}

/**
 * 播放头越过可见右边界时的整页后移（规格 3.3）：
 * 新视口把播放头放在 90% 处，保留约 10% 前文；结果 clamp 在 [0, durationMs]。
 */
export function pageForwardRange(
  playheadMs: number,
  spanMs: number,
  durationMs: number,
): TimeRange {
  const duration = Math.max(0, durationMs);
  const span = clamp(spanMs, 1, Math.max(1, duration));
  const start = clamp(playheadMs - span * 0.1, 0, Math.max(0, duration - span));
  const end = clamp(start + span, start + 1, duration);
  return { viewStartMs: start, viewEndMs: end };
}

/**
 * 以锚点保持不动的方式调整可见区间长度（规格 3.3 缩放锚点：
 * 播放头优先，否则视口中心）。结果 clamp 在 [0, durationMs] 且保证跨度。
 */
export function zoomAroundAnchor(
  anchorMs: number,
  newSpanMs: number,
  anchorRatio: number,
  durationMs: number,
): TimeRange {
  const duration = Math.max(0, durationMs);
  const span = clamp(newSpanMs, 1, Math.max(1, duration));
  const anchor = clamp(anchorMs, 0, duration);
  const ratio = clamp(anchorRatio, 0, 1);
  let start = anchor - ratio * span;
  let end = start + span;
  // 先保证跨度，再整体夹进 [0, duration]。
  if (start < 0) {
    start = 0;
    end = Math.min(duration, start + span);
  } else if (end > duration) {
    end = duration;
    start = Math.max(0, end - span);
  }
  if (end <= start) {
    start = Math.max(0, duration - span);
    end = duration;
  }
  return { viewStartMs: Math.round(start), viewEndMs: Math.round(end) };
}

/**
 * 平移可见区间（滚动条拖动 / Shift+滚轮，规格 3.3）。
 * deltaMs > 0 表示向时间轴后方（右）平移。
 */
export function panRange(
  range: TimeRange,
  deltaMs: number,
  durationMs: number,
): TimeRange {
  const duration = Math.max(0, durationMs);
  const span = Math.max(1, range.viewEndMs - range.viewStartMs);
  const start = clamp(range.viewStartMs + deltaMs, 0, Math.max(0, duration - span));
  return { viewStartMs: Math.round(start), viewEndMs: Math.round(start + span) };
}