/**
 * 时间显示与数值夹紧的纯函数（规格 3.1）。
 * 无 DOM、无文件系统依赖，主进程与渲染层均可复用，vitest 直接覆盖。
 */

/**
 * 把毫秒格式化为 `HH:MM:SS.mmm`；小时段在值为 0 且未强制时省略
 * （界面空间不足时省略小时，规格 3.1 / 14 节）。
 *
 * - 非有限数按 0 处理；负数夹紧到 0；小数毫秒四舍五入到整数。
 * - hours: 'auto'（默认，h>0 才显示）| 'always'（时间轴刻度等场景）。
 */
export function formatTimeMs(
  timeMs: number,
  options: { hours?: 'auto' | 'always' } = {},
): string {
  const safe = Number.isFinite(timeMs) ? Math.max(0, Math.round(timeMs)) : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const ms = safe % 1000;
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  const two = (n: number): string => String(n).padStart(2, '0');
  const three = (n: number): string => String(n).padStart(3, '0');

  const mmss = `${two(minutes)}:${two(seconds)}.${three(ms)}`;
  const showHours = options.hours === 'always' || hours > 0;
  return showHours ? `${two(hours)}:${mmss}` : mmss;
}

/**
 * 数值夹紧到闭区间 [min, max]。min > max 时交换边界（防御性，保证返回值有效）。
 * NaN 返回 min；Infinity 按“贴近 0 的边界”处理。
 */
export function clamp(value: number, min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (Number.isNaN(value)) return lo;
  if (value === Infinity) return hi;
  if (value === -Infinity) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/**
 * 可见时间区间夹紧：区间不得越出 [0, durationMs]（规格 3.3），
 * 且保证 viewEnd > viewStart（至少 minSpan 毫秒，默认 1ms）。
 */
export function clampViewRange(
  viewStartMs: number,
  viewEndMs: number,
  durationMs: number,
  minSpan = 1,
): { viewStartMs: number; viewEndMs: number } {
  const duration = Math.max(0, durationMs);
  const span = Math.max(1, minSpan);
  const start = clamp(viewStartMs, 0, Math.max(0, duration - span));
  const end = clamp(viewEndMs, start + span, duration);
  return { viewStartMs: start, viewEndMs: end };
}