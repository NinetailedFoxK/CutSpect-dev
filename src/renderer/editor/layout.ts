/**
 * 分析监视器 / 时间线分割线的高度限制与拖动状态机（纯逻辑，集中管理）。
 *
 * 需求：分析监视器与底部时间线之间可拖动分割线调整高度。
 * - 高度限制只在此处定义，禁止散落各组件硬编码；
 * - 拖动换算、键盘微调、默认值恢复均为纯函数，供组件与测试共用；
 * - 拖动状态机（begin/move/end/cancel/blur/escape）为纯 reducer，
 *   组件只负责 Pointer / 键盘事件接线，行为可脱离 DOM 测试。
 */

/** 分析监视器（画面 + 曲线编辑区）最小高度：保证可观片、可编辑曲线。 */
export const MIN_ANALYSIS_HEIGHT = 240;
/** 时间线最小高度：保留播放控制、结构轨、帧带与滚动区域。 */
export const MIN_TIMELINE_HEIGHT = 260;
/** 三层结构 + 帧带在默认状态下均可直接编辑的工作高度。 */
export const DEFAULT_TIMELINE_HEIGHT = 350;
/** 时间线最大占可用工作区的比例（不超过 62%，避免“时间线吃掉整屏”）。 */
export const MAX_TIMELINE_RATIO = 0.68;
/** 绝对上限：无可用工作区信息（首帧未测量）时的兜底夹紧。 */
export const ABSOLUTE_MAX_TIMELINE_HEIGHT = 900;
/** 分割线可点击区域高度（视觉仍为 1px 细线，落在正中）。 */
export const SPLITTER_THICKNESS = 10;
/** 键盘微调步长：方向键 / Shift+方向键。 */
export const SPLITTER_KEY_STEP = 10;
export const SPLITTER_KEY_STEP_LARGE = 40;

export interface TimelineLimits {
  min: number;
  max: number;
}

export interface TimelineLimitOptions {
  minAnalysisHeight?: number;
  minTimelineHeight?: number;
  maxRatio?: number;
  /** 分割线自身占据的垂直空间（不含在分析区与时间线任一侧）。 */
  splitterHeight?: number;
  absoluteMax?: number;
}

/**
 * 根据可用工作区（.lp-center 的内容高度）计算时间线合理区间。
 * - 上方约束：分析区不得小于 MIN_ANALYSIS_HEIGHT；
 * - 比例约束：时间线不得超过工作区的 MAX_TIMELINE_RATIO；
 * - 下限与上限冲突时（窗口极矮）以保证 min ≤ max 优先。
 * totalHeight ≤ 0（首帧未测量）时回退到宽松区间，由调用方随后夹紧。
 */
export function resolveTimelineLimits(
  totalHeight: number,
  options: TimelineLimitOptions = {},
): TimelineLimits {
  const minAnalysis = options.minAnalysisHeight ?? MIN_ANALYSIS_HEIGHT;
  const minTimeline = options.minTimelineHeight ?? MIN_TIMELINE_HEIGHT;
  const maxRatio = options.maxRatio ?? MAX_TIMELINE_RATIO;
  const splitter = options.splitterHeight ?? SPLITTER_THICKNESS;
  const absoluteMax = options.absoluteMax ?? ABSOLUTE_MAX_TIMELINE_HEIGHT;

  if (!(totalHeight > 0)) {
    return { min: minTimeline, max: absoluteMax };
  }
  const maxByAnalysis = totalHeight - splitter - minAnalysis;
  const maxByRatio = Math.floor(totalHeight * maxRatio);
  const max = Math.max(0, Math.min(maxByAnalysis, maxByRatio, absoluteMax));
  const min = Math.min(minTimeline, max);
  return { min, max };
}

/** 把任意高度夹紧到合法区间；非有限数回退到下限。 */
export function clampTimelineHeight(value: number, limits: TimelineLimits): number {
  if (!Number.isFinite(value)) {
    return limits.min;
  }
  return Math.round(Math.min(limits.max, Math.max(limits.min, value)));
}

/**
 * 拖动换算：向上拖动（deltaY < 0）扩大时间线，向下拖动缩小。
 * 时间线顶部即分割线位置，故高度 = 起始高度 - 指针纵向位移。
 */
