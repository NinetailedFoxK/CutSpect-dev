import { useCallback, useEffect, useRef, useState } from 'react';
import type { FramePreview } from '@shared/api-types';
import { createLatestOnly, decideThrottle } from '../editor/frame-request';

/**
 * useFramePreview（规格 5.5 / 9）。
 *
 * 按时间点请求精确画面帧，供节点浮层预览卡与右侧属性面板共用：
 * - 相同时间/尺寸命中内存 LRU 时直接复用，不重复生成（规格 5.5）。
 * - 递增代际：旧请求完成后若已有更新请求，则丢弃结果，不把画面拉回旧节点（规格 9）。
 * - leading + trailing 节流：拖动节点期间约每 140ms 更新一次，松手后尾部请求最终帧。
 * - enabled=false 或 timeMs=null 时清空状态（隐藏预览，不残留上一节点画面）。
 */

export interface UseFramePreviewOptions {
  projectId: string;
  timeMs: number | null;
  width: number;
  height: number;
  enabled?: boolean;
}

export interface FramePreviewResult {
  frame: FramePreview | null;
  loading: boolean;
  error: string | null;
}

/** 内存缓存条数上限（进程内；磁盘 LRU 由 main 侧 frame-service 负责）。 */
const MEMORY_CACHE_MAX = 48;

export function useFramePreview(options: UseFramePreviewOptions): FramePreviewResult {
  const { projectId, timeMs, width, height, enabled = true } = options;

  const [frame, setFrame] = useState<FramePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latestRef = useRef(createLatestOnly());
  const cacheRef = useRef(new Map<string, FramePreview>());
  const lastKeyRef = useRef<string | null>(null);
  const latestTimeRef = useRef<number | null>(null);
  const lastRunAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const cacheKey = useCallback(
    (requestedMs: number) => `${projectId}|${requestedMs}|${width}x${height}`,
    [projectId, width, height],
  );

  const run = useCallback(
    (requestedMs: number) => {
      // 每个请求（含缓存命中）都开启新代际，作废在途的旧请求。
      const seq = latestRef.current.begin();
      const key = cacheKey(requestedMs);
      const cached = cacheRef.current.get(key);
      if (cached !== undefined) {
        setFrame(cached);
        setLoading(false);
        setError(null);
        return;
      }
      const api = window.laipian;
      if (!api) {
        setLoading(false);
        setError('浏览器预览模式不支持画面帧。');
        return;
      }
      setLoading(true);
      api.media
        .getFramePreview({ projectId, timeMs: requestedMs, width, height })
        .then((result) => {
          if (!latestRef.current.isCurrent(seq)) {
            return; // 旧请求完成结果不得覆盖最新选择（规格 9）。
          }
          setLoading(false);
          if (!result.ok) {
            setError(result.error.message);
            setFrame(null);
            return;
          }
          if (cacheRef.current.size >= MEMORY_CACHE_MAX) {
            const oldest = cacheRef.current.keys().next().value;
            if (oldest !== undefined) {
              cacheRef.current.delete(oldest);
            }
          }
          cacheRef.current.set(key, result.data);
          setError(null);
          setFrame(result.data);
        })
        .catch(() => {
          if (latestRef.current.isCurrent(seq)) {
            setLoading(false);
            setError('读取画面帧失败。');
          }
        });
    },
    [cacheKey, projectId, width, height],
  );

  useEffect(() => {
    if (!enabled || timeMs === null) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      lastKeyRef.current = null;
      latestTimeRef.current = null;
      setFrame(null);
      setLoading(false);
      setError(null);
      return undefined;
    }
    latestTimeRef.current = timeMs;
    const key = `${timeMs}|${width}x${height}`;
    if (key === lastKeyRef.current) {
      return undefined;
    }
    lastKeyRef.current = key;
    const now = performance.now();
    const decision = decideThrottle(now - lastRunAtRef.current);
    if (decision.immediate) {
      lastRunAtRef.current = now;
      run(timeMs);
    } else if (decision.tailMs !== null && timerRef.current === null) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const latest = latestTimeRef.current;
        if (latest !== null) {
          lastRunAtRef.current = performance.now();
          run(latest);
        }
      }, decision.tailMs);
    }
    return undefined;
  }, [enabled, timeMs, width, height, run]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return { frame, loading, error };
}