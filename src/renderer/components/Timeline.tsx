/**
 * Timeline（规格 2.5 / 3.2 / 3.3 阶段 A）。
 *
 * - 时间刻度条：按视口宽度自适应密度（整秒/5 秒/30 秒/分…），
 *   刻度位置经统一几何映射 timeToX（与上方曲线绘图区严格对齐，规格 2.5）。
 * - 可拖动 seek：拖动时立即发布预览播放头 + 节流提交 video.currentTime，
 *   松手提交最终位置（规格 3.2）；播放中拖动先暂停，松手保持暂停。
 * - 时间缩放滑杆 + “适应全部”：默认全片；缩放锚点=播放头（否则视口中心）；
 *   可见区间 clamp 在 [0, durationMs]，最短 min(1000ms, durationMs)（规格 3.3）。
 * - 横向滚动条平移；Shift+滚轮平移（原生 non-passive 监听，可 preventDefault）。
 * - “回到播放头”按钮：用户手动平移后（Editor 置 follow=false）出现，
 *   点击恢复跟随（规格 3.3）。
 * - 阶段 A 不做缩略图条（阶段 D）：刻度下方为中性底色，不放假缩略图。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clamp, formatTimeMs } from '@shared/time';
import type { Boundary, ProjectView, Section, StructureNode, TimelineThumbnail } from '@shared/api-types';
import { sectionRanges } from '@shared/sections';
import {
  ancestorsOf,
  buildNumbering,
  deriveRanges,
  descendantsOf,
  formatNumber,
  levelLabel,
  LEVELS,
} from '@shared/structure';
import type { PlayheadStore } from '../editor/playhead-store';
import {
  panRange,
  timeToX,
  xToTime,
  zoomAroundAnchor,
  type PlotXGeometry,
  type TimeRange,
} from '../editor/editor-geometry';
import { buildTicks, chooseTickStepMs, nearestZoomStepIndex, zoomStepsFor } from '../editor/timeline-math';
import { visibleSpanOf } from '../editor/timeline-visible-range';
import {
  frameRequestSize,
  nearestFilmstripFrame,
  planTimelineFrames,
  validTimelineSlots,
  type FrameSlot,
} from '../editor/filmstrip-plan';
import { nearestThumbnail } from '../editor/filmstrip';
import { useVisibleFilmstrip } from '../hooks/useVisibleFilmstrip';
import type { FilmstripRequestSpec } from '../editor/filmstrip-store';
import { usePlayheadElement } from '../hooks/usePlayheadElement';
import { SCRUB_SEEK_THROTTLE_MS } from '../hooks/useMediaPlayer';
import { Icon, IconDetectRange, IconFollowPlayhead, IconLock, IconTimelineFit } from './Icons';

/** 可视跨度超过此值：直接铺基础缩略图，不启动精确抽帧（避免一次 ffmpeg 扫描数分钟视频）。 */
const LARGE_SPAN_THRESHOLD_MS = 120_000;

/** 画面轨固定高（像素），与 graphite.css 的 --timeline-filmstrip-h 同源；槽宽由它 × 画面比例推导。 */
const FILMSTRIP_HEIGHT_PX = 72;

