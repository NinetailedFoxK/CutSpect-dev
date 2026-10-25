/**
 * useMediaPlayer（规格 3.2 的核心实现）。
 *
 * 铁律：
 * 1. 播放头唯一来源是 video 元素媒体时间：播放时优先
 *    requestVideoFrameCallback（读 callback 第二参 metadata.mediaTime），
 *    不支持时用 rAF 读 currentTime；timeupdate 仅在暂停态补充状态。
 * 2. 最新 seek 优先：异步 seek 用递增 seq，旧 seek 的完成结果与最新目标
 *    不一致时不回写（重新提交最新目标），防止旧结果把画面拉回。
 * 3. 帧回调停止（视频隐藏/透明 0 被合成器跳过）时回退读 currentTime，
 *    避免分析播放头停住。
 * 4. 播放头高频更新走 PlayheadStore（ref + 订阅者直接操作 DOM），
 *    只有低频状态（playing/ready/error/mediaDuration）进 React state。
 * 5. 播放头持久化（规格 8.2）只在暂停、seek 完成、ended、连续播放每 5s
 *    时回调 onPlayheadPersist，不上抛每帧时间。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { clamp } from '@shared/time';
import type { PlayheadStore } from '../editor/playhead-store';
import { createPlayheadStore } from '../editor/playhead-store';

/** rVFC 帧的最大可信静默期：超过则认为帧回调停止，回退 currentTime（毫秒）。 */
const RVFC_STALE_MS = 250;

/** 连续播放中播放头视图快照的合并间隔（规格 8.2：最多每 5 秒一次）。 */
const PLAYHEAD_PERSIST_INTERVAL_MS = 5_000;

/** seeked 完成结果与目标的最大容忍误差（毫秒），超过视为旧结果。 */
const SEEK_MATCH_TOLERANCE_MS = 150;

/** 时间线拖动时 seek 提交节流间隔（毫秒，规格 3.2 节流提交）。 */
export const SCRUB_SEEK_THROTTLE_MS = 80;

export interface MediaPlayerOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** 项目标准时长（唯一时间域，规格 3.1）。 */
  durationMs: number;
  /** 初始播放头（snapshot.view.playheadMs），metadata 后一次性恢复。 */
  initialPlayheadMs: number;
  /** 低频播放头持久化回调（Editor 把它写入 view 并上抛）。 */
  onPlayheadPersist(timeMs: number): void;
}

export interface MediaPlayer {
  playheadStore: PlayheadStore;
  playing: boolean;
  /** metadata 已加载，可安全操作媒体。 */
  ready: boolean;
  /** 视频元素报告的实际时长（毫秒）；时间域仍以 durationMs 为准。 */
  mediaDurationMs: number;
  /** 媒体错误（加载失败/解码失败等），null 表示正常。 */
  error: string | null;
  play(): void;
  pause(): void;
  togglePlay(): void;
  /**
   * 媒体 seek：clamp 到 [0, durationMs] 并立即发布预览播放头；
   * final=true 表示手势结束的最终定位（seeked 校验更严格并触发持久化）。
   */
  seekTo(timeMs: number, opts?: { final?: boolean }): void;
  /** 相对步进（键盘 ←/→ 与 Shift 组合，规格 3.2）。 */
  stepBy(deltaMs: number): void;
  /** 当前播放头毫秒（发布值，供键盘导航读取）。 */
  getPlayheadMs(): number;
  /** 设置播放速率（J/K/L 的 L 循环倍速，规格 6.2）；clamp 到 [0.25, 4]。 */
  setPlaybackRate(rate: number): void;
}

