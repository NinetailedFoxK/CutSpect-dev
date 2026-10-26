import type { FilmstripBatchParams, FilmstripFrame, LaipianError } from '@shared/api-types';

/**
 * 时间线画面帧的**应用级单例 store**（本轮重构：显式状态机 + 可按时间匹配的帧）。
 *
 * 职责：
 * - 缓存复用：key = 项目 + 范围 + 帧数 + 尺寸；命中即立即返回，不重复请求；
 * - 防抖：可视范围变化时**停止操作约 150ms 后**才发起请求（缩放/平移过程中不刷请求）；
 * - 播放暂停：播放视频 / 拖动播放头时暂停非必要的高清抽帧（避免抢占解码与播放流畅度）；
 * - 状态机：queued（防抖中）→ loading（IPC 已发出）→ ready（有帧，含部分帧）/ error（可重试失败）；
 * - 自动重试：可重试失败最多 2 次（退避 300ms、900ms）；`error` 状态提供手动 retry；
 * - 过期保护：快照按请求 key 存储，旧范围的结果不会覆盖新范围；
 * - 订阅：以 useSyncExternalStore 消费，组件只渲染当前 key 的快照。
 *
 * 单例（模块级）保证所有时间线/组件共用同一份缓存与同一支请求流。
 */

export const FILMSTRIP_DEBOUNCE_MS = 150;
/** 内存缓存的可视范围结果条目上限（磁盘 LRU 由 main 队列管理）。 */
const CACHE_MAX_ENTRIES = 24;

/** 可重试失败的自动重试退避（第 1、2 次）；长度即最大自动重试次数。 */
export const FILMSTRIP_RETRY_DELAYS_MS = [300, 900] as const;
export const FILMSTRIP_MAX_AUTO_RETRIES = FILMSTRIP_RETRY_DELAYS_MS.length;

/** 画面帧请求的状态机取值。 */
export type FilmstripStatus = 'idle' | 'queued' | 'loading' | 'ready' | 'error';

export interface FilmstripSnapshot {
  status: FilmstripStatus;
  frames: FilmstripFrame[];
  error: LaipianError | null;
  /** 该快照对应的请求 key（供渲染层确认"这些帧属于当前视口"）。 */
  requestKey: string | null;
}

const EMPTY_FRAMES: FilmstripFrame[] = [];

