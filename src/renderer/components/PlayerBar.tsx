/**
 * PlayerBar（规格 2.5 播放条 / 3.2 / 14）。
 *
 * - 播放/暂停读写 video 真实状态（空格全局快捷键在 Editor 层处理，
 *   文本框聚焦/输入法组合时禁用，规格 14）。
 * - 当前时间/总时长用 formatTimeMs（规格 3.1）；时间是媒体时钟，
 *   不受倍速影响。时间显示订阅播放头 store 并以 100ms 节流进
 *   React state（低频，规格 12.3）。
 * - 倍速 0.5×/1×/1.5×/2×、音量与静音写入 view（Editor 持久化），
 *   并同步到 video 元素真实属性。
 */
import { useEffect, useRef, useState } from 'react';
import type { ProjectView } from '@shared/api-types';
import { formatTimeMs } from '@shared/time';
import type { PlayheadStore } from '../editor/playhead-store';
import { Icon } from './Icons';

/** 时间显示的最小刷新间隔（毫秒）：数字滚动可读且 setState 低频。 */
const DISPLAY_THROTTLE_MS = 100;

export const PLAYBACK_RATES = [0.5, 1, 1.5, 2] as const;

export interface PlayerBarProps {
  playing: boolean;
  ready: boolean;
  durationMs: number;
  playheadStore: PlayheadStore;
  view: ProjectView;
  onTogglePlay(): void;
  onPlaybackRateChange(rate: number): void;
  onVolumeChange(volume: number): void;
  onMutedChange(muted: boolean): void;
}

export function PlayerBar(props: PlayerBarProps) {
  const { playing, ready, durationMs, playheadStore, view } = props;
  const { onTogglePlay, onPlaybackRateChange, onVolumeChange, onMutedChange } = props;

  // 时间显示：订阅播放头，节流进 React state（规格 12.3 低频状态）。
  const [displayMs, setDisplayMs] = useState(() => playheadStore.get());
  const lastShownRef = useRef(-1);
  useEffect(() => {
    setDisplayMs(playheadStore.get());
    lastShownRef.current = -1;
    return playheadStore.subscribe((ms) => {
      if (Math.abs(ms - lastShownRef.current) >= DISPLAY_THROTTLE_MS) {
        lastShownRef.current = ms;
        setDisplayMs(ms);
      }
    });
  }, [playheadStore]);

  const volumePercent = Math.round(view.volume * 100);

  return (
    <div className="lp-playerbar" role="toolbar" aria-label="播放控制">
      <button
        type="button"
        className="lp-play-button"
        onClick={onTogglePlay}
        disabled={!ready}
        aria-label={playing ? '暂停（空格）' : '播放（空格）'}
        title={playing ? '暂停（空格）' : '播放（空格）'}
      >
        <Icon name={playing ? 'pause' : 'play'} size={20} />
      </button>

      <div className="lp-time-display" aria-live="off">
        <span className="lp-time-current">{formatTimeMs(displayMs)}</span>
        <span className="lp-time-sep">/</span>
        <span className="lp-time-total">{formatTimeMs(durationMs)}</span>
      </div>

      <div className="lp-rate-group" role="group" aria-label="倍速">
        {PLAYBACK_RATES.map((rate) => (
          <button
            key={rate}
            type="button"
            className={
              view.playbackRate === rate ? 'lp-rate-button is-active' : 'lp-rate-button'
            }
            onClick={() => onPlaybackRateChange(rate)}
            aria-pressed={view.playbackRate === rate}
            title={`倍速 ${rate}×（时间线与数据不受倍速影响）`}
          >
            {rate}×
          </button>
        ))}
      </div>

      <div className="lp-volume-group">
        <button
          type="button"
          className="lp-mute-button"
          onClick={() => onMutedChange(!view.muted)}
          aria-label={view.muted ? '取消静音' : '静音'}
          title={view.muted ? '取消静音' : '静音'}
        >
          <Icon name={view.muted ? 'volume-mute' : 'volume-high'} size={18} />
        </button>
        <input
          type="range"
          className="lp-volume-slider"
          min={0}
          max={100}
          step={1}
          value={view.muted ? 0 : volumePercent}
          onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
          aria-label={`音量 ${volumePercent}%`}
          title={`音量 ${volumePercent}%`}
        />
      </div>
    </div>
  );
}