export interface TimelineProps {
  durationMs: number;
  /** Editor 统一计算的绘图区横向几何（与画布共用，规格 2.5 对齐铁律）。 */
  geometry: PlotXGeometry;
  view: ProjectView;
  playheadStore: PlayheadStore;
  /** 视口跟随是否激活（Editor 持有；播放头越界整页后移逻辑在 Editor）。 */
  followPlayhead: boolean;
  onTimeRangeChange(range: TimeRange): void;
  /** 用户手动平移通知（Editor 停止自动跟随，规格 3.3）。 */
  onUserPan(): void;
  /** 点击“回到播放头”（Editor 恢复跟随并把视口移到播放头）。 */
  onBackToPlayhead(): void;
  onSeek(timeMs: number, opts: { final: boolean }): void;
  /** 拖动 seek 开始（Editor：播放中先暂停，规格 3.2）。 */
  onScrubStart(): void;
  /** 分段边界与段落（规格 7.2：时间线段落条显示同样分区）。 */
  boundaries?: readonly Boundary[];
  sections?: readonly Section[];
  boundariesVisible?: boolean;
  /** 时间线帧带缩略图（规格 4）。空数组时显示深色占位，不影响播放与曲线编辑。 */
  thumbnails?: readonly TimelineThumbnail[];
  /** 缩略图仍在后台生成（显示骨架提示，不阻塞）。 */
  filmstripLoading?: boolean;
  /** 视频是否已就绪（metadata 已加载）：false 时隐藏播放头，避免"竖线已动、画面未到"（规格 3）。 */
  mediaReady?: boolean;
  /** 智能镜头识别候选切点（毫秒，升序）；与正式分段用不同样式。 */
  candidateCuts?: readonly number[];
  /** 点击候选线删除该候选。 */
  onRemoveCandidate?(timeMs: number): void;
  /** 滚轮手势意图（由编辑器按自定义键位判定）：'zoom' 缩放 / 'pan' 平移 / null 不处理。 */
  resolveWheelIntent?(event: WheelEvent): 'zoom' | 'pan' | null;
  /** 三级结构轨道（章节 / 段落 / 镜头）；缺省或空数组时不渲染。 */
  structure?: readonly StructureNode[];
  selectedStructureId?: string | null;
  /** 项目 id（按需抽取高清画面帧；浏览器预览缺省时回退到预生成缩略图）。 */
  projectId?: string;
  /** 播放中 / 拖动播放头：暂停非必要的高清抽帧，优先保证播放流畅。 */
  framesPaused?: boolean;
  /** 鼠标悬停在某镜头块上（null 表示离开）；Editor 用于在监视器只显示该镜头边界。 */
  onHoverStructure?(id: string | null): void;
  /** 结构轨显隐开关（默认显示）。 */
  structureTracksVisible?: boolean;
  /** 点击结构块：选中并把播放头定位到该结构起点。 */
  onSelectStructure?(id: string, startMs: number): void;
  /**
   * 时间线高度（像素）。缺省使用 view.timelineHeight；拖动分割线时由 Editor
   * 传入实时预览值，实现“拖动中实时缩放、结束后落盘”的预览/提交分离。
   */
  height?: number;
  /** 结构块右键：请求对该结构所在区域运行智能分镜。 */
  onRecognizeShots?(id: string): void;
  /** 当前时间范围选区（Shift+拖动刻度条创建）；null 表示无选区。 */
  rangeSelection?: { startMs: number; endMs: number } | null;
  /** 时间范围选区变化（创建 / 更新 / 清除）。 */
  onSelectRange?(range: { startMs: number; endMs: number } | null): void;
}

interface DragState {
  pointerId: number;
}

interface ThumbDragState {
  pointerId: number;
  startX: number;
  startViewStartMs: number;
  trackWidth: number;
  thumbWidth: number;
}

