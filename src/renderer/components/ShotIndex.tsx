/**
 * ShotIndex（方案 §2 镜头索引栏 / §7 镜头画面轨）。
 *
 * 左侧可收起的镜头索引：把三级结构中的「镜头」按其时间顺序列出，每一行
 * 显示代表画面缩图 + 镜头编号 + 起始时间码。点击即选中该镜头并定位播放头，
 * 与时间线、曲线共用同一套选中状态（方案 §3：同一个时间贯穿所有内容）。
 *
 * 用途：太短的镜头在时间线上难以点选（方案 §7），索引栏以固定行高保证每个
 * 镜头都易点、易找回。收起后仅保留一条展开把手，把空间交还给视频与曲线。
 */
import { useMemo } from 'react';
import type { StructureNode, TimelineThumbnail } from '@shared/api-types';
import { formatTimeMs } from '@shared/time';
import { buildNumbering, deriveRanges, formatNumber } from '@shared/structure';
import { nearestThumbnail } from '../editor/filmstrip';
import { IconChevronLeft, IconChevronRight } from './Icons';

export interface ShotIndexProps {
  structure: readonly StructureNode[];
  durationMs: number;
  thumbnails: readonly TimelineThumbnail[];
  /** 当前选中的结构 id（可为章节/段落/镜头；只有镜头行会高亮）。 */
  selectedId: string | null;
  collapsed: boolean;
  onToggleCollapse(): void;
  onSelectShot(id: string, startMs: number): void;
}

export function ShotIndex(props: ShotIndexProps) {
  const { structure, durationMs, thumbnails, selectedId, collapsed } = props;
  const { onToggleCollapse, onSelectShot } = props;

  const shots = useMemo(() => {
    const ranges = deriveRanges(structure, durationMs);
    const numbering = buildNumbering(structure);
    return structure
      .filter((node) => node.level === 'shot')
      .slice()
      .sort((a, b) => a.startMs - b.startMs)
      .map((node) => ({
        node,
        no: formatNumber(numbering.get(node.id) ?? []),
        startMs: node.startMs,
        endMs: ranges.get(node.id)?.endMs ?? durationMs,
      }));
  }, [structure, durationMs]);

  if (collapsed) {
    return (
      <aside className="lp-rail is-collapsed" aria-label="镜头索引">
        <button
          type="button"
          className="lp-rail-handle"
          onClick={onToggleCollapse}
          aria-label={`展开镜头索引（${shots.length} 个镜头）`}
          title="展开镜头索引"
        >
          <IconChevronRight className="lp-rail-handle-glyph" width={14} height={14} />
          <span className="lp-rail-handle-count">{shots.length}</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="lp-rail" aria-label="镜头索引">
      <div className="lp-rail-head">
        <span className="lp-rail-title">镜头索引</span>
        <span className="lp-rail-count">{shots.length}</span>
        <button
          type="button"
          className="lp-rail-handle"
          onClick={onToggleCollapse}
          aria-label="收起镜头索引"
          data-tip="收起镜头索引"
        >
          <IconChevronLeft className="lp-rail-handle-glyph" width={14} height={14} />
        </button>
      </div>
      <div className="lp-rail-list">
        {shots.length === 0 ? (
          <p className="lp-rail-empty">尚无镜头。可在下方节奏谱工具条运行智能分镜。</p>
        ) : (
          shots.map((shot) => {
            const thumb = nearestThumbnail(thumbnails, shot.startMs);
            const active = shot.node.id === selectedId;
            return (
              <button
                key={shot.node.id}
                type="button"
                className={`lp-rail-item${active ? ' is-active' : ''}`}
                aria-pressed={active}
                onClick={() => onSelectShot(shot.node.id, shot.startMs)}
                title={`${shot.no} ${shot.node.name} · ${formatTimeMs(shot.startMs)}`}
              >
                <span className="lp-rail-thumb">
                  {thumb !== null && (
                    <img src={thumb.mediaUrl} alt="" loading="eager" decoding="async" draggable={false} />
                  )}
                </span>
                <span className="lp-rail-meta">
                  <span className="lp-rail-no">{shot.no}</span>
                  <span className="lp-rail-time">{formatTimeMs(shot.startMs)}</span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}