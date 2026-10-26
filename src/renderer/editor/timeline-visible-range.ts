/**
 * 时间区间与视口的**可见交集**（规格：跨视口结构显示）。
 *
 * 章节 / 段落 / 镜头叠加层**共用同一套交集函数**（禁止各自实现）：块保留真实起止数据，
 * 视觉区域用与当前视口的交集，从而在视口中部仍能看到名称；真实起点/终点落在视口外时
 * 标记为向左 / 向右延续，供渲染层显示「从…延续 / 延续至…」。
 */

export interface TimeSpan {
  startMs: number;
  endMs: number;
}

export interface VisibleSpan {
  /** 与视口相交后的起点（真实起点在视口左侧时为视口起点）。 */
  startMs: number;
  /** 与视口相交后的终点（真实终点在视口右侧时为视口终点）。 */
  endMs: number;
  /** 真实起点位于视口左侧：块自左延续进来。 */
  clippedStart: boolean;
  /** 真实终点位于视口右侧：块向右延续出去。 */
  clippedEnd: boolean;
  /** 与视口无交集（应跳过渲染）。 */
  empty: boolean;
}

export function visibleSpanOf(span: TimeSpan, viewStartMs: number, viewEndMs: number): VisibleSpan {
  const startMs = Math.max(span.startMs, viewStartMs);
  const endMs = Math.min(span.endMs, viewEndMs);
  return {
    startMs,
    endMs,
    clippedStart: span.startMs < viewStartMs,
    clippedEnd: span.endMs > viewEndMs,
    empty: endMs <= startMs,
  };
}