export function heightFromDrag(startHeight: number, deltaY: number, limits: TimelineLimits): number {
  return clampTimelineHeight(startHeight - deltaY, limits);
}

/** 键盘微调：'up' 扩大时间线，'down' 缩小。 */
export function nudgeTimelineHeight(
  current: number,
  direction: 'up' | 'down',
  step: number,
  limits: TimelineLimits,
): number {
  const delta = direction === 'up' ? Math.abs(step) : -Math.abs(step);
  return clampTimelineHeight(current + delta, limits);
}

/** 默认高度（双击恢复）：夹紧到当前合法区间。 */
export function defaultTimelineHeight(limits: TimelineLimits): number {
  return clampTimelineHeight(DEFAULT_TIMELINE_HEIGHT, limits);
}

/* ------------------------------------------------------------------ */
/* 拖动状态机                                                            */
/* ------------------------------------------------------------------ */

export interface SplitterState {
  dragging: boolean;
  pointerId: number | null;
  /** 拖动起始指针纵向坐标（clientY）。 */
  startY: number;
  /** 拖动起始时间线高度（已提交值）。 */
  startHeight: number;
  /** 拖动中的预览高度（未提交）；null 表示无预览。 */
  preview: number | null;
}

export type SplitterAction =
  | { type: 'sync'; height: number }
  | { type: 'begin'; pointerId: number; y: number }
  | { type: 'move'; y: number; limits: TimelineLimits }
  | { type: 'end' }
  | { type: 'cancel' };

export function splitterIdle(height: number): SplitterState {
  return { dragging: false, pointerId: null, startY: 0, startHeight: height, preview: null };
}

/**
 * 分割线拖动状态机。任何“结束”动作（end/cancel）都清除拖动标记与预览；
 * end 由调用方在提交前读取 preview，cancel 直接丢弃预览（回到已提交值）。
 */
export function splitterReducer(state: SplitterState, action: SplitterAction): SplitterState {
  switch (action.type) {
    case 'sync':
      return state.dragging ? state : { ...state, startHeight: action.height };
    case 'begin':
      return {
        dragging: true,
        pointerId: action.pointerId,
        startY: action.y,
        startHeight: state.startHeight,
        preview: state.startHeight,
      };
    case 'move':
      if (!state.dragging) {
        return state;
      }
      return { ...state, preview: heightFromDrag(state.startHeight, action.y - state.startY, action.limits) };
    case 'end':
    case 'cancel':
      if (!state.dragging) {
        return state;
      }
      return { ...state, dragging: false, pointerId: null, preview: null };
    default:
      return state;
  }
}

/** 拖动结束时待提交的高度（有预览取预览，否则取起始值）。 */
export function splitterCommitHeight(state: SplitterState): number {
  return state.preview ?? state.startHeight;
}
/* ------------------------------------------------------------------ */
/* 右侧检查器宽度（方案 §4：默认 320 / 最小 280 / 最大 440）              */
/* ------------------------------------------------------------------ */

export const MIN_PANEL_WIDTH = 280;
export const MAX_PANEL_WIDTH = 440;
export const DEFAULT_PANEL_WIDTH = 320;

export interface PanelLimits {
  min: number;
  max: number;
}

/** 面板宽度上限同时受容器宽度约束（不超过 45%），避免挤占监视器。 */
export function resolvePanelLimits(containerWidth: number): PanelLimits {
  const maxByContainer =
    containerWidth > 0 ? Math.floor(containerWidth * 0.45) : MAX_PANEL_WIDTH;
  const max = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, maxByContainer));
  return { min: MIN_PANEL_WIDTH, max };
}

export function clampPanelWidth(value: number, limits: PanelLimits): number {
  if (!Number.isFinite(value)) {
    return limits.min;
  }
  return Math.round(Math.min(limits.max, Math.max(limits.min, value)));
}

/** 面板在右侧：分割线向左拖动（deltaX < 0）使面板变宽。 */
export function widthFromDrag(startWidth: number, deltaX: number, limits: PanelLimits): number {
  return clampPanelWidth(startWidth - deltaX, limits);
}

export function defaultPanelWidth(limits: PanelLimits): number {
  return clampPanelWidth(DEFAULT_PANEL_WIDTH, limits);
}
