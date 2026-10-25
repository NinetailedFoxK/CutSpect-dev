/**
 * 播放头发布/订阅存储（规格 3.2 / 12.3）。
 *
 * 播放头每呈现帧更新一次（约 30—60Hz），不允许触发整棵 React 树重渲染：
 * - 唯一写入方：useMediaPlayer（媒体时间，规格 3.2 播放头唯一来源）
 *   与时间线拖动（预览播放头，规格 3.2 拖动时立即更新）。
 * - 消费方：画布播放头、时间线播放头（ref + 直接 DOM transform）、
 *   时间显示（节流进 React state）。
 *
 * 值域：非负毫秒；写入方负责 clamp 到 [0, durationMs]，
 * 本模块只做防御性归一（NaN/Infinity 按 0 处理）。
 */

export interface PlayheadStore {
  /** 当前播放头位置（毫秒）。 */
  get(): number;
  /**
   * 订阅播放头更新，返回取消订阅函数。
   * 单个 listener 抛错只静默记录，不阻断其余订阅者。
   */
  subscribe(listener: (timeMs: number) => void): () => void;
  /** 发布新位置；与当前值相同则不打扰订阅者。 */
  publish(timeMs: number): void;
}

export function createPlayheadStore(initialMs = 0): PlayheadStore {
  let current = sanitizeMs(initialMs);
  const listeners = new Set<(timeMs: number) => void>();

  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(timeMs) {
      const next = sanitizeMs(timeMs);
      if (next === current) {
        return;
      }
      current = next;
      for (const listener of listeners) {
        try {
          listener(next);
        } catch {
          // 单个消费者异常不影响其余订阅者（继续广播）。
        }
      }
    },
  };
}

function sanitizeMs(timeMs: number): number {
  return Number.isFinite(timeMs) ? Math.max(0, timeMs) : 0;
}