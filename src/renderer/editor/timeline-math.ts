/**
 * 时间线纯函数：刻度密度自适应与缩放滑杆映射（规格 2.5 / 3.3）。
 *
 * 刻度档位：整秒 → 5 秒 → 30 秒 → 分 → 5 分 → 30 分 → 小时 → …
 * 按可见区间与绘图区像素宽自适应，保证相邻主刻度不小于可读间距。
 * 次刻度为主步长的 1/5。
 */

/** 主刻度步长候选（毫秒）：整秒 / 5 秒 / 30 秒 / 分 / 5 分 / 30 分 / 1 小时 / 3 小时。 */
export const TICK_STEP_CANDIDATES_MS: readonly number[] = [
  1_000, 5_000, 30_000, 60_000, 300_000, 600_000, 1_800_000, 3_600_000, 10_800_000,
];

/** 相邻主刻度的最小像素间距（低于则升档）。 */
export const MIN_TICK_SPACING_PX = 90;

/**
 * 选择当前可见区间下的主刻度步长。
 * 覆盖全部候选仍不够密时返回最大档（超长片的极端缩放，标签会稀疏但可用）。
 */
export function chooseTickStepMs(spanMs: number, plotWidth: number): number {
  if (!(spanMs > 0) || !(plotWidth > 0)) {
    return TICK_STEP_CANDIDATES_MS[0] ?? 1_000;
  }
  for (const step of TICK_STEP_CANDIDATES_MS) {
    if ((step / spanMs) * plotWidth >= MIN_TICK_SPACING_PX) {
      return step;
    }
  }
  return TICK_STEP_CANDIDATES_MS[TICK_STEP_CANDIDATES_MS.length - 1] ?? 10_800_000;
}

/** 单条刻度：major 为主刻度（带标签），其余为次刻度。 */
export interface TickMark {
  timeMs: number;
  major: boolean;
}

/**
 * 生成 [viewStartMs, viewEndMs] 内对齐到步长网格的刻度序列。
 * 次刻度步长 = 主步长 / 5（向下取整到毫秒，至少 1ms）；
 * includeMinor=false 时只生成主刻度（次刻度像素间距过密时由调用方关闭）。
 */
export function buildTicks(
  viewStartMs: number,
  viewEndMs: number,
  stepMs: number,
  options: { includeMinor?: boolean } = {},
): TickMark[] {
  if (!(stepMs > 0) || !(viewEndMs > viewStartMs)) {
    return [];
  }
  const includeMinor = options.includeMinor !== false;
  const minor = Math.max(1, Math.round(stepMs / 5));
  const ticks: TickMark[] = [];
  // 上限保护：极端缩放下（span 巨大而步长最小档）避免生成海量节点。
  const maxTicks = 2000;
  if (!includeMinor) {
    const first = Math.ceil(viewStartMs / stepMs) * stepMs;
    const last = Math.floor(viewEndMs / stepMs) * stepMs;
    for (let t = first; t <= last && ticks.length < maxTicks; t += stepMs) {
      ticks.push({ timeMs: t, major: true });
    }
    return ticks;
  }
  const first = Math.ceil(viewStartMs / minor) * minor;
  const last = Math.floor(viewEndMs / minor) * minor;
  for (let t = first; t <= last && ticks.length < maxTicks; t += minor) {
    ticks.push({ timeMs: t, major: t % stepMs === 0 });
  }
  return ticks;
}

/**
 * 缩放滑杆 ↔ 可见区间跨度的对数映射（规格 3.3）。
 * t = 0 表示全片，t = 1 表示最短可见区间 min(1000ms, durationMs)。
 */
export function spanFromSlider(t: number, durationMs: number): number {
  const duration = Math.max(1, durationMs);
  const minSpan = Math.min(1000, duration);
  const ratio = clamp01(t);
  return Math.max(minSpan, Math.round(duration * Math.pow(minSpan / duration, ratio)));
}

/** spanFromSlider 的反函数（滑杆受控值显示用，允许 clamp 到边界）。 */
export function sliderFromSpan(spanMs: number, durationMs: number): number {
  const duration = Math.max(1, durationMs);
  const minSpan = Math.min(1000, duration);
  const ratio = clamp(spanMs, minSpan, duration) / duration;
  const logBase = Math.log(minSpan / duration);
  if (logBase === 0) {
    // duration ≤ 1000ms：全片即最短区间，滑杆恒为 0（最小跨度）。
    return 0;
  }
  return clamp01(Math.log(ratio) / logBase);
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function clamp(v: number, min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Number.isNaN(v) ? lo : Math.min(hi, Math.max(lo, v));
}