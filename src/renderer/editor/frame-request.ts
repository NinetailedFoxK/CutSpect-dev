/**
 * 画面帧请求的竞态与节流规则（规格 5.5 / 9）。
 *
 * - createLatestOnly：为每次请求开启一个新的“代际”，旧代际的结果一律丢弃，
 *   保证快速切换节点时后一个请求覆盖前一个、旧结果不会把画面拉回旧节点。
 * - FRAME_PREVIEW_THROTTLE_MS：拖动节点时请求节流间隔（规格 5.5：100—150ms）。
 */

export interface LatestOnly {
  /** 开启新代际，返回其序号。 */
  begin(): number;
  /** 某代际是否为最新（旧代际结果应丢弃）。 */
  isCurrent(seq: number): boolean;
}

export function createLatestOnly(): LatestOnly {
  let current = 0;
  return {
    begin: () => {
      current += 1;
      return current;
    },
    isCurrent: (seq) => seq === current,
  };
}

/** 拖动节点时精确帧请求的节流间隔（毫秒，规格 5.5：约 100—150ms 一次）。 */
export const FRAME_PREVIEW_THROTTLE_MS = 140;

/**
 * 判断在距上次真正发起请求 `sinceMs` 之后，本次变化应「立即请求」还是「延后到尾部」。
 * tail 表示需要安排一个尾部请求以捕获最后一次变化（松手最终帧）。
 */
export function decideThrottle(
  sinceMs: number,
  intervalMs = FRAME_PREVIEW_THROTTLE_MS,
): { immediate: boolean; tailMs: number | null } {
  if (sinceMs >= intervalMs) {
    return { immediate: true, tailMs: null };
  }
  return { immediate: false, tailMs: Math.max(0, intervalMs - sinceMs) };
}