/**
 * usePlayheadElement（规格 12.3：播放头高频更新不触发 React 重渲染）。
 *
 * 订阅 PlayheadStore，把毫秒位置经统一几何映射换算为 X，直接写入
 * 播放头元素 transform；视口区间或几何变化时（缩放/平移/重排）由
 * 依赖数组触发一次重摆，不等待下一次 publish。
 *
 * 返回的 ref 挂到播放头竖线元素上（绝对定位、left:0、top:0，
 * 由 CSS 控制；本 hook 只写 translateX）。
 */
import { useCallback, useEffect, useRef } from 'react';
import { clamp } from '@shared/time';
import type { PlayheadStore } from '../editor/playhead-store';
import { timeToX } from '../editor/editor-geometry';

export interface PlayheadXParams {
  viewStartMs: number;
  viewEndMs: number;
  plotLeft: number;
  plotWidth: number;
  durationMs: number;
}

export function usePlayheadElement(
  store: PlayheadStore,
  params: PlayheadXParams,
): React.RefObject<HTMLDivElement | null> {
  const elRef = useRef<HTMLDivElement | null>(null);
  // ref 镜像：subscribe 的 listener 闭包必须读到最新区间/几何。
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const applyX = useCallback((timeMs: number) => {
    const el = elRef.current;
    if (!el) {
      return;
    }
    const p = paramsRef.current;
    const t = clamp(timeMs, 0, p.durationMs);
    const x = timeToX(t, { viewStartMs: p.viewStartMs, viewEndMs: p.viewEndMs }, p);
    el.style.transform = `translate3d(${x}px, 0, 0)`;
  }, []);

  useEffect(() => store.subscribe(applyX), [store, applyX]);

  // 视口/几何变化后立刻按当前播放头重摆（不依赖下一次 publish）。
  const { viewStartMs, viewEndMs, plotLeft, plotWidth, durationMs } = params;
  useEffect(() => {
    applyX(store.get());
  }, [applyX, store, viewStartMs, viewEndMs, plotLeft, plotWidth, durationMs]);

  return elRef;
}