import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilmstripBatchParams, FilmstripFrame } from '../src/shared/api-types';
import {
  FILMSTRIP_DEBOUNCE_MS,
  filmstripRequestKey,
  filmstripStore,
  type FilmstripRequestSpec,
} from '../src/renderer/editor/filmstrip-store';

/**
 * 画面帧 store 状态机测试（第 8.2 节）。
 *
 * node 环境没有 DOM，这里手工注入 `globalThis.window.laipian.media`（store 只依赖
 * `window.laipian` 与全局 setTimeout），并用 fake timers 驱动防抖与退避重试。
 */

type MockResult =
  | { ok: true; data: FilmstripFrame[] }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

function installApi(filmstrip: (params: FilmstripBatchParams) => Promise<MockResult>): void {
  (globalThis as unknown as { window: unknown }).window = {
    laipian: {
      media: {
        filmstrip,
        cancelFilmstrip: async () => ({ ok: true, data: undefined }),
      },
    },
  };
}

function makeFrames(count: number, startMs = 0, stepMs = 1_000): FilmstripFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    timeMs: startMs + i * stepMs,
    mediaUrl: `url-${i}`,
  }));
}

function spec(over: Partial<FilmstripRequestSpec> = {}): FilmstripRequestSpec {
  return { projectId: 'p1', startMs: 0, endMs: 10_000, count: 10, width: 320, height: 180, ...over };
}

beforeEach(() => {
  vi.useFakeTimers();
  installApi(async () => ({ ok: true, data: [] }));
  filmstripStore.dispose('p1');
});

afterEach(() => {
  filmstripStore.setPaused(false);
  vi.useRealTimers();
  (globalThis as unknown as { window?: unknown }).window = undefined;
});