export function useMediaPlayer(options: MediaPlayerOptions): MediaPlayer {
  const { videoRef, durationMs, initialPlayheadMs, onPlayheadPersist } = options;

  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [mediaDurationMs, setMediaDurationMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // store 与各类 ref 的惰性初始化（保持跨渲染稳定）。
  const storeRef = useRef<PlayheadStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createPlayheadStore(clamp(initialPlayheadMs, 0, durationMs));
  }
  const playheadStore = storeRef.current;

  // —— 高频路径使用的 ref 镜像（避免 listener 闭包读到过期值） ——
  const playingRef = useRef(false);
  const durationRef = useRef(durationMs);
  durationRef.current = durationMs;
  const persistRef = useRef(onPlayheadPersist);
  persistRef.current = onPlayheadPersist;

  const initialPlayheadRef = useRef(initialPlayheadMs);
  const seekSeqRef = useRef(0);
  const pendingSeekRef = useRef<{ seq: number; targetMs: number; final: boolean } | null>(null);
  const rvfcHandleRef = useRef<number | null>(null);
  const lastRvfcAtRef = useRef(0);
  const rafHandleRef = useRef<number | null>(null);
  const lastPersistAtRef = useRef(0);

  const publishMs = useCallback(
    (ms: number) => {
      playheadStore.publish(clamp(ms, 0, durationRef.current));
    },
    [playheadStore],
  );

  const persistNow = useCallback((ms: number) => {
    lastPersistAtRef.current = performance.now();
    persistRef.current(Math.round(clamp(ms, 0, durationRef.current)));
  }, []);

  const maybePersistPeriodic = useCallback((ms: number) => {
    const now = performance.now();
    if (now - lastPersistAtRef.current >= PLAYHEAD_PERSIST_INTERVAL_MS) {
      persistNow(ms);
    }
  }, [persistNow]);

  // —— rVFC：播放头首选来源（规格 3.2 [S4]） ——
  const scheduleFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || rvfcHandleRef.current !== null || !playingRef.current) {
      return;
    }
    if (typeof video.requestVideoFrameCallback !== 'function') {
      return; // 不支持：由 rAF 循环负责。
    }
    rvfcHandleRef.current = video.requestVideoFrameCallback((_now, metadata) => {
      rvfcHandleRef.current = null;
      lastRvfcAtRef.current = performance.now();
      const ms = metadata.mediaTime * 1000;
      publishMs(ms);
      maybePersistPeriodic(ms);
      if (playingRef.current) {
        scheduleFrame();
      }
    });
  }, [videoRef, publishMs, maybePersistPeriodic]);

  const cancelFrame = useCallback(() => {
    const video = videoRef.current;
    const handle = rvfcHandleRef.current;
    if (video && handle !== null && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(handle);
    }
    rvfcHandleRef.current = null;
  }, [videoRef]);

  // —— rAF 主循环：双职责（规格 3.2 降级路径 + 帧回调停止回退） ——
  // 1. 不支持 rVFC 的环境：直接读 currentTime 发布；
  // 2. rVFC 静默超过 RVFC_STALE_MS（视频隐藏/透明 0 等被合成器跳过）：
  //    回退读 currentTime，保证媒体时钟驱动播放头不停住。
  const tick = useCallback(() => {
    const video = videoRef.current;
    if (!video || !playingRef.current) {
      return;
    }
    const rvfcFresh = performance.now() - lastRvfcAtRef.current <= RVFC_STALE_MS;
    if (!rvfcFresh) {
      const ms = video.currentTime * 1000;
      publishMs(ms);
      maybePersistPeriodic(ms);
    }
  }, [videoRef, publishMs, maybePersistPeriodic]);

  const startRafLoop = useCallback(() => {
    if (rafHandleRef.current !== null) {
      return;
    }
    const loop = () => {
      tick();
      rafHandleRef.current = requestAnimationFrame(loop);
    };
    rafHandleRef.current = requestAnimationFrame(loop);
  }, [tick]);

  const stopRafLoop = useCallback(() => {
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
    }
    rafHandleRef.current = null;
  }, []);

  // —— 媒体事件监听（真实状态读写，规格 3.2） ——
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return undefined;
    }

    const onLoadedMetadata = () => {
      setReady(true);
      setMediaDurationMs(Number.isFinite(video.duration) ? video.duration * 1000 : 0);
      // 一次性恢复视图播放头；用户已在 metadata 前发起 seek 时尊重用户操作。
      if (seekSeqRef.current === 0 && initialPlayheadRef.current > 0) {
        const targetMs = clamp(initialPlayheadRef.current, 0, durationRef.current);
        pendingSeekRef.current = { seq: ++seekSeqRef.current, targetMs, final: true };
        video.currentTime = targetMs / 1000;
      }
    };

    const onPlay = () => {
      playingRef.current = true;
      setPlaying(true);
      setError(null);
      lastRvfcAtRef.current = performance.now(); // 防刚起播就误判 stale。
      scheduleFrame();
      startRafLoop();
    };

    const onPause = () => {
      playingRef.current = false;
      setPlaying(false);
      cancelFrame();
      stopRafLoop();
      // 规格 8.2：暂停时刷新持久化位置（仍由外层防抖落盘）。
      persistNow(video.currentTime * 1000);
    };

    const onEnded = () => {
      playingRef.current = false;
      setPlaying(false);
      cancelFrame();
      stopRafLoop();
      // timeMs = durationMs 是合法结构终点（规格 3.2）：如实发布并持久化，
      // 不因 ended 触发任何 seek。
      publishMs(durationRef.current);
      persistNow(durationRef.current);
    };

    const onSeeked = () => {
      const pending = pendingSeekRef.current;
      const nowMs = video.currentTime * 1000;
      if (pending) {
        if (Math.abs(nowMs - pending.targetMs) > SEEK_MATCH_TOLERANCE_MS) {
          if (pending.final) {
            // 旧 seek 的完成结果到达，但已有更新的最终目标：重新提交，
            // 防止旧结果把画面拉回（规格 3.2）。
            video.currentTime = pending.targetMs / 1000;
          } else {
            // 拖动中的节流 seek 失配：等下一次节流/最终提交校正，不连环重试。
            pendingSeekRef.current = null;
          }
          return;
        }
        pendingSeekRef.current = null;
        publishMs(pending.targetMs);
        if (pending.final) {
          persistNow(pending.targetMs);
        }
      } else {
        // 非受控 seek（如浏览器自动恢复位置）：如实发布。
        publishMs(nowMs);
      }
    };

    const onTimeUpdate = () => {
      // 仅补充状态（规格 3.2）：暂停态下 currentTime 变化的兜底发布；
      // 播放中的平滑刷新由 rVFC / rAF 负责。
      if (!playingRef.current) {
        publishMs(video.currentTime * 1000);
      }
    };

    const onError = () => {
      const mediaError = video.error;
      setError(
        mediaError
          ? `视频加载或解码失败（code ${mediaError.code}）`
          : '视频加载失败',
      );
    };

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('error', onError);

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('error', onError);
      cancelFrame();
      stopRafLoop();
    };
  }, [videoRef, publishMs, persistNow, scheduleFrame, startRafLoop, cancelFrame, stopRafLoop]);

  const play = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    // 自动播放策略拒绝时保持暂停态；playing 状态由 play 事件驱动。
    void video.play()?.then(
      () => undefined,
      () => undefined,
    );
  }, [videoRef]);

  const pause = useCallback(() => {
    videoRef.current?.pause();
  }, [videoRef]);

  const togglePlay = useCallback(() => {
    if (playingRef.current) {
      pause();
    } else {
      play();
    }
  }, [play, pause]);

  const seekTo = useCallback(
    (timeMs: number, opts: { final?: boolean } = {}) => {
      const video = videoRef.current;
      const targetMs = clamp(Math.round(timeMs), 0, durationRef.current);
      // 立即更新预览播放头（规格 3.2：拖动时立即更新预览）。
      publishMs(targetMs);
      if (!video) {
        return;
      }
      pendingSeekRef.current = {
        seq: ++seekSeqRef.current,
        targetMs,
        final: opts.final === true,
      };
      video.currentTime = targetMs / 1000;
    },
    [videoRef, publishMs],
  );

  const stepBy = useCallback(
    (deltaMs: number) => {
      if (!Number.isFinite(deltaMs) || deltaMs === 0) {
        return;
      }
      seekTo(playheadStore.get() + deltaMs, { final: true });
    },
    [seekTo, playheadStore],
  );

  const getPlayheadMs = useCallback(() => playheadStore.get(), [playheadStore]);

  const setPlaybackRate = useCallback(
    (rate: number) => {
      const video = videoRef.current;
      const next = clamp(rate, 0.25, 4);
      if (video) {
        video.playbackRate = next;
      }
    },
    [videoRef],
  );

  return {
    playheadStore,
    playing,
    ready,
    mediaDurationMs,
    error,
    play,
    pause,
    togglePlay,
    seekTo,
    stepBy,
    getPlayheadMs,
    setPlaybackRate,
  };
}