/** 稳定引用：无记录 / 浏览器预览时返回，满足 useSyncExternalStore 的引用稳定性要求。 */
export const EMPTY_FILMSTRIP_SNAPSHOT: FilmstripSnapshot = {
  status: 'idle',
  frames: EMPTY_FRAMES,
  error: null,
  requestKey: null,
};

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
  private readonly snapshots = new Map<string, FilmstripSnapshot>();
  private readonly specs = new Map<string, FilmstripRequestSpec>();
  private readonly attempts = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly inflight = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queued: { key: string; spec: FilmstripRequestSpec } | null = null;
  private paused = false;
  private lastProjectId: string | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 当前 key 的快照（引用稳定：无记录时返回同一 EMPTY 常量）。 */
  getSnapshot(key: string | null): FilmstripSnapshot {
    if (key === null) {
      return EMPTY_FILMSTRIP_SNAPSHOT;
    }
    return this.snapshots.get(key) ?? EMPTY_FILMSTRIP_SNAPSHOT;
  }

  /** 播放/拖动播放头时暂停后台高清抽帧；恢复后补发最后一次请求。 */
  setPaused(paused: boolean): void {
    if (this.paused === paused) {
      return;
    }
    this.paused = paused;
    if (paused) {
      this.clearTimer();
    } else {
      this.flush();
    }
  }

  /** 记录当前可视请求（防抖后执行）；相同 key 已在缓存/在途则跳过。 */
  schedule(spec: FilmstripRequestSpec): void {
    const key = filmstripRequestKey(spec);
    if (this.lastProjectId !== spec.projectId) {
      // 切换项目：清空上一项目的缓存并取消失效任务。
      this.dropProject(this.lastProjectId);
      this.lastProjectId = spec.projectId;
    }
    this.specs.set(key, spec);
    const current = this.snapshots.get(key);
    if ((current?.status === 'ready' && current.frames.length > 0) || this.inflight.has(key)) {
      return;
    }
    this.setStatus(key, 'queued');
    this.queued = { key, spec };
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FILMSTRIP_DEBOUNCE_MS);
  }

  /** 手动重试当前 key（error 状态下的「重试」按钮）。重置自动重试计数后立即请求。 */
  retry(key: string): void {
    const spec = this.specs.get(key);
    if (spec === undefined) {
      return;
    }
    this.attempts.delete(key);
    void this.ensure(key, spec);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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
    if (this.inflight.has(key)) {
      return;
    }
    const current = this.snapshots.get(key);
    if (current?.status === 'ready' && current.frames.length > 0) {
      return;
    }
    const api = window.laipian;
    if (api === undefined) {
      // 浏览器预览：无 IPC，保持占位（不进入 error）。
      this.setStatus(key, 'idle');
      return;
    }
    this.inflight.add(key);
    this.setStatus(key, 'loading');
    let result: Awaited<ReturnType<typeof api.media.filmstrip>>;
    try {
      const params: FilmstripBatchParams = {
        projectId: spec.projectId,
        startMs: spec.startMs,
        endMs: spec.endMs,
        count: spec.count,
        width: spec.width,
        height: spec.height,
      };
      result = await api.media.filmstrip(params);
    } catch (cause) {
      this.inflight.delete(key);
      this.handleFailure(key, spec, {
        code: 'IPC_ERROR',
        message: cause instanceof Error ? cause.message : '抽帧请求失败。',
        retryable: true,
      });
      return;
    }
    this.inflight.delete(key);
    if (result.ok) {
      if (result.data.length === 0) {
        this.handleFailure(key, spec, {
          code: 'FRAME_EMPTY',
          message: '未返回时间线画面帧。',
          retryable: true,
        });
        return;
      }
      this.evict();
      this.setSnapshot(key, {
        status: 'ready',
        frames: result.data,
        error: null,
        requestKey: key,
      });
      return;
    }
    const error = result.error;
    // 被更新的请求取消：静默保留，绝不把过期失败盖到新范围。
    if (error.code === 'CANCELLED') {
      return;
    }
    if (error.retryable === true) {
      this.handleFailure(key, spec, error);
      return;
    }
    this.setSnapshot(key, { status: 'error', frames: EMPTY_FRAMES, error, requestKey: key });
  }

  /** 可重试失败：未超过自动重试上限则退避重试（状态回到 queued），否则进入 error。 */
  private handleFailure(key: string, spec: FilmstripRequestSpec, error: LaipianError): void {
    const attempt = this.attempts.get(key) ?? 0;
    if (attempt < FILMSTRIP_MAX_AUTO_RETRIES) {
      this.attempts.set(key, attempt + 1);
      const delay = FILMSTRIP_RETRY_DELAYS_MS[attempt] ?? FILMSTRIP_RETRY_DELAYS_MS[FILMSTRIP_MAX_AUTO_RETRIES - 1];
      this.setStatus(key, 'queued');
      setTimeout(() => {
        if (this.lastProjectId !== spec.projectId) {
          return;
        }
        void this.ensure(key, spec);
      }, delay);
      return;
    }
    this.setSnapshot(key, { status: 'error', frames: EMPTY_FRAMES, error, requestKey: key });
  }

  private evict(): void {
    if (this.snapshots.size < CACHE_MAX_ENTRIES) {
      return;
    }
    const oldest = this.snapshots.keys().next().value;
    if (oldest !== undefined) {
      this.snapshots.delete(oldest);
      this.specs.delete(oldest);
      this.attempts.delete(oldest);
    }
  }

  /** 丢弃某项目缓存（离开项目 / 切换项目）：释放 URL 引用，img 随之卸载。 */
  dropProject(projectId: string | null): void {
    if (projectId === null) {
      return;
    }
    for (const key of [...this.snapshots.keys()]) {
      if (key.startsWith(`${projectId}|`)) {
        this.snapshots.delete(key);
        this.specs.delete(key);
        this.attempts.delete(key);
      }
    }
    const api = window.laipian;
    void api?.media.cancelFilmstrip({ projectId });
    this.notify();
  }

  /** 项目卸载：取消全部任务并清空缓存。 */
  dispose(projectId: string): void {
    this.snapshots.clear();
    this.specs.clear();
    this.attempts.clear();
    this.inflight.clear();
    this.queued = null;
    this.clearTimer();
    const api = window.laipian;
    void api?.media.cancelFilmstrip({ projectId });
    this.notify();
  }

  /** 仅改状态（保留已有帧，用于 queued/loading 期间继续显示上一批图）。 */
  private setStatus(key: string, status: FilmstripStatus): void {
    const current = this.snapshots.get(key);
    const frames = current?.frames ?? EMPTY_FRAMES;
    this.setSnapshot(key, { status, frames, error: null, requestKey: key });
  }

  /** 写入快照；仅在引用/字段变化时替换并通知，避免 useSyncExternalStore 反复渲染。 */
  private setSnapshot(key: string, next: FilmstripSnapshot): void {
    const current = this.snapshots.get(key);
    if (
      current !== undefined &&
      current.status === next.status &&
      current.frames === next.frames &&
      current.error === next.error
    ) {
      return;
    }
    this.snapshots.set(key, next);
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