export function Timeline(props: TimelineProps) {
  const { durationMs, geometry, view, playheadStore, followPlayhead } = props;
  const { onTimeRangeChange, onUserPan, onBackToPlayhead, onSeek, onScrubStart, onRemoveCandidate, resolveWheelIntent } = props;
  const boundaries = props.boundaries ?? [];
  const sections = props.sections ?? [];
  const boundariesVisible = props.boundariesVisible ?? true;
  const thumbnails = props.thumbnails ?? [];

  const mediaReady = props.mediaReady ?? true;
  const candidateCuts = props.candidateCuts ?? [];

  // —— 结构块右键菜单 + 时间范围选区（Shift+拖动刻度条） ——
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const rangeDragRef = useRef<{ pointerId: number; anchorMs: number } | null>(null);

  useEffect(() => {
    if (contextMenu === null) return undefined;
    const close = (): void => setContextMenu(null);
    document.addEventListener('pointerdown', close);
    document.addEventListener('wheel', close, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('wheel', close);
    };
  }, [contextMenu]);

  // —— 三级结构轨道（章节 / 段落 / 镜头，规格 4.1） ——
  const structure = props.structure ?? [];
  const selectedStructureId = props.selectedStructureId ?? null;
  const structureTracksVisible = props.structureTracksVisible ?? true;
  const structureNumbering = useMemo(() => buildNumbering(structure), [structure]);
  const structureRanges = useMemo(() => deriveRanges(structure, durationMs), [structure, durationMs]);
  // 选中链路：选中节点 + 其祖先 + 其后代，形成完整高亮链路（规格 4.1）。
  const structureChainIds = useMemo(() => {
    if (selectedStructureId === null) {
      return null;
    }
    const ids = new Set<string>([selectedStructureId]);
    for (const ancestor of ancestorsOf(structure, selectedStructureId)) {
      ids.add(ancestor.id);
    }
    for (const descendant of descendantsOf(structure, selectedStructureId)) {
      ids.add(descendant.id);
    }
    return ids;
  }, [structure, selectedStructureId]);
  const showStructureTracks = structureTracksVisible && structure.length > 0;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);

  // 高频/事件闭包使用的 ref 镜像。
  const viewRef = useRef(view);
  viewRef.current = view;
  const callbacksRef = useRef({ onTimeRangeChange, onUserPan, onSeek, onScrubStart, onRemoveCandidate });
  callbacksRef.current = { onTimeRangeChange, onUserPan, onSeek, onScrubStart, onRemoveCandidate };
  const wheelIntentRef = useRef(resolveWheelIntent);
  wheelIntentRef.current = resolveWheelIntent;

  const range: TimeRange = { viewStartMs: view.viewStartMs, viewEndMs: view.viewEndMs };
  const spanMs = Math.max(1, view.viewEndMs - view.viewStartMs);

  // 播放头竖线：订阅 store 直接操作 DOM（规格 12.3）。
  const playheadRef = usePlayheadElement(playheadStore, {
    viewStartMs: view.viewStartMs,
    viewEndMs: view.viewEndMs,
    plotLeft: geometry.plotLeft,
    plotWidth: geometry.plotWidth,
    durationMs,
  });

  // —— 刻度（密度自适应，规格 2.5）。次刻度像素间距过密时只画主刻度。 ——
  const stepMs = chooseTickStepMs(spanMs, geometry.plotWidth);
  const minorSpacingPx = (stepMs / 5 / spanMs) * geometry.plotWidth;
  const ticks = buildTicks(view.viewStartMs, view.viewEndMs, stepMs, {
    includeMinor: minorSpacingPx >= 24,
  });

  // 段落分区（规格 7.2：时间线段落条显示与画布一致的分区）。
  const sectionBands = sectionRanges(boundaries, sections);

  // 视频画面轨：按"帧宽固定、密度随缩放"规划**等间隔**帧槽，走应用级抽帧队列
  // （全局并发 2、去重、取消即终止）。画面帧只按可视窗口统一生成，**不按镜头分别生成**；
  // 镜头边界/编号/名称只作为叠加层，不决定帧的数量与宽度。
  const visibleSpanMs = view.viewEndMs - view.viewStartMs;
  const frameAspect =
    thumbnails[0] !== undefined && thumbnails[0].height > 0
      ? thumbnails[0].width / thumbnails[0].height
      : 16 / 9;
  const frameDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  const framePlan = useMemo(
    () =>
      planTimelineFrames(view.viewStartMs, view.viewEndMs, geometry.plotWidth, {
        // 槽宽由"画面轨高度 × 画面比例"推导（72px × 16:9 ≈ 128px），与抽帧请求同源。
        targetWidthPx: Math.round(FILMSTRIP_HEIGHT_PX * frameAspect),
      }),
    [view.viewStartMs, view.viewEndMs, geometry.plotWidth, frameAspect],
  );
  const slots = framePlan.frames;

  // 请求范围只取"中心时间落在视频内"的有效槽：剔除首尾预加载槽，避免请求范围被 main 侧
  // 夹取后与渲染槽整体错位一格（视频首尾少一帧/留空）。
  const validSlots = useMemo(() => validTimelineSlots(slots, durationMs), [slots, durationMs]);

  // 请求规格：覆盖有效槽的整段范围 + 槽数 + 尺寸。大跨度（> LARGE_SPAN_THRESHOLD_MS）不启动
  // 精确抽帧，直接用基础缩略图铺满，避免一次 ffmpeg 扫描数分钟视频。
  const requestSpec = useMemo<FilmstripRequestSpec | null>(() => {
    if (props.projectId === undefined || props.projectId.length === 0) {
      return null;
    }
    if (visibleSpanMs > LARGE_SPAN_THRESHOLD_MS) {
      return null;
    }
    if (validSlots.length === 0) {
      return null;
    }
    const first = validSlots[0];
    const last = validSlots[validSlots.length - 1];
    if (first === undefined || last === undefined) {
      return null;
    }
    const size = frameRequestSize(first.widthPx, frameAspect, frameDpr);
    return {
      projectId: props.projectId,
      startMs: Math.max(0, Math.round(first.startTimeMs)),
      endMs: Math.min(durationMs, Math.round(last.endTimeMs)),
      count: validSlots.length,
      width: size.width,
      height: size.height,
    };
  }, [props.projectId, validSlots, frameAspect, frameDpr, durationMs, visibleSpanMs]);

  const filmstrip = useVisibleFilmstrip(requestSpec, { paused: props.framesPaused ?? false });
  const frames = filmstrip.frames;

  // 每个槽按时间取图（不再按数组下标）：① 当前范围精确帧 → ② 最近基础缩略图 → ③ 占位。
  const pictureAt = (slot: FrameSlot): { url: string; exact: boolean } | null => {
    const exact = nearestFilmstripFrame(frames, slot.timeMs);
    if (exact !== null && exact.mediaUrl.length > 0) {
      return { url: exact.mediaUrl, exact: true };
    }
    const fallback = nearestThumbnail(thumbnails, slot.timeMs);
    if (fallback !== null) {
      return { url: fallback.mediaUrl, exact: false };
    }
    return null;
  };

  // 是否已有可辨认画面（精确帧或基础缩略图）：没有时才显示加载/失败提示，绝不留无说明空白。
  const hasPicture = useMemo(
    () =>
      slots.some(
        (slot) =>
          nearestFilmstripFrame(frames, slot.timeMs) !== null ||
          nearestThumbnail(thumbnails, slot.timeMs) !== null,
      ),
    [slots, frames, thumbnails],
  );

  // —— 拖动 seek（规格 3.2：立即预览 + 节流提交 + 松手最终提交） ——
  const scrubbingRef = useRef<DragState | null>(null);
  const lastScrubSeekAtRef = useRef(0);

  const pointerTimeMs = useCallback(
    (clientX: number): number => {
      const ruler = rulerRef.current;
      if (!ruler) {
        return 0;
      }
      const rect = ruler.getBoundingClientRect();
      const x = clamp(clientX - rect.left, 0, rect.width);
      const current = viewRef.current;
      const ms = xToTime(x, { viewStartMs: current.viewStartMs, viewEndMs: current.viewEndMs }, geometry);
      return clamp(ms, 0, durationMs);
    },
    [geometry, durationMs],
  );

  const handleRulerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) {
        return;
      }
      // Shift+拖动：创建时间范围选区（供“分析选中区域”使用），不触发 seek。
      if (e.shiftKey && props.onSelectRange !== undefined) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const anchorMs = pointerTimeMs(e.clientX);
        rangeDragRef.current = { pointerId: e.pointerId, anchorMs };
        props.onSelectRange({ startMs: anchorMs, endMs: anchorMs });
        return;
      }
      // 普通点击/拖动定位：清除既有选区。
      if (props.rangeSelection != null && props.onSelectRange !== undefined) {
        props.onSelectRange(null);
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      scrubbingRef.current = { pointerId: e.pointerId };
      lastScrubSeekAtRef.current = performance.now();
      // 播放中开始拖时间线：先暂停，松手后保持暂停（规格 3.2）。
      callbacksRef.current.onScrubStart();
      playheadStore.publish(pointerTimeMs(e.clientX));
      // 按下本身立即提交一次 seek，保证拖动起点即刻生效。
      callbacksRef.current.onSeek(pointerTimeMs(e.clientX), { final: false });
    },
    [playheadStore, pointerTimeMs, props.onSelectRange, props.rangeSelection],
  );

  const handleRulerPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const rangeDrag = rangeDragRef.current;
      if (rangeDrag !== null) {
        if (rangeDrag.pointerId !== e.pointerId) return;
        const ms = pointerTimeMs(e.clientX);
        props.onSelectRange?.({
          startMs: Math.min(rangeDrag.anchorMs, ms),
          endMs: Math.max(rangeDrag.anchorMs, ms),
        });
        return;
      }
      if (scrubbingRef.current?.pointerId !== e.pointerId) {
        return;
      }
      const ms = pointerTimeMs(e.clientX);
      // 立即更新预览播放头（规格 3.2）。
      playheadStore.publish(ms);
      // 节流提交 seek，避免每个指针事件都触发视频解码。
      const now = performance.now();
      if (now - lastScrubSeekAtRef.current >= SCRUB_SEEK_THROTTLE_MS) {
        lastScrubSeekAtRef.current = now;
        callbacksRef.current.onSeek(ms, { final: false });
      }
    },
    [playheadStore, pointerTimeMs, props.onSelectRange],
  );

  const handleRulerPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const rangeDrag = rangeDragRef.current;
      if (rangeDrag !== null) {
        if (rangeDrag.pointerId !== e.pointerId) return;
        rangeDragRef.current = null;
        const ms = pointerTimeMs(e.clientX);
        const startMs = Math.min(rangeDrag.anchorMs, ms);
        const endMs = Math.max(rangeDrag.anchorMs, ms);
        // 拖动距离过短视为清除选区。
        props.onSelectRange?.(endMs - startMs < 30 ? null : { startMs, endMs });
        return;
      }
      if (scrubbingRef.current?.pointerId !== e.pointerId) {
        return;
      }
      scrubbingRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      // 松手提交最终位置（规格 3.2）。
      callbacksRef.current.onSeek(pointerTimeMs(e.clientX), { final: true });
    },
    [pointerTimeMs, props.onSelectRange],
  );

  const handleRulerPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (rangeDragRef.current?.pointerId === e.pointerId) {
      rangeDragRef.current = null;
      return;
    }
    if (scrubbingRef.current?.pointerId !== e.pointerId) {
      return;
    }
    scrubbingRef.current = null;
  }, []);

  // —— 滚轮手势（可自定义键位）：缩放以指针位置为锚点；平移左右移动（规格 3.3 / 6.2）。
  //    React 合成 wheel 是 passive，必须原生监听才能 preventDefault（并阻止页面缩放）。 ——
  useEffect(() => {
    const el = hostRef.current;
    if (!el) {
      return undefined;
    }
    const onWheel = (e: WheelEvent) => {
      const intent = wheelIntentRef.current?.(e) ?? null;
      if (intent === null) {
        return;
      }
      e.preventDefault();
      const current = viewRef.current;
      const currentSpan = Math.max(1, current.viewEndMs - current.viewStartMs);
      if (intent === 'pan') {
        const deltaPx = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        const msPerPx = currentSpan / geometry.plotWidth;
        callbacksRef.current.onUserPan();
        callbacksRef.current.onTimeRangeChange(
          panRange(
            { viewStartMs: current.viewStartMs, viewEndMs: current.viewEndMs },
            deltaPx * msPerPx,
            durationMs,
          ),
        );
        return;
      }
      const rect = el.getBoundingClientRect();
      const range: TimeRange = { viewStartMs: current.viewStartMs, viewEndMs: current.viewEndMs };
      const anchorMs = clamp(xToTime(e.clientX - rect.left, range, geometry), 0, durationMs);
      const ratio = clamp((anchorMs - current.viewStartMs) / currentSpan, 0, 1);
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const nextSpan = clamp(currentSpan * factor, Math.min(200, durationMs), durationMs);
      if (Math.round(nextSpan) === Math.round(currentSpan)) {
        return;
      }
      callbacksRef.current.onUserPan();
      callbacksRef.current.onTimeRangeChange(zoomAroundAnchor(anchorMs, nextSpan, ratio, durationMs));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [geometry.plotWidth, geometry.plotLeft, durationMs]);

  // —— 缩放档位（§6.3：离散档位替代敏感的连续对数滑杆；锚点=播放头优先，否则视口中心） ——
  const zoomSteps = useMemo(() => zoomStepsFor(durationMs), [durationMs]);
  const zoomStepIndex = nearestZoomStepIndex(spanMs, durationMs);

  const handleZoomStepChange = useCallback(
    (index: number) => {
      const step = zoomSteps[index];
      if (step === undefined) {
        return;
      }
      const current = viewRef.current;
      const currentSpan = Math.max(1, current.viewEndMs - current.viewStartMs);
      const playheadMs = playheadStore.get();
      const inRange = playheadMs >= current.viewStartMs && playheadMs <= current.viewEndMs;
      const anchorMs = inRange ? playheadMs : (current.viewStartMs + current.viewEndMs) / 2;
      const anchorRatio = (anchorMs - current.viewStartMs) / currentSpan;
      callbacksRef.current.onTimeRangeChange(
        zoomAroundAnchor(anchorMs, step.spanMs, anchorRatio, durationMs),
      );
    },
    [durationMs, playheadStore, zoomSteps],
  );

  const handleFitAll = useCallback(() => {
    callbacksRef.current.onTimeRangeChange({ viewStartMs: 0, viewEndMs: durationMs });
  }, [durationMs]);

  // —— 横向滚动条（真实平移控件；全片视图时禁用） ——
  const thumbDragRef = useRef<ThumbDragState | null>(null);
  const scrollable = durationMs > spanMs;
  const thumbWidthPct = scrollable ? (spanMs / durationMs) * 100 : 100;
  const thumbLeftPct = scrollable
    ? (view.viewStartMs / Math.max(1, durationMs - spanMs)) * (100 - thumbWidthPct)
    : 0;

  const handleThumbPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!scrollable || e.button !== 0) {
        return;
      }
      e.stopPropagation(); // 不触发轨道点击。
      const track = trackRef.current;
      const thumb = thumbRef.current;
      if (!track || !thumb) {
        return;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      thumbDragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startViewStartMs: viewRef.current.viewStartMs,
        trackWidth: track.clientWidth,
        thumbWidth: thumb.offsetWidth,
      };
    },
    [scrollable],
  );

  const handleThumbPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = thumbDragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) {
        return;
      }
      const current = viewRef.current;
      const currentSpan = Math.max(1, current.viewEndMs - current.viewStartMs);
      const movable = Math.max(1, drag.trackWidth - drag.thumbWidth);
      const ratio = clamp((e.clientX - drag.startX) / movable, -1, 1);
      const deltaMs = ratio * Math.max(0, durationMs - currentSpan);
      callbacksRef.current.onUserPan();
      callbacksRef.current.onTimeRangeChange(
        panRange(
          { viewStartMs: drag.startViewStartMs, viewEndMs: drag.startViewStartMs + currentSpan },
          deltaMs,
          durationMs,
        ),
      );
    },
    [durationMs],
  );

  const handleThumbPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (thumbDragRef.current?.pointerId !== e.pointerId) {
      return;
    }
    thumbDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const handleTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!scrollable || e.button !== 0) {
        return;
      }
      const track = trackRef.current;
      const thumb = thumbRef.current;
      if (!track || !thumb) {
        return;
      }
      const rect = track.getBoundingClientRect();
      const movable = Math.max(1, track.clientWidth - thumb.offsetWidth);
      const clickRatio = clamp((e.clientX - rect.left - thumb.offsetWidth / 2) / movable, 0, 1);
      const current = viewRef.current;
      const currentSpan = Math.max(1, current.viewEndMs - current.viewStartMs);
      const targetStart = clickRatio * Math.max(0, durationMs - currentSpan);
      callbacksRef.current.onUserPan();
      callbacksRef.current.onTimeRangeChange(
        panRange({ viewStartMs: targetStart, viewEndMs: targetStart + currentSpan }, 0, durationMs),
      );
    },
    [durationMs, scrollable],
  );


  return (
    <div
      className={`lp-timeline${mediaReady ? '' : ' is-media-loading'}`}
      ref={hostRef}
      style={{ height: `${props.height ?? view.timelineHeight}px` }}
    >
      {/* 刻度条 + 播放头：有效起止 X 与上方曲线绘图区严格对齐（规格 2.5）。 */}
      <div
        className={`lp-timeline-ruler${showStructureTracks ? ' has-structure-tracks' : ''}`}
        ref={rulerRef}
        onPointerDown={handleRulerPointerDown}
        onPointerMove={handleRulerPointerMove}
        onPointerUp={handleRulerPointerUp}
        onPointerCancel={handleRulerPointerCancel}
        tabIndex={0}
        aria-label="时间线（拖动定位；键盘 ← / → 逐帧，Shift 加方向键跳 5 帧）"
      >
        {/* 视频画面轨：**始终显示**（不因存在章节/段落/镜头而隐藏）。
            帧槽按可视窗口统一生成（等宽、object-fit: cover 裁切、不拉伸）；未生成时显示深色占位块。 */}
        <div className="lp-video-track" aria-hidden="true">
          {slots.map((slot) => {
            const left = timeToX(slot.startTimeMs, range, geometry);
            const right = timeToX(slot.endTimeMs, range, geometry);
            const picture = pictureAt(slot);
            return (
              <div
                key={`vs-${Math.round(slot.startTimeMs)}`}
                className="lp-video-slot"
                style={{ left: `${left}px`, width: `${Math.max(0, right - left)}px` }}
              >
                {picture !== null ? (
                  <img
                    className={`lp-video-img${picture.exact ? '' : ' is-fallback'}`}
                    src={picture.url}
                    alt=""
                    loading="eager"
                    decoding="async"
                    draggable={false}
                  />
                ) : (
                  <span className="lp-video-placeholder" />
                )}
              </div>
            );
          })}
        </div>

        {/* 画面轨状态提示（位于 aria-hidden 的画面轨之外，可被读屏与探针读取）：
            无任何可辨认画面时显示加载提示；抽帧失败显示可点击重试，绝不留下无说明空白。 */}
        {!hasPicture && filmstrip.status !== 'error' && (
          <div className="lp-filmstrip-notice" role="status">
            正在加载当前范围画面…
          </div>
        )}
        {filmstrip.status === 'error' && (
          <div className="lp-filmstrip-notice is-error" role="alert">
            画面加载失败
            <button type="button" className="lp-filmstrip-retry" onClick={filmstrip.retry}>
              重试
            </button>
          </div>
        )}

        {/* 镜头叠加层：边界竖线 + 编号 + 名称（可选中/悬停/右键），不决定帧的数量与宽度。
            视觉区域用与视口的交集，跨视口时名称仍可见并标记延续。 */}
        {structure
          .filter((n) => n.level === 'shot')
          .map((node) => {
            const nodeRange = structureRanges.get(node.id);
            if (nodeRange === undefined) {
              return null;
            }
            const span = visibleSpanOf(nodeRange, view.viewStartMs, view.viewEndMs);
            if (span.empty) {
              return null;
            }
            const sx = timeToX(span.startMs, range, geometry);
            const ex = timeToX(span.endMs, range, geometry);
            const width = Math.max(1, ex - sx);
            const isSelected = node.id === selectedStructureId;
            const inChain = structureChainIds?.has(node.id) ?? false;
            const number = structureNumbering.get(node.id);
            const nameLabel = `${span.clippedStart ? '◀ ' : ''}${node.name || '（未命名）'}${span.clippedEnd ? ' ▶' : ''}`;
            return (
              <button
                key={`ov-${node.id}`}
                type="button"
                className={`lp-shot-overlay-block${isSelected ? ' is-selected' : ''}${inChain ? ' is-in-chain' : ''}${node.locked ? ' is-locked' : ''}${span.clippedStart ? ' is-clipped-start' : ''}${span.clippedEnd ? ' is-clipped-end' : ''}`}
                style={{ left: `${sx}px`, width: `${width}px` }}
                title={`镜头 · ${node.name || '（未命名）'} · ${formatTimeMs(nodeRange.startMs)} — ${formatTimeMs(nodeRange.endMs)}`}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerEnter={() => props.onHoverStructure?.(node.id)}
                onPointerLeave={() => props.onHoverStructure?.(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onSelectStructure?.(node.id, nodeRange.startMs);
                }}
                onContextMenu={(e) => {
                  if (props.onRecognizeShots === undefined) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY, id: node.id });
                }}
              >
                {number !== undefined && width >= 44 && (
                  <span className="lp-shot-overlay-no">{formatNumber(number)}</span>
                )}
                {width >= 96 && <span className="lp-shot-overlay-name">{nameLabel}</span>}
                {node.locked && <IconLock className="lp-shot-overlay-lock" />}
              </button>
            );
          })}

        {/* 结构轨：章节 / 段落（视觉区域用与视口的交集，跨视口时标题仍可见并标记延续）。 */}
        {showStructureTracks && (
          <div className="lp-structure-tracks">
            {LEVELS.filter((level) => level !== 'shot').map((level) => {
              const nodes = structure
                .filter((n) => n.level === level)
                .sort((a, b) => a.startMs - b.startMs);
              return (
                <div key={level} className={`lp-structure-track is-${level}`}>
                  {nodes.map((node) => {
                    const nodeRange = structureRanges.get(node.id);
                    if (!nodeRange) {
                      return null;
                    }
                    const span = visibleSpanOf(nodeRange, view.viewStartMs, view.viewEndMs);
                    // 虚拟化：与视口无交集的块不进入 DOM（数百结构仍可流畅缩放）。
                    if (span.empty) {
                      return null;
                    }
                    const sx = timeToX(span.startMs, range, geometry);
                    const ex = timeToX(span.endMs, range, geometry);
                    const width = Math.max(1, ex - sx);
                    const isSelected = node.id === selectedStructureId;
                    const inChain = structureChainIds?.has(node.id) ?? false;
                    const number = structureNumbering.get(node.id);
                    const durationLabel = formatTimeMs(nodeRange.endMs - nodeRange.startMs);
                    const metaLabel = span.clippedStart
                      ? `从 ${formatTimeMs(nodeRange.startMs)} 延续`
                      : span.clippedEnd
                        ? `延续至 ${formatTimeMs(nodeRange.endMs)}`
                        : `${formatTimeMs(nodeRange.startMs)} — ${formatTimeMs(nodeRange.endMs)} · ${durationLabel}`;
                    const nameLabel = `${span.clippedStart ? '◀ ' : ''}${node.name || '（未命名）'}${span.clippedEnd ? ' ▶' : ''}`;
                    return (
                      <button
                        key={node.id}
                        type="button"
                        className={`lp-structure-block is-${level}${isSelected ? ' is-selected' : ''}${inChain ? ' is-in-chain' : ''}${node.locked ? ' is-locked' : ''}${span.clippedStart ? ' is-clipped-start' : ''}${span.clippedEnd ? ' is-clipped-end' : ''}`}
                        style={{ left: `${sx}px`, width: `${width}px` }}
                        title={`${levelLabel(level)} · ${node.name || '（未命名）'} · ${formatTimeMs(nodeRange.startMs)} — ${formatTimeMs(nodeRange.endMs)}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onSelectStructure?.(node.id, nodeRange.startMs);
                        }}
                        onContextMenu={(e) => {
                          if (props.onRecognizeShots === undefined) return;
                          e.preventDefault();
                          e.stopPropagation();
                          setContextMenu({ x: e.clientX, y: e.clientY, id: node.id });
                        }}
                      >
                        {number !== undefined && (
                          <span className="lp-structure-block-no">{formatNumber(number)}</span>
                        )}
                        <span className="lp-structure-block-copy">
                          <span className="lp-structure-block-name">{nameLabel}</span>
                          <span className="lp-structure-block-meta">{metaLabel}</span>
                        </span>
                        {node.locked && <IconLock className="lp-structure-block-lock" />}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        {/* 段落条：分区色带 + 段名 + 边界竖线（与画布同一 timeToX 映射）。 */}
        {boundariesVisible &&
          !showStructureTracks &&
          sectionBands.map((band) => {
            const sx = timeToX(band.startMs, range, geometry);
            const ex = timeToX(band.endMs, range, geometry);
            const name = band.section.name;
            return (
              <div
                key={`band-${band.section.id}`}
                className="lp-timeline-band"
                style={{ left: `${sx}px`, width: `${Math.max(0, ex - sx)}px` }}
                title={name}
                aria-hidden="true"
              >
                <span className="lp-timeline-band-name">{name}</span>
              </div>
            );
          })}
        {boundariesVisible &&
          !showStructureTracks &&
          boundaries.map((boundary) => (
            <div
              key={`tlb-${boundary.id}`}
              className={`lp-timeline-boundary${boundary.fixed ? ' is-edge' : ''}${boundary.locked ? ' is-locked' : ''}`}
              style={{ left: `${timeToX(boundary.timeMs, range, geometry)}px` }}
              aria-hidden="true"
            />
          ))}

        {/* 智能镜头识别候选分割线（与正式分段样式不同，可点击删除） */}
        {candidateCuts.map((timeMs) => (
          <button
            key={`tlcut-${timeMs}`}
            type="button"
            className="lp-timeline-candidate"
            style={{ left: `${timeToX(timeMs, range, geometry)}px` }}
            title={`候选镜头切点 ${formatTimeMs(timeMs)}（点击删除）`}
            aria-label={`删除候选切点 ${formatTimeMs(timeMs)}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              callbacksRef.current.onRemoveCandidate?.(timeMs);
            }}
          >
            <span className="lp-timeline-candidate-dot" aria-hidden="true" />
          </button>
        ))}

        {ticks.map((tick) => {
          const x = timeToX(tick.timeMs, range, geometry);
          return (
            <div
              key={tick.timeMs}
              className={tick.major ? 'lp-tick lp-tick-major' : 'lp-tick lp-tick-minor'}
              style={{ left: `${x}px` }}
              aria-hidden="true"
            />
          );
        })}

        {ticks
          .filter((tick) => tick.major)
          .map((tick) => (
            <div
              key={`label-${tick.timeMs}`}
              className="lp-tick-label"
              style={{ left: `${timeToX(tick.timeMs, range, geometry)}px` }}
              aria-hidden="true"
            >
              {formatTimeMs(tick.timeMs)}
            </div>
          ))}

        {/* 时间范围选区（Shift+拖动刻度条）：供“分析选中区域”使用。 */}
        {props.rangeSelection != null && (
          (() => {
            const rs = props.rangeSelection!;
            const sx = timeToX(rs.startMs, range, geometry);
            const ex = timeToX(rs.endMs, range, geometry);
            return (
              <div
                className="lp-timeline-range"
                style={{ left: `${sx}px`, width: `${Math.max(0, ex - sx)}px` }}
                aria-hidden="true"
              />
            );
          })()
        )}

        {/* 播放头（subscribe → DOM transform，不进 React 渲染）。 */}
        <div ref={playheadRef} className="lp-playhead-line" aria-hidden="true">
          <span className="lp-playhead-cap" />
        </div>
      </div>

      <div className="lp-timeline-bottom">
        <div className="lp-timeline-tools">
          <label className="lp-zoom-label">
            时间缩放
            <input
              type="range"
              className="lp-zoom-slider"
              min={0}
              max={Math.max(0, zoomSteps.length - 1)}
              step={1}
              value={zoomStepIndex}
              onChange={(e) => handleZoomStepChange(Number(e.target.value))}
              aria-label="时间缩放"
              title={`可见区间 ${formatTimeMs(view.viewStartMs, { hours: 'always' })} — ${formatTimeMs(view.viewEndMs, { hours: 'always' })}`}
            />
          </label>
          <span className="lp-zoom-span">
            当前范围 {formatTimeMs(spanMs, { hours: 'always' })}
          </span>
          <button type="button" className="lp-tool-button" onClick={handleFitAll} data-tip="适应全部" aria-label="适应全部">
            <IconTimelineFit />
          </button>
          {!followPlayhead && (
            <div className="lp-follow-hint" role="status">
              <span className="lp-follow-hint-text">
                播放头在 {formatTimeMs(view.playheadMs, { hours: 'always' })}，当前浏览{' '}
                {formatTimeMs(view.viewStartMs, { hours: 'always' })}—{formatTimeMs(view.viewEndMs, { hours: 'always' })}
              </span>
              <button
                type="button"
                className="lp-tool-button lp-follow-button"
                onClick={onBackToPlayhead}
                data-tip="回到播放头"
              >
                <IconFollowPlayhead />
                回到播放头
              </button>
            </div>
          )}
          <div className="lp-timeline-legend">
            <span className="lp-legend-item" data-tip="范围选择：Shift + 拖动刻度条">
              <Icon name="range-select" size={14} />
            </span>
            <span className="lp-legend-item" data-tip="切点 / 分界：结构块之间的边界">
              <Icon name="split" size={14} />
            </span>
            <span className="lp-legend-item" data-tip="锁定结构：不可改变时间与父级">
              <Icon name="lock" size={14} />
            </span>
          </div>
        </div>
        <div
          className={scrollable ? 'lp-scrollbar' : 'lp-scrollbar is-disabled'}
          ref={trackRef}
          onPointerDown={handleTrackPointerDown}
          role="scrollbar"
          aria-label="时间线横向滚动条"
          aria-orientation="horizontal"
        >
          <div
            className="lp-scrollbar-thumb"
            ref={thumbRef}
            style={{ width: `${thumbWidthPct}%`, left: `${thumbLeftPct}%` }}
            onPointerDown={handleThumbPointerDown}
            onPointerMove={handleThumbPointerMove}
            onPointerUp={handleThumbPointerUp}
          />
        </div>
      </div>
      {contextMenu !== null && (
        <div
          className="lp-timeline-context"
          role="menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="lp-menu-button"
            onClick={() => {
              const id = contextMenu.id;
              setContextMenu(null);
              props.onRecognizeShots?.(id);
            }}
          >
            <IconDetectRange />
            <span>识别此区域镜头</span>
          </button>
        </div>
      )}
    </div>
  );
}
