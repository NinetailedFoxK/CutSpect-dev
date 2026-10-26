import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { FilmstripFrame, LaipianError } from '@shared/api-types';
import {
  EMPTY_FILMSTRIP_SNAPSHOT,
  filmstripRequestKey,
  filmstripStore,
  type FilmstripRequestSpec,
  type FilmstripStatus,
} from '../editor/filmstrip-store';

/**
 * 订阅"当前可视范围"的画面帧快照（应用级 store）。
 *
 * - spec 为 null（浏览器预览 / 大跨度只用基础缩略图 / 视频未就绪）时不请求；
 * - 通过 useSyncExternalStore 只读缓存快照：状态与帧变化自动触发重渲染；
 * - 返回 status（queued/loading/ready/error）供渲染层显示加载/失败/重试；
 * - paused=true（播放中 / 拖动播放头）时暂停新请求，保证播放流畅。
 */
export interface VisibleFilmstrip {
  status: FilmstripStatus;
  frames: FilmstripFrame[];
  error: LaipianError | null;
  /** 手动重试当前范围（error 状态的「重试」）。 */
  retry: () => void;
}

export function useVisibleFilmstrip(
  spec: FilmstripRequestSpec | null,
  options: { paused?: boolean } = {},
): VisibleFilmstrip {
  const paused = options.paused ?? false;
  const key = spec === null ? null : filmstripRequestKey(spec);

  const snapshot = useSyncExternalStore(
    filmstripStore.subscribe,
    () => filmstripStore.getSnapshot(key),
    () => EMPTY_FILMSTRIP_SNAPSHOT,
  );

  useEffect(() => {
    if (spec !== null) {
      filmstripStore.schedule(spec);
    }
    // 以字段为依赖，避免每次新建 spec 对象触发重复调度。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    spec?.projectId,
    spec?.startMs,
    spec?.endMs,
    spec?.count,
    spec?.width,
    spec?.height,
  ]);

  useEffect(() => {
    filmstripStore.setPaused(paused);
  }, [paused]);

  const retry = useCallback(() => {
    if (key !== null) {
      filmstripStore.retry(key);
    }
  }, [key]);

  return { status: snapshot.status, frames: snapshot.frames, error: snapshot.error, retry };
}