describe('filmstripStore 状态机', () => {
  it('idle → queued → loading → ready，并逐次通知订阅者', async () => {
    const api = vi.fn(async () => ({ ok: true as const, data: makeFrames(10) }));
    installApi(api);
    const key = filmstripRequestKey(spec());
    const seen: string[] = [];
    const unsub = filmstripStore.subscribe(() => seen.push(filmstripStore.getSnapshot(key).status));

    expect(filmstripStore.getSnapshot(key).status).toBe('idle');
    filmstripStore.schedule(spec());
    expect(filmstripStore.getSnapshot(key).status).toBe('queued');

    await vi.advanceTimersByTimeAsync(FILMSTRIP_DEBOUNCE_MS + 5);
    expect(filmstripStore.getSnapshot(key).status).toBe('ready');
    expect(filmstripStore.getSnapshot(key).frames).toHaveLength(10);
    expect(seen).toContain('queued');
    expect(seen).toContain('loading');
    expect(seen).toContain('ready');
    unsub();
  });

  it('不可重试失败进入 error 并携带错误信息', async () => {
    installApi(async () => ({
      ok: false as const,
      error: { code: 'NO_MEDIA', message: '素材不可用', retryable: false },
    }));
    const key = filmstripRequestKey(spec());
    filmstripStore.schedule(spec());
    await vi.advanceTimersByTimeAsync(FILMSTRIP_DEBOUNCE_MS + 5);
    const snap = filmstripStore.getSnapshot(key);
    expect(snap.status).toBe('error');
    expect(snap.error?.code).toBe('NO_MEDIA');
  });

  it('可重试失败最多自动重试 2 次后进入 error', async () => {
    const api = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'FRAME_FAILED', message: '失败', retryable: true },
    }));
    installApi(api);
    const key = filmstripRequestKey(spec());
    filmstripStore.schedule(spec());
    await vi.advanceTimersByTimeAsync(FILMSTRIP_DEBOUNCE_MS + 5);
    expect(api).toHaveBeenCalledTimes(1);
    expect(filmstripStore.getSnapshot(key).status).toBe('queued');
    await vi.advanceTimersByTimeAsync(305);
    expect(api).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(905);
    expect(api).toHaveBeenCalledTimes(3);
    expect(filmstripStore.getSnapshot(key).status).toBe('error');
  });

  it('CANCELLED 静默忽略，不进入 error', async () => {
    const api = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'CANCELLED', message: '取消', retryable: true },
    }));
    installApi(api);
    const key = filmstripRequestKey(spec());
    filmstripStore.schedule(spec());
    await vi.advanceTimersByTimeAsync(FILMSTRIP_DEBOUNCE_MS + 5);
    expect(api).toHaveBeenCalledTimes(1);
    expect(filmstripStore.getSnapshot(key).status).not.toBe('error');
  });

  it('成功但零帧视为可重试失败（不永久留白）', async () => {
    const api = vi.fn(async () => ({ ok: true as const, data: [] }));
    installApi(api);
    const key = filmstripRequestKey(spec());
    filmstripStore.schedule(spec());
    await vi.advanceTimersByTimeAsync(FILMSTRIP_DEBOUNCE_MS + 5);
    await vi.advanceTimersByTimeAsync(305);
    await vi.advanceTimersByTimeAsync(905);
    expect(filmstripStore.getSnapshot(key).status).toBe('error');
  });

  it('旧范围结果按 key 隔离，不覆盖新范围', async () => {
    let resolveA: ((value: MockResult) => void) | undefined;
    installApi(
      (params) =>
        new Promise<MockResult>((resolve) => {
          if (params.startMs === 0) {
            resolveA = resolve;
          } else {
            resolve({ ok: true, data: makeFrames(10, 20_000) });
          }
        }),
    );
    const specA = spec({ startMs: 0, endMs: 10_000 });
    const specB = spec({ startMs: 20_000, endMs: 30_000 });
    const keyA = filmstripRequestKey(specA);
    const keyB = filmstripRequestKey(specB);

    filmstripStore.schedule(specA);
    await vi.advanceTimersByTimeAsync(FILMSTRIP_DEBOUNCE_MS + 5); // A 挂起（loading）
    filmstripStore.schedule(specB);
    await vi.advanceTimersByTimeAsync(FILMSTRIP_DEBOUNCE_MS + 5); // B 完成
    expect(filmstripStore.getSnapshot(keyB).status).toBe('ready');

    resolveA?.({ ok: true, data: makeFrames(10) });
    await vi.advanceTimersByTimeAsync(0);
    expect(filmstripStore.getSnapshot(keyA).status).toBe('ready');
    expect(filmstripStore.getSnapshot(keyB).status).toBe('ready');
  });

  it('error 后手动 retry 能恢复为 ready', async () => {
    let calls = 0;
    installApi(async () => {
      calls += 1;
      return calls < 4
        ? { ok: false as const, error: { code: 'FRAME_FAILED', message: '失败', retryable: true } }
        : { ok: true as const, data: makeFrames(3) };
    });
    const key = filmstripRequestKey(spec());
    filmstripStore.schedule(spec());
    await vi.advanceTimersByTimeAsync(FILMSTRIP_DEBOUNCE_MS + 5);
    await vi.advanceTimersByTimeAsync(305);
    await vi.advanceTimersByTimeAsync(905);
    expect(filmstripStore.getSnapshot(key).status).toBe('error');

    filmstripStore.retry(key);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(filmstripStore.getSnapshot(key).status).toBe('ready');
    expect(filmstripStore.getSnapshot(key).frames).toHaveLength(3);
  });

  it('暂停期间不请求，恢复后补发最后一次', async () => {
    const api = vi.fn(async () => ({ ok: true as const, data: makeFrames(10) }));
    installApi(api);
    const key = filmstripRequestKey(spec());

    filmstripStore.setPaused(true);
    filmstripStore.schedule(spec());
    await vi.advanceTimersByTimeAsync(FILMSTRIP_DEBOUNCE_MS + 5);
    expect(api).not.toHaveBeenCalled();

    filmstripStore.setPaused(false);
    await vi.advanceTimersByTimeAsync(5);
    expect(api).toHaveBeenCalledTimes(1);
    expect(filmstripStore.getSnapshot(key).status).toBe('ready');
  });
});