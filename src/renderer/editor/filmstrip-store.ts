import type { FilmstripBatchParams, FilmstripFrame } from '@shared/api-types';

/**
 * 时间线画面帧的**应用级单例 store**（本轮重构：替代"每次渲染创建独立队列 + 并发 6"）。
 *
 * 职责：
 * - 缓存复用：key = 项目 + 范围 + 帧数 + 尺寸；命中即立即返回，不重复请求；
 * - 防抖：可视范围变化时**停止操作约 150ms 后**才发起请求（缩放/平移过程中不刷请求）；
 * - 播放暂停：播放视频 / 拖动播放头时暂停非必要的高清抽帧（避免抢占解码与播放流畅度）；
 * - 取消：范围变化时旧请求作废（main 侧队列会 kill 对应 ffmpeg）；
 * - 订阅：以 useSyncExternalStore 消费，组件只渲染缓存中的帧。
 *
 * 单例（模块级）保证所有时间线/组件共用同一份缓存与同一支请求流。
 */

export const FILMSTRIP_DEBOUNCE_MS = 150;
/** 内存缓存的可视范围结果条目上限（磁盘 LRU 由 main 队列管理）。 */
const CACHE_MAX_ENTRIES = 24;

export interface FilmstripRequestSpec {
  projectId: string;
  startMs: number;
  endMs: number;
  count: number;
  width: number;
  height: number;
}

export function filmstripRequestKey(spec: FilmstripRequestSpec): string {
  return `${spec.projectId}|${Math.round(spec.startMs)}|${Math.round(spec.endMs)}|${spec.count}|${spec.width}x${spec.height}`;
}

class FilmstripStore {
  private readonly cache = new Map<string, FilmstripFrame[]>();
  private readonly listeners = new Set<() => void>();
  private readonly inflight = new Set<string>();
  private timer: number | null = null;
  private queued: { key: string; spec: FilmstripRequestSpec } | null = null;
  private paused = false;
  private lastProjectId: string | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getFrames(key: string): FilmstripFrame[] | null {
    return this.cache.get(key) ?? null;
  }

  /** 播放/拖动播放头时暂停后台高清抽帧；恢复后补发最后一次请求。 */
  setPaused(paused: boolean): void {
    if (this.paused === paused) {
      return;
    }
    this.paused = paused;
    if (paused) {
      if (this.timer !== null) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
    } else {
      this.flush();
    }
  }

  /** 记录当前可视请求（防抖后执行）；相同 key 已在缓存/在途则跳过。 */
  schedule(spec: FilmstripRequestSpec): void {
    const key = filmstripRequestKey(spec);
    if (this.lastProjectId !== spec.projectId) {
      // 切换项目：清空上一项目的缓存并取消失效任务（第 10 条）。
      this.dropProject(this.lastProjectId);
      this.lastProjectId = spec.projectId;
    }
    if (this.cache.has(key) || this.inflight.has(key)) {
      return;
    }
    this.queued = { key, spec };
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FILMSTRIP_DEBOUNCE_MS);
  }

  private flush(): void {
    if (this.paused) {
      return;
    }
    const queued = this.queued;
    this.queued = null;
    if (queued === null) {
      return;
    }
    void this.ensure(queued.key, queued.spec);
  }

  private async ensure(key: string, spec: FilmstripRequestSpec): Promise<void> {
    if (this.cache.has(key) || this.inflight.has(key)) {
      return;
    }
    const api = window.laipian;
    if (api === undefined) {
      return;
    }
    this.inflight.add(key);
    try {
      const params: FilmstripBatchParams = {
        projectId: spec.projectId,
        startMs: spec.startMs,
        endMs: spec.endMs,
        count: spec.count,
        width: spec.width,
        height: spec.height,
      };
      const result = await api.media.filmstrip(params);
      this.inflight.delete(key);
      if (!result.ok || result.data.length === 0) {
        return;
      }
      if (this.cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) {
          this.cache.delete(oldest);
        }
      }
      this.cache.set(key, result.data);
      this.notify();
    } catch {
      this.inflight.delete(key);
    }
  }

  /** 丢弃某项目缓存（离开项目 / 切换项目）：释放 URL 引用，img 随之卸载。 */
  dropProject(projectId: string | null): void {
    if (projectId === null) {
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${projectId}|`)) {
        this.cache.delete(key);
      }
    }
    const api = window.laipian;
    void api?.media.cancelFilmstrip({ projectId });
    this.notify();
  }

  /** 项目卸载：取消全部任务并清空缓存。 */
  dispose(projectId: string): void {
    this.cache.clear();
    this.inflight.clear();
    this.queued = null;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    const api = window.laipian;
    void api?.media.cancelFilmstrip({ projectId });
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** 模块级单例：所有时间线共用（不随渲染重建）。 */
export const filmstripStore = new FilmstripStore();