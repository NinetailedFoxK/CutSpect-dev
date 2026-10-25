/**
 * 渲染层展示格式化工具（项目库 / 导入页专用，纯函数）。
 *
 * 与 src/shared/time.ts 的分工：time.ts 是跨进程的时间契约纯函数（已有冒烟测试，
 * 不在本任务改动范围）；本文件只服务 renderer 的展示细节（文件大小、相对时间、
 * 文件名派生），不进入 main 进程。
 */

/** 1024 进制的字节量显示；null / 非有限数显示 “—”（数据未就绪的降级，不显示假数字）。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[0]}`;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * 最近编辑时间的中文相对显示（规格 2.2 卡片信息）。
 * 一周内：刚刚 / x 分钟前 / x 小时前 / x 天前；更早回落为本地日期 YYYY-MM-DD。
 * 非法 ISO 字符串防御性显示 “—”。
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return '—';
  }
  const diffMs = now - time;
  if (diffMs < 0) {
    // 未来时间戳（时钟偏差等）按“刚刚”处理，避免显示负数时间段。
    return '刚刚';
  }
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) {
    return '刚刚';
  }
  if (diffMs < hour) {
    return `${Math.floor(diffMs / minute)} 分钟前`;
  }
  if (diffMs < day) {
    return `${Math.floor(diffMs / hour)} 小时前`;
  }
  if (diffMs < 7 * day) {
    return `${Math.floor(diffMs / day)} 天前`;
  }
  const date = new Date(time);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/**
 * 从视频文件名派生默认项目名：去掉最后一个扩展名（规格 2.3）。
 * 无扩展名或隐藏文件（“.”开头）时原样返回；空串原样返回。
 */
export function stripExtension(fileName: string): string {
  if (fileName.length === 0) {
    return fileName;
  }
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0) {
    // lastDot === -1：无扩展名；=== 0：形如 “.mov” 的隐藏名，保留原样。
    return fileName;
  }
  return fileName.slice(0, lastDot);
}
function isPositiveInt(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 计算两个正整数最大公约数（画面比例化简用）。 */
function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

/** 分辨率展示："1920 × 1080"；非法值显示"—"。 */
export function formatResolution(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  if (!isPositiveInt(width) || !isPositiveInt(height)) {
    return '—';
  }
  return `${Math.round(width)} × ${Math.round(height)}`;
}

/** 常见画面比例（含电影宽银幕），命中则用标准写法。 */
const COMMON_ASPECTS: ReadonlyArray<readonly [number, number]> = [
  [16, 9],
  [9, 16],
  [4, 3],
  [3, 4],
  [3, 2],
  [2, 3],
  [21, 9],
  [1, 1],
  [2.39, 1],
];

/** 画面比例展示："16:9"；非标准比例退化为化简比。非法值显示"—"。 */
export function formatAspectRatio(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  if (!isPositiveInt(width) || !isPositiveInt(height)) {
    return '—';
  }
  const ratio = width / height;
  for (const [a, b] of COMMON_ASPECTS) {
    if (Math.abs(a / b - ratio) < 0.011) {
      return `${a}:${b}`;
    }
  }
  const g = gcd(width, height);
  return `${Math.round(width / g)}:${Math.round(height / g)}`;
}
/** 本地时钟时间 HH:MM:SS（"最近成功保存时间"展示用）；非法值显示"—"。 */
export function formatClockTime(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs)) {
    return '—';
  }
  const date = new Date(epochMs);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}