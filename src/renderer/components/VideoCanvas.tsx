/**
 * VideoCanvas（规格 2.5 / 3.1 / 3.2 / 4）。
 *
 * - video 元素 object-fit: contain 居中；竖屏保留两侧深色背景。
 * - 叠加 SVG 网格层（0—100 轻网格 +「低—高」标注）与 children（曲线层）。
 * - 几何由 Editor 统一下发：横向 plotX（与时间线共用，规格 2.5 左右对齐铁律）
 *   与纵向 plotY（由 Editor 测量画布高度计算）；本组件不再自行测量。
 * - 图层透明度（规格 4）：视频透明度作用于 video，分析层透明度作用于分析
 *   SVG；二者独立。隐藏视频用 visibility: hidden（保留媒体元素，规格 3.2）。
 * - 播放头属于临时手柄层，固定最后渲染、不受分析层透明度影响。
 */
import type { ReactNode, RefObject } from 'react';
import { useEffect } from 'react';
import type { ProjectView } from '@shared/api-types';
import type { PlayheadStore } from '../editor/playhead-store';
import { valueToY, type PlotXGeometry, type PlotYGeometry } from '../editor/editor-geometry';
import { usePlayheadElement } from '../hooks/usePlayheadElement';

export interface VideoCanvasProps {
  mediaSrc: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Editor 统一计算的画布宿主 ref（用于测量纵向几何）。 */
  hostRef: RefObject<HTMLDivElement | null>;
  /** Editor 统一下发的绘图区横向几何（与时间线共用，规格 2.5）。 */
  geometry: PlotXGeometry;
  /** Editor 统一下发的绘图区纵向几何。 */
  plotY: PlotYGeometry;
  view: ProjectView;
  playheadStore: PlayheadStore;
  durationMs: number;
  /** useMediaPlayer 上报的媒体错误（规格 15：播放运行时失败）。 */
  mediaError: string | null;
  /** 视频已就绪（metadata 加载完成）：false 时显示加载骨架，避免曲线先于视频出现（规格 3）。 */
  mediaReady?: boolean;
  /** 素材缺失（无播放源）：显示明确说明，但不阻塞分析与编辑（规格 9.3 / 13）。 */
  mediaMissing?: boolean;
  /** 曲线层（与网格同一坐标系，渲染在网格之上、播放头之下）。 */
  children?: ReactNode;
  /** 网格显示（分析监视器样式 grid.visible）。 */
  gridVisible?: boolean;
  /** 网格主线透明度（分析监视器样式 grid.opacity）。 */
  gridOpacity?: number;
}

/** 纵轴轻网格线对应的值（0—100，规格 3.1）。 */
const GRID_VALUES = [0, 25, 50, 75, 100] as const;

export function VideoCanvas(props: VideoCanvasProps) {
  const {
    mediaSrc,
    videoRef,
    hostRef,
    geometry,
    plotY,
    view,
    playheadStore,
    durationMs,
    mediaError,
    mediaReady = true,
    mediaMissing = false,
    children,
    gridVisible = true,
    gridOpacity = 0.08,
  } = props;

  // playbackRate/volume/muted 写 video 元素真实属性（规格 3.2）。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.playbackRate = view.playbackRate;
    video.volume = view.volume;
    video.muted = view.muted;
  }, [videoRef, view.playbackRate, view.volume, view.muted]);

  const svgWidth = geometry.plotLeft * 2 + geometry.plotWidth;
  const svgHeight = plotY.plotTop * 2 + plotY.plotHeight;

  // 播放头竖线：订阅 store 直接操作 DOM（规格 12.3）。
  const playheadRef = usePlayheadElement(playheadStore, {
    viewStartMs: view.viewStartMs,
    viewEndMs: view.viewEndMs,
    plotLeft: geometry.plotLeft,
    plotWidth: geometry.plotWidth,
    durationMs,
  });

  const analysisVisibleStyle = view.analysisVisible ? 'visible' : 'hidden';

  return (
    <div className="lp-canvas-host" ref={hostRef}>
      {/* 隐藏视频保留媒体元素与 src（规格 3.2）；音频不受可见性影响。 */}
      <video
        ref={videoRef}
        className="lp-canvas-video"
        src={mediaSrc}
        preload="auto"
        playsInline
        style={{
          opacity: view.videoOpacity,
          visibility: view.videoVisible ? 'visible' : 'hidden',
        }}
      />

      {/* 分析层：纵轴轻网格 +「低—高」标注（规格 3.1：纵轴只是编辑坐标）。 */}
      <svg
        className="lp-canvas-analysis"
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        style={{ opacity: view.analysisOpacity, visibility: analysisVisibleStyle }}
        aria-hidden="true"
      >
        {gridVisible &&
          GRID_VALUES.map((value) => {
            const y = valueToY(value, plotY);
            return (
              <line
                key={value}
                className="lp-grid-line"
                x1={geometry.plotLeft}
                x2={geometry.plotLeft + geometry.plotWidth}
                y1={y}
                y2={y}
                style={{ opacity: gridOpacity }}
              />
            );
          })}
        <text
          className="lp-axis-label"
          x={geometry.plotLeft - 4}
          y={valueToY(100, plotY)}
          dy="-2"
          textAnchor="end"
        >
          高
        </text>
        <text
          className="lp-axis-label"
          x={geometry.plotLeft - 4}
          y={valueToY(0, plotY)}
          dy="10"
          textAnchor="end"
        >
          低
        </text>
      </svg>

      {/* 曲线层（红色曲线/节点/控制柄）：与网格共用同一 plotX/plotY 坐标系。 */}
      {children}

      {mediaError && (
        <div className="lp-canvas-error" role="alert">
          {mediaError}——请检查素材编码（规格 10.1 基线）后重试。
        </div>
      )}

      {/* 加载中 / 素材缺失：以明确文案替代黑屏（规格 3 / 13）。
          加载骨架覆盖曲线与视频，避免"曲线已显示、视频还没绑定"。 */}
      {mediaMissing ? (
        <div className="lp-canvas-status lp-canvas-missing" role="alert">
          <p className="lp-canvas-status-title">素材缺失</p>
          <p>找不到原视频副本，暂时无法播放；分析内容仍可查看与编辑。</p>
          <p className="lp-canvas-status-hint">
            可从项目库对「素材丢失」的项目执行「重新定位素材」找回。
          </p>
        </div>
      ) : !mediaReady ? (
        <div className="lp-canvas-status lp-canvas-loading" role="status">
          <div className="lp-canvas-status-spinner" aria-hidden="true" />
          <p className="lp-canvas-status-title">正在准备视频…</p>
          <p className="lp-canvas-status-hint">画面、曲线与时间线将在视频就绪后一起出现。</p>
        </div>
      ) : null}

      {/* 播放头属于“临时编辑手柄与播放头”层（规格 4），不受分析层透明度影响。 */}
      <div ref={playheadRef} className="lp-playhead-cursor" aria-hidden="true" />
    </div>
  );
}