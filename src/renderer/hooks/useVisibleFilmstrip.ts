import { useEffect, useSyncExternalStore } from 'react';
import type { FilmstripFrame } from '@shared/api-types';
import {
  filmstripStore,
  filmstripRequestKey,
  type FilmstripRequestSpec,
} from '../editor/filmstrip-store';

/**
 * 订阅"当前可视范围"的画面帧（应用级 store）。
 *
 * - spec 为 null（浏览器预览 / 视频未就绪）时不请求，返回 null（渲染层显示占位）；
 * - 通过 useSyncExternalStore 只读缓存结果：请求完成自动触发重渲染替换占位；
 * - paused=true（播放中 / 拖动播放头）时暂停新请求，保证播放流畅。
 */
export function useVisibleFilmstrip(
  spec: FilmstripRequestSpec | null,
  options: { paused?: boolean } = {},
): FilmstripFrame[] | null {
  const paused = options.paused ?? false;
  const key = spec === null ? null : filmstripRequestKey(spec);

  const frames = useSyncExternalStore(
    filmstripStore.subscribe,
    () => (key === null ? null : filmstripStore.getFrames(key)),
    () => null,
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

  return frames;
}