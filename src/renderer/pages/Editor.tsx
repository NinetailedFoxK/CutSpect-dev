/**
 * Editor（规格 2.5 布局 / 3.3 视口跟随 / 4 图层 / 5 曲线 / 6 标注 / 7 分段 /
 * 8.2 保存状态 / 14 快捷键）。
 *
 * 顶栏：返回、项目名、保存状态、撤销/重做、列表、图层。
 * 左栏：选择/节点/自由画/直线/标注/分段 工具 + “在播放头标注”。
 * 中央：画布（视频 + 分析层）+ 播放条 + 时间线。
 * 右栏：属性/列表面板（选中对象或打开列表时展开 280px）。
 *
 * 左右对齐铁律（规格 2.5）：中央列宽度 → plotX 下发画布与时间线；画布宿主
 * 高度 → plotY 下发网格与曲线/标注/分段层。所有分析元素共用同一坐标系。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Annotation,
  Boundary,
  CurveNode,
  DetectedCut,

  FramePreview,
  LaipianError,
  ProjectSnapshot,
  ProjectView,
  RecoveryInfo,
  Section,

  StructureNode,
  TimelineThumbnail,
  ViewCanvasLayout,
} from '@shared/api-types';
import { clamp, clampViewRange, formatTimeMs } from '@shared/time';
import { TIMELINE_VIEW_VERSION, migrateTimelineView } from '@shared/schema';
import { formatClockTime } from '../lib/format';
import { currentAdapter } from '../../platform/common';
import { commandForEvent, commandForWheel, formatBinding } from '@shared/keymap';
import type { CommandId } from '@shared/keymap';
import { createCurveEvaluator, insertNodeWithValue, moveNodes, removeNode, setSegmentOutMode } from '@shared/geometry';
import { ExportDialog } from '../components/ExportDialog';
import { StructurePanel } from '../components/StructurePanel';
import { ShotIndex } from '../components/ShotIndex';
import {
  Icon,
  IconBack,
  IconChevronLeft,
  IconChevronRight,
  IconCleanPreview,
  IconExport,
  IconFitAll,
  IconFullscreen,
  IconGrid,
  IconKeyboard,
  IconLayers,
  IconOverlay,
  IconRedo,
  IconSheet,
  IconUndo,
} from '../components/Icons';
import {
  addAnnotation,
  removeAnnotation,
  titleFromBody,
  updateAnnotation,
} from '@shared/annotations';
import {
  addBoundary,
  removeBoundary,
  renameSection,
  resolveSectionForTime,
  sectionRanges,
  setBoundaryLocked,
  setSectionNote,
} from '@shared/sections';
import {
  childrenOf,
  deriveRanges,
  findNode,
  mergeNode,
  nearestChildBoundary,
  resolveNodeAt,
  splitNode,
  updateStructureNode,
} from '@shared/structure';
import {
  countEditableShots,
  planShotsInRange,
  resolveShotTarget,
  type ShotStrategy,
  type ShotTarget,
} from '@shared/structure-shots';
import { feedbackStore } from '../feedback/instance';
import {
  computePlotXGeometry,
  computePlotYGeometry,
  pageForwardRange,
  valueToY,
  type PlotYGeometry,
  type TimeRange,
} from '../editor/editor-geometry';

import type { ToolId } from '../editor/tools';
import { applyShotCuts, filterCandidateTimes } from '../editor/shot-apply';
import { DEFAULT_MIN_SHOT_MS, DEFAULT_SHOT_PRESET, SHOT_PRESETS } from '@shared/shots';
import {
  NODE_SHAPES,
  PRESET_ORDER,
  STYLE_PRESETS,
  resolveStyle,
  type NodeShape,
  type PartialProjectStyle,
  type ProjectStyle,
  type StylePresetId,
} from '@shared/style';
import type { ShotSensitivityId } from '@shared/shots';
import { useMediaPlayer } from '../hooks/useMediaPlayer';
import { useFramePreview } from '../hooks/useFramePreview';
import { useKeymap } from '../hooks/useKeymap';
import { VideoCanvas } from '../components/VideoCanvas';
import { CurveLayer } from '../components/CurveLayer';
import { PLAYBACK_RATES, PlayerBar } from '../components/PlayerBar';
import { ShortcutHelpDialog } from '../components/ShortcutHelpDialog';
import { Timeline } from '../components/Timeline';
import { TimelineSplitter } from '../components/TimelineSplitter';
import { PanelSplitter } from '../components/PanelSplitter';
import {
  ABSOLUTE_MAX_TIMELINE_HEIGHT,
  DEFAULT_PANEL_WIDTH,
  DEFAULT_TIMELINE_HEIGHT,
  MIN_TIMELINE_HEIGHT,
  SPLITTER_THICKNESS,
  clampPanelWidth,
  clampTimelineHeight,
  defaultPanelWidth,
  defaultTimelineHeight,
  resolvePanelLimits,
  resolveTimelineLimits,
} from '../editor/layout';

export type SaveState = 'saved' | 'saving' | 'dirty' | 'error';

/** 精确画面帧请求尺寸（浮层预览卡与右侧面板共用同一张，规格 5.2 / 5.3）。 */
const FRAME_PREVIEW_WIDTH = 320;
const FRAME_PREVIEW_HEIGHT = 180;

/** 读谱区（lp-score）内固定高度：节奏谱工具条 + 底部状态栏（与 tokens.css 对应）。 */
const SCORE_TOOLBAR_HEIGHT = 34;
const SCORE_STATUS_HEIGHT = 26;
/** 时间线本体在读谱区内的最小可编辑高度（工具条与状态栏会占去一部分）。 */
const MIN_SCORE_BODY_HEIGHT = 150;
/** 谱面视图（sheet）下曲线谱面的默认高度（方案 §8：曲线谱面约 140–180px）。 */
const SHEET_CANVAS_HEIGHT = 176;

/** 当前平台适配（用于系统术语与键位展示，macOS/Windows 共用同一界面）。 */
const PLATFORM = currentAdapter();

/** 左侧工具栏分组（第十点：播放头操作 / 曲线绘制 / 状态）。 */
const TOOLBAR_GROUPS: readonly { title: string; items: readonly CommandId[] }[] = [
  { title: '播放头操作', items: ['node.add', 'mark.addAlt', 'section.add'] },
  { title: '曲线绘制', items: ['draw.freehandOnce', 'draw.lineOnce'] },
  { title: '状态', items: ['tool.select'] },
];

/** 工具栏按钮短标签。 */
const TOOLBAR_LABELS: Readonly<Record<string, string>> = {
  'node.add': '加节点',
  'mark.addAlt': '加标注',
  'section.add': '加分段',
  'draw.freehandOnce': '自由绘制',
  'draw.lineOnce': '直线绘制',
  'tool.select': '选择',
};

/** 工具栏图标名（V2 图标系统）：操作图形化，中文名进入工具提示。 */
const TOOLBAR_ICONS: Readonly<Record<string, string>> = {
  'node.add': 'node-add',
  'mark.addAlt': 'annotation-add',
  'section.add': 'boundary-add',
  'draw.freehandOnce': 'curve-freehand',
  'draw.lineOnce': 'curve-line',
  'tool.select': 'select',
};

/** 节点形状中文名（样式检查器）。 */
const NODE_SHAPE_LABELS: Readonly<Record<NodeShape, string>> = {
  circle: '圆形',
  diamond: '菱形',
  rounded: '圆角方形',
  hexagon: '六边形',
  ring: '空心圆环',
};

const SAVE_STATE_LABELS: Record<SaveState, string> = {
  saved: '已保存',
  saving: '正在保存…',
  dirty: '尚有更改',
  error: '保存失败',
};

export type ProjectContentPatch = Partial<
  Pick<
    ProjectSnapshot,
    'curve' | 'annotations' | 'boundaries' | 'sections' | 'name' | 'style' | 'structure'
  >
>;

export interface EditorProps {
  snapshot: ProjectSnapshot;
  mediaSrc: string;
  onClose(): void;
  onViewChange(view: ProjectView): void;
  onContentChange(patch: ProjectContentPatch, coalesceKey?: string): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  /** Cmd/Ctrl+S 立即保存；导出前会等待其完成（规格 13.2）。 */
  onSaveRequested?(): Promise<void> | void;
  saveStatus?: SaveState;
  /** 最近一次保存失败原因（规格 10）；非空时顶栏与内联提示显示并可重试。 */
  saveError?: LaipianError | null;
  /** 最近一次成功保存时间（epoch ms），显示「已保存 · 最近保存 时间」。 */
  lastSavedAt?: number | null;
  /** 顶栏/内联「重试」触发（立即 flush 保存）。 */
  onRetrySave?(): void;
  /** 检测到的更新未提交快照（规格 8.4）；非空时显示恢复提示。 */
  recovery?: RecoveryInfo | null;
  onRestoreRecovery?(): void;
  onDiscardRecovery?(): void;
}

function formatSectionsRange(
  boundaries: readonly Boundary[],
  sections: readonly Section[],
): { section: Section; startMs: number; endMs: number }[] {
  return sectionRanges(boundaries, sections);
}

/* ------------------------------------------------------------------ */
/* 右侧面板组件                                                         */
/* ------------------------------------------------------------------ */

interface NodePanelProps {
  curveName: string;
  nodes: readonly CurveNode[];
  selectedNodeIds: readonly string[];
  onChangeNodes(next: CurveNode[], coalesceKey?: string): void;
  onRenameCurve(name: string): void;
  /** 主选节点对应的画面帧（规格 5.3 对应画面区）。 */
  frame: FramePreview | null;
  frameLoading: boolean;
  frameError: string | null;
  onSeekFrame(timeMs: number): void;
}

function NodePanel({
  curveName,
  nodes,
  selectedNodeIds,
  onChangeNodes,
  onRenameCurve,
  frame,
  frameLoading,
  frameError,
  onSeekFrame,
}: NodePanelProps) {
  const selected = nodes.filter((node) => selectedNodeIds.includes(node.id));
  const single = selected.length === 1 ? selected[0] : undefined;
  const index = single !== undefined ? nodes.findIndex((n) => n.id === single.id) : -1;
  const isEndpoint = index === 0 || index === nodes.length - 1;

  const commitTime = (value: number): void => {
    if (single === undefined || index < 0) return;
    const left = nodes[index - 1];
    const right = nodes[index + 1];
    const min = left !== undefined ? left.timeMs + 1 : 0;
    const max = right !== undefined ? right.timeMs - 1 : single.timeMs;
    onChangeNodes(
      nodes.map((node) => (node.id === single.id ? { ...node, timeMs: clamp(Math.round(value), min, max) } : { ...node })),
      `node-time-${single.id}`,
    );
  };
  const commitValue = (value: number): void => {
    if (single === undefined) return;
    onChangeNodes(
      nodes.map((node) => (node.id === single.id ? { ...node, value: clamp(value, 0, 100) } : { ...node })),
      `node-value-${single.id}`,
    );
  };

  const segmentIndex = index >= 0 && index < nodes.length - 1 ? index : -1;
  const segmentMode = segmentIndex >= 0 ? nodes[segmentIndex]?.outMode : undefined;

  return (
    <div className="lp-props">
      <div className="lp-props-section">
        <label className="lp-props-label" htmlFor="lp-curve-name">曲线名称</label>
        <input
          id="lp-curve-name"
          className="lp-props-input"
          type="text"
          value={curveName}
          onChange={(e) => onRenameCurve(e.target.value)}
        />
      </div>
      {single !== undefined && (
        <div className="lp-props-section">
          <div className="lp-props-title">对应画面</div>
          <button
            type="button"
            className="lp-frame-panel-media"
            onClick={() => onSeekFrame(single.timeMs)}
            disabled={frame === null}
            title={frame === null ? '该帧暂时无法读取' : '点击定位到该画面'}
          >
            {frame !== null ? (
              <img className="lp-frame-panel-img" src={frame.mediaUrl} alt="" draggable={false} />
            ) : frameLoading ? (
              <span className="lp-frame-panel-skeleton" aria-hidden="true" />
            ) : (
              <span className="lp-frame-panel-failed">该帧暂时无法读取</span>
            )}
          </button>
          <div className="lp-frame-panel-meta">
            <span className="lp-frame-panel-time">{formatTimeMs(single.timeMs, { hours: 'always' })}</span>
            {frame !== null && frame.frameNumber !== null && (
              <span className="lp-frame-panel-no">帧 {frame.frameNumber}</span>
            )}
            <span className="lp-frame-panel-value">值 {Math.round(single.value)}</span>
          </div>
          {frameError !== null && (
            <p className="lp-props-hint">{frameError}（节点参数仍可编辑）</p>
          )}
        </div>
      )}
      {single !== undefined ? (
        <div className="lp-props-section">
          <div className="lp-props-title">节点属性</div>
          <label className="lp-props-row">
            <span>时间 (ms)</span>
            <input className="lp-props-input" type="number" min={0} step={1} value={Math.round(single.timeMs)} disabled={isEndpoint} onChange={(e) => commitTime(Number(e.target.value))} />
          </label>
          <label className="lp-props-row">
            <span>值 (0—100)</span>
            <input className="lp-props-input" type="number" min={0} max={100} step={1} value={Math.round(single.value)} onChange={(e) => commitValue(Number(e.target.value))} />
          </label>
          {segmentIndex >= 0 && (
            <div className="lp-props-row lp-props-row--stack">
              <span>右侧段模式</span>
              <div className="lp-props-buttons">
                {(['auto', 'linear', 'bezier'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={segmentMode === mode ? 'lp-seg-button is-active' : 'lp-seg-button'}
                    onClick={() => {
                      if (mode === 'bezier') {
                        // 等形转换由几何核心处理（保持形状）。
                        onChangeNodes(setSegmentOutMode(nodes, segmentIndex, 'bezier'));
                        return;
                      }
                      const next = nodes.map((node) => ({ ...node }));
                      const left = next[segmentIndex];
                      const right = next[segmentIndex + 1];
                      if (left !== undefined) {
                        left.outMode = mode;
                        left.outHandle = null;
                      }
                      if (right !== undefined) {
                        right.inHandle = null;
                      }
                      onChangeNodes(next);
                    }}
                  >
                    {mode === 'auto' ? '自动平滑' : mode === 'linear' ? '直线' : '贝塞尔'}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button type="button" className="lp-props-danger" disabled={isEndpoint} onClick={() => onChangeNodes(removeNode(nodes, single.id))}>
            删除节点
          </button>
          {isEndpoint && <p className="lp-props-hint">首尾端点时间固定，可改高度但不可删除。</p>}
        </div>
      ) : selected.length > 1 ? (
        <div className="lp-props-section">
          <div className="lp-props-title">已选 {selected.length} 个节点</div>
          <p className="lp-props-hint">拖动整体移动；包含端点时横向移动被固定为 0。</p>
        </div>
      ) : (
        <p className="lp-props-hint">在曲线上点选节点以编辑时间/值/段模式。</p>
      )}
    </div>
  );
}

interface AnnotationPanelProps {
  annotation: Annotation;
  annotations: readonly Annotation[];
  boundaries: readonly Boundary[];
  sections: readonly Section[];
  durationMs: number;
  onCommit(patch: OutputPatch, coalesceKey?: string): void;
  onDelete(): void;
  onSeek(timeMs: number): void;
}

interface OutputPatch {
  annotations?: Annotation[];
  boundaries?: Boundary[];
  sections?: Section[];
  curve?: ProjectSnapshot['curve'];
  style?: ProjectSnapshot['style'];
  structure?: StructureNode[];
}

interface StyleInspectorProps {
  style: ProjectStyle;
  curveColor: string;
  onApplyPreset(id: StylePresetId): void;
  onPatchStyle(patch: PartialProjectStyle): void;
  onCurveColor(color: string): void;
}

/**
 * 样式检查器（分析监视器「样式」页签）。
 * 只编辑全局样式与预设；单节点样式/视觉徽章留到第二阶段。
 * 滑杆连续调整经同一 coalesceKey 合并为一次撤销（规格：松开滑杆才写入一次历史）。
 */
function StyleInspector(props: StyleInspectorProps) {
  const { style, curveColor, onApplyPreset, onPatchStyle, onCurveColor } = props;
  return (
    <div className="lp-props">
      <div className="lp-props-section">
        <div className="lp-props-title">样式预设</div>
        <select
          className="lp-props-input"
          value={style.preset}
          onChange={(e) => onApplyPreset(e.target.value as StylePresetId)}
          aria-label="样式预设"
        >
          {PRESET_ORDER.map((id) => (
            <option key={id} value={id}>
              {STYLE_PRESETS[id].label}
            </option>
          ))}
        </select>
        <p className="lp-props-hint">{STYLE_PRESETS[style.preset].description}</p>
      </div>

      <div className="lp-props-section">
        <div className="lp-props-title">曲线</div>
        <label className="lp-props-row">
          <span>颜色</span>
          <input
            type="color"
            className="lp-style-color"
            value={curveColor}
            onChange={(e) => onCurveColor(e.target.value)}
            aria-label="曲线颜色"
          />
        </label>
        <label className="lp-props-row">
          <span>粗细</span>
          <input
            type="range"
            min={1}
            max={6}
            step={0.5}
            value={style.curve.width}
            onChange={(e) => onPatchStyle({ curve: { width: Number(e.target.value) } })}
            aria-label="曲线粗细"
          />
          <span className="lp-props-value">{style.curve.width}px</span>
        </label>
        <label className="lp-props-row">
          <span>透明度</span>
          <input
            type="range"
            min={10}
            max={100}
            step={1}
            value={Math.round(style.curve.opacity * 100)}
            onChange={(e) => onPatchStyle({ curve: { opacity: Number(e.target.value) / 100 } })}
            aria-label="曲线透明度"
          />
          <span className="lp-props-value">{Math.round(style.curve.opacity * 100)}%</span>
        </label>
        <label className="lp-props-row">
          <span>辅助轮廓</span>
          <input
            type="range"
            min={0}
            max={40}
            step={1}
            value={Math.round(style.curve.halo * 100)}
            onChange={(e) => onPatchStyle({ curve: { halo: Number(e.target.value) / 100 } })}
            aria-label="辅助轮廓"
          />
          <span className="lp-props-value">{Math.round(style.curve.halo * 100)}%</span>
        </label>
      </div>

      <div className="lp-props-section">
        <div className="lp-props-title">节点</div>
        <label className="lp-props-row">
          <span>形状</span>
          <select
            className="lp-props-input"
            value={style.node.shape}
            onChange={(e) => onPatchStyle({ node: { shape: e.target.value as NodeShape } })}
            aria-label="节点形状"
          >
            {NODE_SHAPES.map((shape) => (
              <option key={shape} value={shape}>
                {NODE_SHAPE_LABELS[shape]}
              </option>
            ))}
          </select>
        </label>
        <label className="lp-props-row">
          <span>大小</span>
          <input
            type="range"
            min={6}
            max={18}
            step={1}
            value={style.node.size}
            onChange={(e) => onPatchStyle({ node: { size: Number(e.target.value) } })}
            aria-label="节点大小"
          />
          <span className="lp-props-value">{style.node.size}px</span>
        </label>
        <label className="lp-props-row">
          <span>描边</span>
          <input
            type="range"
            min={1}
            max={4}
            step={0.5}
            value={style.node.stroke}
            onChange={(e) => onPatchStyle({ node: { stroke: Number(e.target.value) } })}
            aria-label="节点描边"
          />
          <span className="lp-props-value">{style.node.stroke}px</span>
        </label>
        <p className="lp-props-hint">首尾端点固定使用圆角方形，便于与普通节点区分。</p>
      </div>

      <div className="lp-props-section">
        <div className="lp-props-title">标注</div>
        <label className="lp-props-row">
          <span>颜色</span>
          <input
            type="color"
            className="lp-style-color"
            value={style.annotation.color}
            onChange={(e) => onPatchStyle({ annotation: { color: e.target.value } })}
            aria-label="标注颜色"
          />
        </label>
      </div>

      <div className="lp-props-section">
        <div className="lp-props-title">网格</div>
        <label className="lp-props-row">
          <span>显示</span>
          <input
            type="checkbox"
            checked={style.grid.visible}
            onChange={(e) => onPatchStyle({ grid: { ...style.grid, visible: e.target.checked } })}
            aria-label="网格显示"
          />
        </label>
        <label className="lp-props-row">
          <span>透明度</span>
          <input
            type="range"
            min={2}
            max={20}
            step={1}
            value={Math.round(style.grid.opacity * 100)}
            onChange={(e) => onPatchStyle({ grid: { ...style.grid, opacity: Number(e.target.value) / 100 } })}
            aria-label="网格透明度"
          />
          <span className="lp-props-value">{Math.round(style.grid.opacity * 100)}%</span>
        </label>
      </div>

      <div className="lp-props-section">
        <button type="button" className="lp-props-danger" onClick={() => onApplyPreset('pro')}>
          恢复默认样式
        </button>
      </div>
      <p className="lp-props-hint">样式随项目保存并进入撤销历史；编辑视图 / 干净预览只改变显示，不改变数据。</p>
    </div>
  );
}

function AnnotationPanel({ annotation, annotations, boundaries, sections, durationMs, onCommit, onDelete, onSeek }: AnnotationPanelProps) {
  const owning = resolveSectionForTime(boundaries, sections, annotation.timeMs);
  const [error, setError] = useState<string | null>(null);

  const commit = (patch: Parameters<typeof updateAnnotation>[2], coalesceKey?: string): void => {
    let effective = patch;
    // 规格 6.1：标题为空而正文有内容时，自动取正文首行前 20 字符作标题。
    if (patch.body !== undefined && annotation.title.trim().length === 0 && patch.title === undefined) {
      const derived = titleFromBody(patch.body);
      if (derived.length > 0) {
        effective = { ...patch, title: derived };
      }
    }
    const result = updateAnnotation(annotations, annotation.id, effective);
    if (!result.ok) {
      setError(result.message ?? '修改失败。');
      return;
    }
    setError(null);
    onCommit({ annotations: result.annotations }, coalesceKey);
  };

  return (
    <div className="lp-props">
      <div className="lp-props-section">
        <div className="lp-props-title">标注</div>
        <label className="lp-props-row">
          <span>时间 (ms)</span>
          <input className="lp-props-input" type="number" min={0} step={1} value={annotation.timeMs} onChange={(e) => commit({ timeMs: clamp(Math.round(Number(e.target.value)), 0, durationMs) })} />
        </label>
        <label className="lp-props-row">
          <span>标题</span>
          <input className="lp-props-input" type="text" maxLength={80} value={annotation.title} onChange={(e) => commit({ title: e.target.value }, 'note-title')} />
        </label>
        <label className="lp-props-row lp-props-row--stack">
          <span>正文</span>
          <textarea className="lp-props-textarea" maxLength={5000} rows={6} value={annotation.body} onChange={(e) => commit({ body: e.target.value }, 'note-body')} />
        </label>
        <p className="lp-props-hint">所属段落：{owning?.name ?? '—'}</p>
        {error !== null && <p className="lp-props-error" role="alert">{error}</p>}
        <div className="lp-props-buttons">
          <button type="button" className="lp-seg-button" onClick={() => onSeek(annotation.timeMs)}>定位</button>
          <button type="button" className="lp-props-danger" onClick={onDelete}>删除标注</button>
        </div>
      </div>
    </div>
  );
}

interface SectionPanelProps {
  boundaries: readonly Boundary[];
  sections: readonly Section[];
  selectedBoundaryId: string | null;
  selectedSection: Section;
  onCommit(patch: OutputPatch, coalesceKey?: string): void;
  onNotice(message: string): void;
}

function SectionPanel({ boundaries, sections, selectedBoundaryId, selectedSection, onCommit, onNotice }: SectionPanelProps) {
  const ranges = formatSectionsRange(boundaries, sections);
  const range = ranges.find((r) => r.section.id === selectedSection.id);
  const boundary = selectedBoundaryId !== null ? boundaries.find((b) => b.id === selectedBoundaryId) : undefined;
  const internal = boundary !== undefined && !boundary.fixed;

  const deleteBoundary = (): void => {
    if (boundary === undefined) return;
    const rightSection = sections.find((s) => s.startBoundaryId === boundary.id);
    const rightHasNote = (rightSection?.note ?? '').trim().length > 0;
    if (rightHasNote) {
      onNotice('删除边界将合并相邻段落：右段备注会以分隔符并入左段。再次点击“删除分段”确认。');
    }
    const result = removeBoundary(boundaries, sections, boundary.id);
    if (!result.ok) {
      onNotice(result.message ?? '无法删除该边界。');
      return;
    }
    onCommit({ boundaries: result.boundaries, sections: result.sections });
  };

  return (
    <div className="lp-props">
      <div className="lp-props-section">
        <div className="lp-props-title">段落</div>
        {range && (
          <p className="lp-props-hint">
            范围：{range.startMs} — {range.endMs} ms
          </p>
        )}
        <label className="lp-props-label">名称</label>
        <input
          className="lp-props-input"
          type="text"
          value={selectedSection.name}
          onChange={(e) => onCommit({ sections: renameSection(sections, selectedSection.id, e.target.value) }, `section-name-${selectedSection.id}`)}
        />
        <label className="lp-props-label">备注</label>
        <textarea
          className="lp-props-textarea"
          rows={6}
          value={selectedSection.note}
          onChange={(e) => onCommit({ sections: setSectionNote(sections, selectedSection.id, e.target.value) }, `section-note-${selectedSection.id}`)}
        />
      </div>
      {internal && boundary !== undefined && (
        <div className="lp-props-section">
          <div className="lp-props-title">边界</div>
          <label className="lp-layer-name">
            <input
              type="checkbox"
              checked={boundary.locked}
              onChange={(e) => {
                const result = setBoundaryLocked(boundaries, sections, boundary.id, e.target.checked);
                if (result.ok) {
                  onCommit({ boundaries: result.boundaries });
                } else {
                  onNotice(result.message ?? '无法修改锁定。');
                }
              }}
            />
            锁定该边界（禁止拖动/编辑/删除）
          </label>
          <button type="button" className="lp-props-danger" onClick={deleteBoundary}>
            删除分段（合并相邻段落）
          </button>
        </div>
      )}
    </div>
  );
}

interface ListPanelProps {
  annotations: readonly Annotation[];
  boundaries: readonly Boundary[];
  sections: readonly Section[];
  onSelectAnnotation(id: string): void;
  onSelectSection(id: string): void;
  /** 固定显示（常驻右栏）时不传；仅在提供时才渲染关闭按钮。 */
  onClose?(): void;
}

function ListPanel({ annotations, boundaries, sections, onSelectAnnotation, onSelectSection, onClose }: ListPanelProps) {
  const [query, setQuery] = useState('');
  const keyword = query.trim().toLowerCase();
  const sorted = [...annotations].sort((a, b) => a.timeMs - b.timeMs);
  const filtered = sorted.filter(
    (a) =>
      keyword.length === 0 ||
      a.title.toLowerCase().includes(keyword) ||
      a.body.toLowerCase().includes(keyword),
  );
  const ranges = formatSectionsRange(boundaries, sections);

  return (
    <div className="lp-props lp-props-list">
      <div className="lp-props-section">
        <div className="lp-props-title-row">
          <span className="lp-props-title">标注列表（{annotations.length}）</span>
          {onClose !== undefined && (
            <button type="button" className="lp-props-close" onClick={onClose} aria-label="关闭列表">×</button>
          )}
        </div>
        <input
          className="lp-props-input"
          type="search"
          placeholder="搜索标题或正文"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {filtered.length === 0 ? (
          <p className="lp-props-hint">没有匹配的标注</p>
        ) : (
          <ul className="lp-list">
            {filtered.map((a) => (
              <li key={a.id}>
                <button type="button" className="lp-list-item" onClick={() => onSelectAnnotation(a.id)}>
                  <span className="lp-list-time">{Math.round(a.timeMs)} ms</span>
                  <span className="lp-list-text">{a.title.length > 0 ? a.title : titleFromBody(a.body) || '（无标题）'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="lp-props-section">
        <div className="lp-props-title">段落列表（{ranges.length}）</div>
        <ul className="lp-list">
          {ranges.map((r) => (
            <li key={r.section.id}>
              <button type="button" className="lp-list-item" onClick={() => onSelectSection(r.section.id)}>
                <span className="lp-list-time">{r.startMs}—{r.endMs}</span>
                <span className="lp-list-text">{r.section.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

export function Editor(props: EditorProps) {
  const {
    snapshot,
    mediaSrc,
    onClose,
    onViewChange,
    onContentChange,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    onSaveRequested,
    saveStatus,
    saveError,
    lastSavedAt,
    onRetrySave,
    recovery,
    onRestoreRecovery,
    onDiscardRecovery,
  } = props;
  const durationMs = Math.max(1, snapshot.media.durationMs);
  const curve = snapshot.curve;
  const annotations = snapshot.annotations;
  const boundaries = snapshot.boundaries;
  const sections = snapshot.sections;
  /** 三级结构（章节/段落/镜头）；旧项目在打开链路已迁移，缺省时退化为空数组。 */
  const structure = snapshot.structure ?? [];

  const [view, setView] = useState(() => normalizeView(snapshot.view, durationMs));
  const viewRef = useRef(view);
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;

  const updateView = useCallback((patch: Partial<ProjectView>) => {
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next;
    setView(next);
    onViewChangeRef.current(next);
  }, []);

  // §6.2：视图窗口做了一次性迁移（normalizeView）后写入迁移版本并触发一次保存持久化，
  // 保证"只迁移一次"；原项目已含版本时不再触发（不重置用户已有缩放）。
  const timelineViewMigratedRef = useRef(false);
  useEffect(() => {
    if (timelineViewMigratedRef.current) {
      return;
    }
    timelineViewMigratedRef.current = true;
    if (snapshot.view.timelineViewVersion === undefined) {
      updateView({ timelineViewVersion: TIMELINE_VIEW_VERSION });
    }
  }, [snapshot.view.timelineViewVersion, updateView]);

  const [tool, setTool] = useState<ToolId>('select');
  const [drawSustained, setDrawSustained] = useState(false);
  /** 分析监视器视图模式：编辑视图显示节点/控制柄/网格；干净预览只显示成品。 */
  const [monitorMode, setMonitorMode] = useState<'edit' | 'clean'>('edit');
  /** 右侧样式检查器页签：内容 / 样式 / 结构。 */
  const [inspectorTab, setInspectorTab] = useState<'content' | 'style' | 'structure'>('content');
  /** 生效样式：合并项目已保存样式与默认（旧项目缺省兼容）。 */
  const style = useMemo(() => resolveStyle(snapshot.style), [snapshot.style]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [selectedBoundaryId, setSelectedBoundaryId] = useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [selectedStructureId, setSelectedStructureId] = useState<string | null>(null);
  /** 时间线中悬停的镜头结构 id（用于监视器只显示该镜头边界）。 */
  const [hoveredStructureId, setHoveredStructureId] = useState<string | null>(null);

  const [toolNotice, setToolNotice] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [thumbnails, setThumbnails] = useState<TimelineThumbnail[]>([]);
  const [thumbnailsLoading, setThumbnailsLoading] = useState(false);

  // 时间线帧带缩略图（规格 4.4）：拉取已生成列表，未生成时按增长轮询增量刷新，不阻塞播放。
  useEffect(() => {
    const api = window.laipian;
    if (!api) {
      return undefined;
    }
    // 本轮性能要求：打开项目不再自动生成/轮询整条视频的缩略图。
    // 时间线画面由应用级抽帧队列按可视范围按需抽取；此处只读一次已有缓存。
    const projectId = snapshot.id;
    let cancelled = false;
    setThumbnailsLoading(false);
    void api.media
      .listThumbnails({ projectId })
      .then((result) => {
        if (cancelled) return;
        setThumbnails(result.ok ? result.data : []);
      })
      .catch(() => {
        if (!cancelled) setThumbnails([]);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot.id]);

  useEffect(() => {
    if (toolNotice === null) return undefined;
    const timer = window.setTimeout(() => setToolNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toolNotice]);

  const handlePlayheadPersist = useCallback(
    (ms: number) => {
      if (Math.round(ms) !== viewRef.current.playheadMs) {
        updateView({ playheadMs: Math.round(ms) });
      }
    },
    [updateView],
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controller = useMediaPlayer({ videoRef, durationMs, initialPlayheadMs: view.playheadMs, onPlayheadPersist: handlePlayheadPersist });
  const { playheadStore } = controller;

  const centerRef = useRef<HTMLDivElement | null>(null);
  const [centerWidth, setCenterWidth] = useState(0);
  const [centerHeight, setCenterHeight] = useState(0);
  useEffect(() => {
    const el = centerRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCenterWidth(entry.contentRect.width);
        setCenterHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const geometry = useMemo(() => computePlotXGeometry(centerWidth), [centerWidth]);

  // —— 分析监视器 / 时间线分割线（可拖动调整高度） ——
  // 高度限制集中在 editor/layout（单一来源）；拖动中只做预览，结束后提交视图状态。
  const timelineLimits = useMemo(
    () => resolveTimelineLimits(centerHeight, { splitterHeight: SPLITTER_THICKNESS }),
    [centerHeight],
  );
  const [previewTimelineHeight, setPreviewTimelineHeight] = useState<number | null>(null);
  const [splitterDragging, setSplitterDragging] = useState(false);
  const effectiveTimelineHeight =
    previewTimelineHeight ?? clampTimelineHeight(view.timelineHeight, timelineLimits);

  // —— 视图模式（方案 §2）：overlay 曲线覆盖视频 / sheet 视频与曲线分开 ——
  // 默认谱面视图（sheet）：视频保持干净，需要对照曲线时再主动切换「叠加视图」。
  const canvasLayout: ViewCanvasLayout = view.canvasLayout === 'overlay' ? 'overlay' : 'sheet';

  // 谱面视图额外占用读谱区的曲线谱面高度（方案 §8：向上拖动时优先把空间给曲线谱面）。
  const sheetCanvasHeight = canvasLayout === 'sheet' ? SHEET_CANVAS_HEIGHT : 0;
  const minVideoHeight = 220;
  const minScoreHeight =
    SCORE_TOOLBAR_HEIGHT + SCORE_STATUS_HEIGHT + MIN_SCORE_BODY_HEIGHT + sheetCanvasHeight;
  const maxScoreHeight = Math.max(
    minScoreHeight,
    centerHeight - SPLITTER_THICKNESS - minVideoHeight,
  );
  const scoreHeight = Math.min(effectiveTimelineHeight + sheetCanvasHeight, maxScoreHeight);
  // 时间线本体 = 读谱区总高 − 工具条 − 状态栏 − 曲线谱面（仍留最小可编辑高度）。
  const timelineBodyHeight = Math.max(
    MIN_SCORE_BODY_HEIGHT,
    scoreHeight - SCORE_TOOLBAR_HEIGHT - SCORE_STATUS_HEIGHT - sheetCanvasHeight,
  );

  // 窗口缩小 / 旧项目越界值：自动夹紧到合法范围并落盘（不进入内容撤销历史）。
  useEffect(() => {
    if (previewTimelineHeight !== null) return;
    const clamped = clampTimelineHeight(view.timelineHeight, timelineLimits);
    if (clamped !== view.timelineHeight) {
      updateView({ timelineHeight: clamped });
    }
  }, [timelineLimits, view.timelineHeight, previewTimelineHeight, updateView]);

  const commitTimelineHeight = useCallback(
    (next: number) => {
      setPreviewTimelineHeight(null);
      updateView({ timelineHeight: clampTimelineHeight(next, timelineLimits) });
    },
    [timelineLimits, updateView],
  );

  // —— 右侧检查器宽度分割线（方案 §4：默认 320 / 280–440） ——
  const [previewPanelWidth, setPreviewPanelWidth] = useState<number | null>(null);
  const [panelDragging, setPanelDragging] = useState(false);
  const panelLimits = useMemo(
    () =>
      // 首帧未测量（centerWidth=0）时用绝对区间，避免误把检查器夹到最小宽度。
      resolvePanelLimits(
        centerWidth > 0 ? centerWidth + (view.inspectorWidth ?? DEFAULT_PANEL_WIDTH) : 0,
      ),
    [centerWidth, view.inspectorWidth],
  );
  const effectivePanelWidth =
    previewPanelWidth ?? clampPanelWidth(view.inspectorWidth ?? DEFAULT_PANEL_WIDTH, panelLimits);

  useEffect(() => {
    if (previewPanelWidth !== null) return;
    if (centerWidth <= 0) return;
    const current = view.inspectorWidth ?? DEFAULT_PANEL_WIDTH;
    const clamped = clampPanelWidth(current, panelLimits);
    if (clamped !== current) {
      updateView({ inspectorWidth: clamped });
    }
  }, [panelLimits, view.inspectorWidth, previewPanelWidth, centerWidth, updateView]);

  const commitPanelWidth = useCallback(
    (next: number) => {
      setPreviewPanelWidth(null);
      updateView({ inspectorWidth: clampPanelWidth(next, panelLimits) });
    },
    [panelLimits, updateView],
  );

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasHeight, setCanvasHeight] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setCanvasHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const plotY: PlotYGeometry = useMemo(() => computePlotYGeometry(canvasHeight), [canvasHeight]);

  // 谱面视图下，曲线移入读谱区：独立测量谱面容器的纵向几何（横向仍与时间线共用 plotX）。
  const scoreCanvasRef = useRef<HTMLDivElement | null>(null);
  const [scoreCanvasHeight, setScoreCanvasHeight] = useState(0);
  useEffect(() => {
    const el = scoreCanvasRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setScoreCanvasHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [canvasLayout]);
  const scorePlotY: PlotYGeometry = useMemo(
    () => computePlotYGeometry(scoreCanvasHeight),
    [scoreCanvasHeight],
  );
  /** 曲线层使用的纵向几何：叠加视图跟随视频画布，谱面视图跟随读谱区谱面。 */
  const activePlotY = canvasLayout === 'sheet' ? scorePlotY : plotY;

  const [followPlayhead, setFollowPlayhead] = useState(true);
  const followRef = useRef(true);
  followRef.current = followPlayhead;
  useEffect(() => {
    return playheadStore.subscribe((ms) => {
      if (!followRef.current) return;
      const current = viewRef.current;
      if (ms > current.viewEndMs || ms < current.viewStartMs) {
        const span = Math.max(1, current.viewEndMs - current.viewStartMs);
        const next = pageForwardRange(ms, span, durationMs);
        viewRef.current = { ...current, ...next };
        setView(viewRef.current);
      }
    });
  }, [playheadStore, durationMs]);

  const handleUserPan = useCallback(() => {
    if (followRef.current) {
      followRef.current = false;
      setFollowPlayhead(false);
    }
  }, []);
  const handleBackToPlayhead = useCallback(() => {
    const current = viewRef.current;
    const span = Math.max(1, current.viewEndMs - current.viewStartMs);
    const ms = playheadStore.get();
    const next = pageForwardRange(ms + span / 2, span, durationMs);
    followRef.current = true;
    setFollowPlayhead(true);
    updateView(next);
  }, [durationMs, playheadStore, updateView]);
  const handleTimeRangeChange = useCallback((range: TimeRange) => {
    updateView({ viewStartMs: range.viewStartMs, viewEndMs: range.viewEndMs });
  }, [updateView]);
  const handleScrubStart = useCallback(() => controller.pause(), [controller]);

  /* ---------------- 内容提交 ---------------- */
  const commit = useCallback(
    (patch: OutputPatch, coalesceKey?: string) => {
      onContentChange(patch as ProjectContentPatch, coalesceKey);
    },
    [onContentChange],
  );

  const seekTo = useCallback(
    (timeMs: number) => {
      controller.pause();
      controller.seekTo(timeMs, { final: true });
    },
    [controller],
  );

  /** 节点在视口外时自动平移使其可见，但不改变当前缩放比例（规格 5.1 第 7 条）。 */
  const ensureTimeVisible = useCallback(
    (timeMs: number) => {
      const current = viewRef.current;
      if (timeMs >= current.viewStartMs && timeMs <= current.viewEndMs) {
        return;
      }
      const span = Math.max(1, current.viewEndMs - current.viewStartMs);
      const next = pageForwardRange(timeMs, span, durationMs);
      viewRef.current = { ...current, ...next };
      setView(viewRef.current);
      onViewChangeRef.current(viewRef.current);
    },
    [durationMs],
  );

  const deleteSelected = useCallback(() => {
    if (selectedAnnotationId !== null) {
      commit({ annotations: removeAnnotation(annotations, selectedAnnotationId) });
      setSelectedAnnotationId(null);
      return;
    }
    if (selectedNodeIds.length === 0) return;
    let next: CurveNode[] = curve.nodes.map((node) => ({ ...node }));
    for (const id of selectedNodeIds) next = removeNode(next, id);
    if (next.length !== curve.nodes.length) {
      commit({ curve: { ...curve, nodes: next } });
      setSelectedNodeIds([]);
    }
  }, [selectedAnnotationId, selectedNodeIds, annotations, curve, commit]);


  const addNoteAtPlayhead = useCallback(() => {
    controller.pause();

    const time = Math.round(clamp(playheadStore.get(), 0, durationMs));
    const result = addAnnotation(annotations, time, `note-${Date.now()}`, { x: 12, y: -16 });
    commit({ annotations: result.annotations });
    const created = result.created ? result.annotations.find((a) => a.timeMs === time) : result.existing;
    setSelectedAnnotationId(created?.id ?? null);
    setSelectedNodeIds([]);
    setSelectedBoundaryId(null);
    setSelectedSectionId(null);
    setSelectedStructureId(null);
  }, [controller, playheadStore, durationMs, annotations, commit]);

  /** Q：在播放头添加曲线节点（取曲线当前值，形状不变），并选中。 */
  const addNodeAtPlayhead = useCallback(() => {
    controller.pause();
    const time = Math.round(clamp(playheadStore.get(), 0, durationMs));
    const existing = curve.nodes.find((node) => Math.abs(node.timeMs - time) <= 1);
    if (existing !== undefined) {
      setSelectedNodeIds([existing.id]);
      setSelectedAnnotationId(null);
      setSelectedBoundaryId(null);
      setSelectedSectionId(null);
      setSelectedStructureId(null);
      return;
    }
    const value = Math.round(clamp(createCurveEvaluator(curve.nodes).at(time), 0, 100));
    const next = insertNodeWithValue(curve.nodes, time, value, `node-${Date.now()}`);
    if (next.length === curve.nodes.length) {
      return;
    }
    commit({ curve: { ...curve, nodes: next } });
    const inserted = next.find((node) => !curve.nodes.some((old) => old.id === node.id));
    setSelectedNodeIds(inserted !== undefined ? [inserted.id] : []);
    setSelectedAnnotationId(null);
    setSelectedBoundaryId(null);
    setSelectedSectionId(null);
    setSelectedStructureId(null);
  }, [controller, playheadStore, durationMs, curve, commit]);

  /** E：在播放头创建段落边界并选中新段落；距离过近时定位并选中原边界。 */
  const addSectionAtPlayhead = useCallback(() => {
    controller.pause();
    const time = Math.round(clamp(playheadStore.get(), 0, durationMs));
    const result = addBoundary(
      boundaries,
      sections,
      time,
      `boundary-${Date.now()}`,
      `section-${Date.now()}`,
      durationMs,
    );
    if (!result.ok) {
      const near = boundaries.find((b) => !b.fixed && Math.abs(b.timeMs - time) < 100);
      if (near !== undefined) {
        setSelectedBoundaryId(near.id);
        setSelectedNodeIds([]);
        setSelectedAnnotationId(null);
        setSelectedSectionId(null);
        setSelectedStructureId(null);
      }
      setToolNotice(result.message ?? '无法在此添加分段。');
      return;
    }
    commit({ boundaries: result.boundaries, sections: result.sections });
    const created = result.sections.find((s) => !sections.some((old) => old.id === s.id));
    if (created !== undefined) {
      setSelectedSectionId(created.id);
      const owner = result.boundaries.find((b) => b.id === created.startBoundaryId);
      setSelectedBoundaryId(owner !== undefined ? owner.id : null);
    }
    setSelectedNodeIds([]);
    setSelectedAnnotationId(null);
    setSelectedStructureId(null);
  }, [controller, playheadStore, durationMs, boundaries, sections, commit]);

  /* ---------------- 三级结构编辑（章节 / 段落 / 镜头） ---------------- */

  const selectStructure = useCallback((id: string | null) => {
    setSelectedStructureId(id);
    if (id !== null) {
      setSelectedNodeIds([]);
      setSelectedAnnotationId(null);
      setSelectedBoundaryId(null);
      setSelectedSectionId(null);
      // 选中结构优先于时间范围选区：清除过期的选区，避免目标歧义。
      setRangeSelection(null);
    }
  }, []);

  /** 在播放头拆分指定结构（拆分点自动吸附到下级边界）。 */
  const splitStructureAt = useCallback(
    (nodeId: string) => {
      controller.pause();
      const raw = Math.round(clamp(playheadStore.get(), 0, durationMs));
      const snapped = nearestChildBoundary(structure, nodeId, raw, durationMs);
      const result = splitNode(structure, nodeId, snapped, `structure-${Date.now()}`, durationMs);
      if (!result.ok) {
        setToolNotice(result.message ?? '无法在此拆分当前结构。');
        return;
      }
      commit({ structure: result.structure });
      const created = result.structure.find((n) => !structure.some((old) => old.id === n.id));
      if (created !== undefined) {
        setSelectedStructureId(created.id);
      }
      setToolNotice(`已拆分层级；${PLATFORM.formatBinding('mod+z')} 撤销。`);
    },
    [controller, playheadStore, durationMs, structure, commit],
  );

  /** 删除起始边界：合并到左侧同级结构（备注用分隔符并入，不静默丢失）。 */
  const mergeStructure = useCallback(
    (nodeId: string) => {
      const node = structure.find((n) => n.id === nodeId);
      const siblings = node !== undefined ? childrenOf(structure, node.parentId, node.level) : [];
      const index = siblings.findIndex((n) => n.id === nodeId);
      const leftId = index > 0 ? siblings[index - 1]!.id : null;
      const result = mergeNode(structure, nodeId, durationMs);
      if (!result.ok) {
        setToolNotice(result.message ?? '无法合并该结构。');
        return;
      }
      commit({ structure: result.structure });
      setSelectedStructureId(leftId);
      setToolNotice(`已合并相邻结构；${PLATFORM.formatBinding('mod+z')} 撤销。`);
    },
    [structure, durationMs, commit],
  );

  /** 把选中结构的代表帧设为当前播放头位置。 */
  const setCoverAtPlayhead = useCallback(
    (id: string) => {
      const time = Math.round(clamp(playheadStore.get(), 0, durationMs));
      const result = updateStructureNode(structure, id, { coverTimeMs: time });
      if (!result.ok) {
        setToolNotice(result.message ?? '无法设置代表帧。');
        return;
      }
      commit({ structure: result.structure });
    },
    [structure, durationMs, playheadStore, commit],
  );

  /** R / G 与 ⇧R / ⇧G：进入绘制工具（sustained 表示持续绘制）。 */
  const startDrawing = useCallback(
    (nextTool: ToolId, sustained: boolean) => {
      controller.pause();
      setTool(nextTool);
      setDrawSustained(sustained);
    },
    [controller],
  );

  /** 一次性绘制提交后自动回到智能选择；持续绘制保持工具。 */
  const handleDrawComplete = useCallback(() => {
    if (!drawSustained) {
      setTool('select');
    }
  }, [drawSustained]);

  /** 1 / 2 / 3：把选中节点所在段设为自动平滑 / 直线 / 贝塞尔。 */
  const applyCurveMode = useCallback(
    (mode: 'auto' | 'linear' | 'bezier') => {
      if (selectedNodeIds.length === 0) {
        return;
      }
      const first = curve.nodes.find((node) => node.id === selectedNodeIds[0]);
      if (first === undefined) {
        return;
      }
      const index = curve.nodes.findIndex((node) => node.id === first.id);
      const segment = Math.min(index, curve.nodes.length - 2);
      if (segment < 0) {
        return;
      }
      commit({ curve: { ...curve, nodes: setSegmentOutMode(curve.nodes, segment, mode) } }, 'curve-mode');
      const label = mode === 'auto' ? '自动平滑' : mode === 'linear' ? '直线' : '贝塞尔';
      setToolNotice(`曲线段：${label}`);
    },
    [curve, selectedNodeIds, commit],
  );

  /** , / .：选中节点沿时间轴前后微调（时间方向）。 */
  const nudgeSelectedNodes = useCallback(
    (dTimeMs: number) => {
      if (selectedNodeIds.length === 0) {
        return;
      }
      const result = moveNodes(curve.nodes, selectedNodeIds, dTimeMs, 0);
      if (result.appliedTimeMs === 0) {
        return;
      }
      commit({ curve: { ...curve, nodes: result.nodes } }, 'node-nudge-time');
    },
    [curve, selectedNodeIds, commit],
  );

  /** ⌥↑ / ⌥↓：选中节点数值增减。 */
  const nudgeSelectedValue = useCallback(
    (dValue: number) => {
      if (selectedNodeIds.length === 0) {
        return;
      }
      const result = moveNodes(curve.nodes, selectedNodeIds, 0, dValue);
      if (result.appliedValue === 0) {
        return;
      }
      commit({ curve: { ...curve, nodes: result.nodes } }, 'node-nudge-value');
    },
    [curve, selectedNodeIds, commit],
  );

  /** ⌘A：选择当前时间范围内全部曲线节点。 */
  const selectAllInView = useCallback(() => {
    const ids = curve.nodes
      .filter((node) => node.timeMs >= view.viewStartMs && node.timeMs <= view.viewEndMs)
      .map((node) => node.id);
    setSelectedNodeIds(ids);
    setSelectedAnnotationId(null);
    setSelectedBoundaryId(null);
    setSelectedSectionId(null);
  }, [curve.nodes, view.viewStartMs, view.viewEndMs]);

  /* ---------------- 分析监视器样式（第一阶段） ---------------- */
  const applyStylePreset = useCallback(
    (id: StylePresetId) => {
      const preset = STYLE_PRESETS[id];
      commit({ style: preset.style, curve: { ...curve, color: preset.curveColor } }, 'style-preset');
    },
    [curve, commit],
  );

  const patchStyle = useCallback(
    (patch: PartialProjectStyle) => {
      const next: ProjectStyle = {
        preset: patch.preset ?? style.preset,
        curve: { ...style.curve, ...patch.curve },
        node: { ...style.node, ...patch.node },
        annotation: { ...style.annotation, ...patch.annotation },
        grid: { ...style.grid, ...patch.grid },
      };
      commit({ style: next }, 'style-tune');
    },
    [style, commit],
  );

  const setCurveColor = useCallback(
    (color: string) => {
      commit({ curve: { ...curve, color } }, 'curve-color');
    },
    [curve, commit],
  );

  const toggleGrid = useCallback(() => {
    patchStyle({ grid: { ...style.grid, visible: !style.grid.visible } });
  }, [patchStyle, style.grid]);

  const toggleFullscreen = useCallback(() => {
    const doc = document;
    if (doc.fullscreenElement) {
      void doc.exitFullscreen();
    } else {
      void doc.documentElement.requestFullscreen?.();
    }
  }, []);

  /* ---------------- 快捷键（v1.1 需求 6） ---------------- */
  const { keymap, isMac, conflicts, rebind, resetCommand, resetAll } = useKeymap();
  const [helpOpen, setHelpOpen] = useState(false);
  const helpOpenRef = useRef(false);
  helpOpenRef.current = helpOpen;

  /** 单帧时长（毫秒）：优先视频声明帧率，不可信时回退 30fps。 */
  const frameMs = useMemo(() => {
    const { num, den } = snapshot.media.avgFrameRate;
    if (num > 0 && den > 0) {
      const fps = num / den;
      if (Number.isFinite(fps) && fps > 0) {
        return 1000 / fps;
      }
    }
    return 1000 / 30;
  }, [snapshot.media.avgFrameRate]);


  /** 以播放头为锚点（越界时用视口中心）缩放时间线。 */
  const zoomBy = useCallback(
    (factor: number) => {
      const current = viewRef.current;
      const span = Math.max(1, current.viewEndMs - current.viewStartMs);
      const nextSpan = clamp(span * factor, Math.min(200, durationMs), durationMs);
      if (Math.round(nextSpan) === Math.round(span)) {
        return;
      }
      const head = playheadStore.get();
      const inView = head >= current.viewStartMs && head <= current.viewEndMs;
      const anchorMs = inView ? head : (current.viewStartMs + current.viewEndMs) / 2;
      const ratio = inView ? (head - current.viewStartMs) / span : 0.5;
      const start = anchorMs - nextSpan * ratio;
      const range = clampViewRange(start, start + nextSpan, durationMs, 1);
      updateView({
        viewStartMs: Math.round(range.viewStartMs),
        viewEndMs: Math.round(range.viewEndMs),
      });
    },
    [durationMs, playheadStore, updateView],
  );

  const fitAll = useCallback(() => {
    updateView({ viewStartMs: 0, viewEndMs: durationMs });
  }, [durationMs, updateView]);

  /** ↑ / ↓ 与 ⌥A / ⌥D：跳到上一个 / 下一个分析点（节点 / 标注 / 边界），并选中。 */
  const goToMark = useCallback(
    (direction: 1 | -1) => {
      const head = playheadStore.get();
      const points = [
        ...curve.nodes.map((node) => ({ time: node.timeMs, kind: 'node' as const, id: node.id })),
        ...annotations.map((a) => ({ time: a.timeMs, kind: 'annotation' as const, id: a.id })),
        ...boundaries.map((b) => ({ time: b.timeMs, kind: 'boundary' as const, id: b.id })),
      ].sort((a, b) => a.time - b.time);
      let target: (typeof points)[number] | undefined;
      if (direction > 0) {
        target = points.find((p) => p.time > head + 1);
      } else {
        for (let i = points.length - 1; i >= 0; i--) {
          const p = points[i];
          if (p !== undefined && p.time < head - 1) {
            target = p;
            break;
          }
        }
      }
      if (target === undefined) {
        return;
      }
      seekTo(target.time);
      ensureTimeVisible(target.time);
      if (target.kind === 'node') {
        setSelectedNodeIds([target.id]);
        setSelectedAnnotationId(null);
        setSelectedBoundaryId(null);
        setSelectedSectionId(null);
      } else if (target.kind === 'annotation') {
        setSelectedAnnotationId(target.id);
        setSelectedNodeIds([]);
        setSelectedBoundaryId(null);
        setSelectedSectionId(null);
      } else {
        setSelectedBoundaryId(target.id);
        setSelectedNodeIds([]);
        setSelectedAnnotationId(null);
        setSelectedSectionId(null);
      }
    },
    [curve.nodes, annotations, boundaries, playheadStore, seekTo, ensureTimeVisible],
  );

  /** ⇧M / ⌘⇧M：跳到下一条 / 上一条标注（仅标注），并选中。 */
  const goToAnnotation = useCallback(
    (direction: 1 | -1) => {
      const head = playheadStore.get();
      const times = annotations.map((annotation) => annotation.timeMs).sort((a, b) => a - b);
      const target =
        direction > 0
          ? times.find((time) => time > head + 1)
          : [...times].reverse().find((time) => time < head - 1);
      if (target === undefined) {
        return;
      }
      seekTo(target);
      ensureTimeVisible(target);
      const annotation = annotations.find((a) => a.timeMs === target);
      if (annotation !== undefined) {
        setSelectedAnnotationId(annotation.id);
        setSelectedNodeIds([]);
        setSelectedBoundaryId(null);
        setSelectedSectionId(null);
      }
    },
    [annotations, playheadStore, seekTo, ensureTimeVisible],
  );

  const setPlaybackRate = useCallback(
    (rate: number) => updateView({ playbackRate: clamp(rate, 0.5, 2) }),
    [updateView],
  );

  /* ---------------- 智能镜头识别（硬切检测） ---------------- */
  const [shotPanelOpen, setShotPanelOpen] = useState(false);
  const shotMenuRootRef = useRef<HTMLDivElement | null>(null);
  const [shotPreset, setShotPreset] = useState<ShotSensitivityId>(DEFAULT_SHOT_PRESET);
  const [shotMinShotMs, setShotMinShotMs] = useState<number>(DEFAULT_MIN_SHOT_MS);
  const [shotTaskId, setShotTaskId] = useState<string | null>(null);
  const [shotRunning, setShotRunning] = useState(false);
  const [shotStep, setShotStep] = useState<string | null>(null);
  const [shotCuts, setShotCuts] = useState<DetectedCut[]>([]);
  const [shotMessage, setShotMessage] = useState<string | null>(null);

  /* —— 局部（选中区域）智能分镜：只分析选区，结果进入镜头层 —— */
  const [rangeSelection, setRangeSelection] = useState<{ startMs: number; endMs: number } | null>(null);
  const [shotRangeTaskId, setShotRangeTaskId] = useState<string | null>(null);
  const [pendingShotRun, setPendingShotRun] = useState<ShotTarget | null>(null);
  const shotRangeRequestRef = useRef<{ target: ShotTarget; strategy: ShotStrategy } | null>(null);

  /** 当前识别目标：优先时间范围选区，其次选中的章节/段落；无合法选区时给出提示。 */
  const shotTargetResult = useMemo(
    () =>
      resolveShotTarget(
        structure,
        durationMs,
        rangeSelection !== null
          ? { kind: 'range', startMs: rangeSelection.startMs, endMs: rangeSelection.endMs }
          : selectedStructureId !== null
            ? { kind: 'node', id: selectedStructureId }
            : null,
      ),
    [structure, durationMs, rangeSelection, selectedStructureId],
  );
  const shotTarget = shotTargetResult.target ?? null;

  const shotThreshold = useMemo(
    () => SHOT_PRESETS.find((preset) => preset.id === shotPreset)?.threshold ?? 10,
    [shotPreset],
  );

  /** 候选切点（已滤除与现有手动/锁定边界相距 <100ms 的重复项），升序。 */
  const candidateCutTimes = useMemo(
    () => filterCandidateTimes(boundaries, shotCuts.map((cut) => cut.timeMs)),
    [boundaries, shotCuts],
  );

  useEffect(() => {
    if (!shotPanelOpen) return undefined;
    const onDocPointerDown = (e: PointerEvent) => {
      const root = shotMenuRootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) setShotPanelOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [shotPanelOpen]);

  // 订阅镜头识别任务事件：进度 / 成功（读取缓存结果）/ 取消 / 失败。
  useEffect(() => {
    const api = window.laipian;
    if (!api || shotTaskId === null) return undefined;
    return api.tasks.subscribe((event) => {
      if (event.taskId !== shotTaskId) return;
      if (event.status === 'running') {
        setShotRunning(true);
        setShotStep(event.progress?.kind === 'step' ? event.progress.step : '正在识别镜头');
        return;
      }
      if (event.status === 'succeeded') {
        setShotRunning(false);
        setShotStep(null);
        setShotTaskId(null);
        void api.media
          .readDetectedCuts({ projectId: snapshot.id, threshold: shotThreshold, minShotMs: shotMinShotMs })
          .then((result) => {
            if (!result.ok) {
              setShotMessage(`读取识别结果失败：${result.error.message}`);
              return;
            }
            const cuts = result.data ?? [];
            setShotCuts(cuts);
            setShotMessage(
              cuts.length === 0
                ? '未识别到硬切镜头；可改用更灵敏的档位，或该视频本身没有明显硬切。'
                : `识别到 ${cuts.length} 个候选切点，可点击时间线上的小点删除误判，再“应用结果”。`,
            );
          });
        return;
      }
      setShotRunning(false);
      setShotStep(null);
      setShotTaskId(null);
      setShotMessage(
        event.status === 'cancelled' ? '已取消识别。' : (event.message ?? '识别失败。'),
      );
    });
  }, [shotTaskId, shotThreshold, shotMinShotMs, snapshot.id]);

  const startShotDetect = useCallback(() => {
    const api = window.laipian;
    if (!api) {
      setShotMessage('浏览器预览模式不支持镜头识别。');
      return;
    }
    setShotMessage(null);
    setShotStep('正在识别镜头');
    setShotRunning(true);
    void api.media
      .detectShots({ projectId: snapshot.id, threshold: shotThreshold, minShotMs: shotMinShotMs })
      .then((result) => {
        if (!result.ok) {
          setShotRunning(false);
          setShotStep(null);
          setShotMessage(`启动识别失败：${result.error.message}`);
          return;
        }
        setShotTaskId(result.data.taskId);
      })
      .catch(() => {
        setShotRunning(false);
        setShotStep(null);
        setShotMessage('启动识别失败。');
      });
  }, [snapshot.id, shotThreshold, shotMinShotMs]);

  const cancelShotDetect = useCallback(() => {
    const api = window.laipian;
    if (!api) {
      return;
    }
    if (shotRangeTaskId !== null) {
      void api.tasks.cancel({ taskId: shotRangeTaskId });
    } else if (shotTaskId !== null) {
      void api.tasks.cancel({ taskId: shotTaskId });
    }
  }, [shotTaskId, shotRangeTaskId]);

  const removeCandidate = useCallback((timeMs: number) => {
    setShotCuts((prev) => prev.filter((cut) => cut.timeMs !== timeMs));
  }, []);

  const handleApplyShots = useCallback(() => {
    const result = applyShotCuts(
      boundaries,
      sections,
      candidateCutTimes,
      durationMs,
      Date.now().toString(36),
    );
    if (result.appliedCount === 0) {
      setShotMessage('没有可应用的候选切点（可能都与现有分段重复）。');
      return;
    }
    commit({ boundaries: result.boundaries, sections: result.sections });
    setShotCuts([]);
    setShotPanelOpen(false);
    setShotMessage(`已应用 ${result.appliedCount} 个镜头分段（可一次撤销回退）。`);
  }, [boundaries, sections, candidateCutTimes, durationMs, commit]);

  /* —— 局部智能分镜：检测结果 → 生成镜头（一次提交，一条撤销记录） —— */
  const applyShotRangePlan = useCallback(
    (cuts: DetectedCut[]) => {
      const request = shotRangeRequestRef.current;
      if (request === null) {
        setShotRunning(false);
        setShotStep(null);
        setShotRangeTaskId(null);
        return;
      }
      let next = structure;
      let totalShots = 0;
      let detectedCount = 0;
      let changed = false;
      const idSeed = `sd${Date.now().toString(36)}`;
      for (const sectionTarget of request.target.sections) {
        const sectionCuts = cuts
          .filter((cut) => cut.timeMs > sectionTarget.startMs && cut.timeMs < sectionTarget.endMs)
          .map((cut) => cut.timeMs);
        const result = planShotsInRange({
          structure: next,
          durationMs,
          parentId: sectionTarget.id,
          startMs: sectionTarget.startMs,
          endMs: sectionTarget.endMs,
          cutTimes: sectionCuts,
          strategy: request.strategy,
          idSeed: `${idSeed}-${sectionTarget.id}`,
        });
        if (!result.ok) {
          shotRangeRequestRef.current = null;
          setShotRunning(false);
          setShotStep(null);
          setShotRangeTaskId(null);
          setShotMessage(result.message ?? '识别失败。');
          return;
        }
        next = result.structure;
        totalShots += result.shotCount;
        detectedCount += result.detectedCount;
        changed = changed || result.didChange;
      }
      shotRangeRequestRef.current = null;
      setShotRunning(false);
      setShotStep(null);
      setShotRangeTaskId(null);

      if (!changed) {
        setShotMessage('该区域未检测到明显硬切，已保留为一个镜头。');
        return;
      }
      // 整次生成作为一个撤销操作；视图状态与结构同批保存。
      commit({ structure: next });
      const firstSection = request.target.sections[0];
      if (firstSection !== undefined) {
        const firstShot = childrenOf(next, firstSection.id, 'shot')[0];
        if (firstShot !== undefined) {
          setSelectedStructureId(firstShot.id);
        }
        setRangeSelection(null);
      }
      const areaName = request.target.label.split(' · ')[0] ?? '选中区域';
      const message =
        detectedCount === 0
          ? '该区域未检测到明显硬切，已保留为一个镜头。'
          : `已在“${areaName}”中识别出 ${totalShots} 个镜头。`;
      setShotMessage(message);
      feedbackStore.pushToast({
        kind: 'success',
        message,
        action: { label: '撤销', run: () => onUndo() },
      });
    },
    [structure, durationMs, commit, onUndo],
  );

  // 订阅局部识别任务：进度 / 成功（读取范围缓存结果后生成镜头）/ 取消 / 失败。
  useEffect(() => {
    const api = window.laipian;
    if (!api || shotRangeTaskId === null) return undefined;
    return api.tasks.subscribe((event) => {
      if (event.taskId !== shotRangeTaskId) return;
      if (event.status === 'running') {
        setShotRunning(true);
        setShotStep(event.progress?.kind === 'step' ? event.progress.step : '正在分析选中区域');
        return;
      }
      if (event.status === 'succeeded') {
        const request = shotRangeRequestRef.current;
        setShotStep('整理切点');
        void api.media
          .readDetectedCutsRange({
            projectId: snapshot.id,
            threshold: shotThreshold,
            minShotMs: shotMinShotMs,
            inMs: request?.target.rangeStartMs ?? 0,
            outMs: request?.target.rangeEndMs ?? 0,
          })
          .then((result) => {
            if (!result.ok) {
              shotRangeRequestRef.current = null;
              setShotRunning(false);
              setShotStep(null);
              setShotRangeTaskId(null);
              setShotMessage(`读取识别结果失败：${result.error.message}`);
              return;
            }
            applyShotRangePlan(result.data ?? []);
          })
          .catch(() => {
            shotRangeRequestRef.current = null;
            setShotRunning(false);
            setShotStep(null);
            setShotRangeTaskId(null);
            setShotMessage('读取识别结果失败。');
          });
        return;
      }
      // 取消 / 失败：不产生任何镜头修改，可重新运行。
      shotRangeRequestRef.current = null;
      setShotRunning(false);
      setShotStep(null);
      setShotRangeTaskId(null);
      setShotMessage(event.status === 'cancelled' ? '已取消识别。' : (event.message ?? '识别失败。'));
    });
  }, [shotRangeTaskId, snapshot.id, shotThreshold, shotMinShotMs, applyShotRangePlan]);

  const startShotRange = useCallback(
    (target: ShotTarget, strategy: ShotStrategy) => {
      const api = window.laipian;
      if (!api) {
        setShotMessage('浏览器预览模式不支持镜头识别。');
        return;
      }
      shotRangeRequestRef.current = { target, strategy };
      setPendingShotRun(null);
      setShotMessage(null);
      setShotStep('正在分析选中区域');
      setShotRunning(true);
      void api.media
        .detectShotsRange({
          projectId: snapshot.id,
          threshold: shotThreshold,
          minShotMs: shotMinShotMs,
          inMs: target.rangeStartMs,
          outMs: target.rangeEndMs,
        })
        .then((result) => {
          if (!result.ok) {
            shotRangeRequestRef.current = null;
            setShotRunning(false);
            setShotStep(null);
            setShotMessage(`启动识别失败：${result.error.message}`);
            return;
          }
          setShotRangeTaskId(result.data.taskId);
        })
        .catch(() => {
          shotRangeRequestRef.current = null;
          setShotRunning(false);
          setShotStep(null);
          setShotMessage('启动识别失败。');
        });
    },
    [snapshot.id, shotThreshold, shotMinShotMs],
  );

  /** 请求对目标运行分镜：已有可编辑镜头时先让用户选择合并策略。 */
  const requestShotRun = useCallback(
    (target: ShotTarget) => {
      const editable = countEditableShots(structure, target);
      if (editable > 0) {
        setPendingShotRun(target);
        return;
      }
      startShotRange(target, 'replace-auto');
    },
    [structure, startShotRange],
  );

  /** 结构面板 / 时间线右键入口：对某个章节或段落运行局部智能分镜。 */
  const runShotForStructureNode = useCallback(
    (id: string) => {
      const resolved = resolveShotTarget(structure, durationMs, { kind: 'node', id });
      if (!resolved.ok || resolved.target === undefined) {
        setToolNotice(resolved.message ?? '无法识别该区域。');
        return;
      }
      setSelectedStructureId(id);
      setRangeSelection(null);
      requestShotRun(resolved.target);
    },
    [structure, durationMs, requestShotRun],
  );

  /* ---------------- 键盘（v1.1 需求 6：可自定义快捷键） ---------------- */
  const deleteRef = useRef(deleteSelected);
  deleteRef.current = deleteSelected;
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;

  /** 滚轮意图：按当前键位匹配「滚轮缩放 / 滚轮平移」命令（供时间线使用）。 */
  const resolveWheelIntent = useCallback(
    (event: WheelEvent): 'zoom' | 'pan' | null => {
      const id = commandForWheel(keymapRef.current, event, isMac);
      if (id === 'timeline.wheelZoom') {
        return 'zoom';
      }
      if (id === 'timeline.wheelPan') {
        return 'pan';
      }
      // Control / Command + 滚轮（即便同时按 Shift）仍以缩放为优先（规格通用习惯）。
      if (event.ctrlKey || event.metaKey) {
        return 'zoom';
      }
      // 触控板双指左右滑动（无修饰、以水平位移为主）→ 平移。
      if (!event.shiftKey && !event.altKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        return 'pan';
      }
      return null;
    },
    [isMac],
  );

  // 阻止 Ctrl/Command + 滚轮触发浏览器页面缩放（时间线已处理时其自身会 preventDefault）。
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.defaultPrevented) {
        event.preventDefault();
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  /** 命令分发：每次渲染刷新为最新闭包，effect 内通过 ref 调用（避免反复重订阅）。 */
  const commandRef = useRef<(id: CommandId) => void>(() => undefined);
  commandRef.current = (id: CommandId) => {
    switch (id) {
      case 'play.toggle':
        controller.togglePlay();
        break;
      case 'play.pause':
        controller.pause();
        setPlaybackRate(1);
        break;
      case 'play.forward': {
        if (controller.playing) {
          const rates: readonly number[] = PLAYBACK_RATES;
          const index = rates.indexOf(view.playbackRate);
          const next = index >= 0 && index < rates.length - 1 ? rates[index + 1] : rates[0];
          if (next !== undefined) {
            setPlaybackRate(next);
          }
        } else {
          controller.play();
        }
        break;
      }
      case 'play.reverse':
        // J：反向播放暂不稳定，按规格降级为逐帧后退（连续按即连续退）。
        controller.stepBy(-frameMs);
        break;
      case 'play.prevFrame':
      case 'left.prevFrame':
        controller.stepBy(-frameMs);
        break;
      case 'play.nextFrame':
      case 'left.nextFrame':
        controller.stepBy(frameMs);
        break;
      case 'play.prev5':
      case 'left.prev5':
        controller.stepBy(-5 * frameMs);
        break;
      case 'play.next5':
      case 'left.next5':
        controller.stepBy(5 * frameMs);
        break;
      case 'nav.start':
        seekTo(0);
        break;
      case 'nav.end':
        seekTo(durationMs);
        break;
      case 'nav.prevMark':
      case 'left.prevMark':
        goToMark(-1);
        break;
      case 'nav.nextMark':
      case 'left.nextMark':
        goToMark(1);
        break;
      case 'mark.add':
      case 'mark.addAlt':
        addNoteAtPlayhead();
        break;
      case 'mark.next':
        goToAnnotation(1);
        break;
      case 'mark.prev':
        goToAnnotation(-1);
        break;
      case 'node.add':
        addNodeAtPlayhead();
        break;
      case 'section.add':
        // 选中三级结构时，E = 在播放头拆分当前层级；否则沿用旧分段行为。
        if (selectedStructureId !== null) {
          splitStructureAt(selectedStructureId);
        } else {
          addSectionAtPlayhead();
        }
        break;
      case 'tool.select':
        setTool('select');
        setDrawSustained(false);
        break;
      case 'draw.freehandOnce':
        startDrawing('freehand', false);
        break;
      case 'draw.lineOnce':
        startDrawing('line', false);
        break;
      case 'draw.freehandHold':
        startDrawing('freehand', true);
        break;
      case 'draw.lineHold':
        startDrawing('line', true);
        break;
      case 'curve.auto':
        applyCurveMode('auto');
        break;
      case 'curve.linear':
        applyCurveMode('linear');
        break;
      case 'curve.bezier':
        applyCurveMode('bezier');
        break;
      case 'node.stepPrev':
        nudgeSelectedNodes(-frameMs);
        break;
      case 'node.stepNext':
        nudgeSelectedNodes(frameMs);
        break;
      case 'node.stepPrev5':
        nudgeSelectedNodes(-5 * frameMs);
        break;
      case 'node.stepNext5':
        nudgeSelectedNodes(5 * frameMs);
        break;
      case 'node.valueUp':
        nudgeSelectedValue(1);
        break;
      case 'node.valueDown':
        nudgeSelectedValue(-1);
        break;
      case 'node.valueUp5':
        nudgeSelectedValue(5);
        break;
      case 'node.valueDown5':
        nudgeSelectedValue(-5);
        break;
      case 'edit.delete':
        // 选中三级结构时，Delete = 删除起始边界并合并到左侧；否则删除标注/节点。
        if (selectedStructureId !== null) {
          mergeStructure(selectedStructureId);
        } else {
          deleteSelected();
        }
        break;
      case 'edit.escape':
        setSelectedNodeIds([]);
        setSelectedAnnotationId(null);
        setSelectedBoundaryId(null);
        setSelectedSectionId(null);
        setSelectedStructureId(null);
        setTool('select');
        setDrawSustained(false);
        setExportOpen(false);
        setLayersOpen(false);
        setHelpOpen(false);
        break;
      case 'edit.selectAll':
        selectAllInView();
        break;
      case 'timeline.zoomIn':
      case 'timeline.zoomInAlt':
        zoomBy(1 / 1.4);
        break;
      case 'timeline.zoomOut':
        zoomBy(1.4);
        break;
      case 'timeline.fit':
        fitAll();
        break;
      case 'timeline.follow':
        handleBackToPlayhead();
        break;
      case 'file.undo':
        onUndo();
        break;
      case 'file.redo':
        onRedo();
        break;
      case 'file.save':
        onSaveRequested?.();
        break;
      case 'help.shortcuts':
        setHelpOpen(true);
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (helpOpenRef.current) {
        return; // 速查面板打开时由面板接管键盘（Esc 关闭、录制改键）。
      }
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        // 文字输入态（规格八）：单字母快捷键暂停；仅放行保存与「完成输入」。
        const modKey = isMac ? e.metaKey : e.ctrlKey;
        if (e.key === 'Escape') {
          target.blur();
          return;
        }
        if (modKey && e.key.toLowerCase() === 's') {
          e.preventDefault();
          commandRef.current('file.save');
          return;
        }
        if (modKey && e.key === 'Enter') {
          e.preventDefault();
          target.blur();
          return;
        }
        return;
      }
      if (e.isComposing) return;
      const id = commandForEvent(keymapRef.current, e, isMac);
      if (id === null) {
        // 退格键作为删除别名（默认仅绑 Delete，兼容常见习惯）。
        if (e.key === 'Backspace') {
          e.preventDefault();
          deleteRef.current();
        }
        return;
      }
      e.preventDefault();
      commandRef.current(id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMac]);

  /* ---------------- 图层面板（规格 4） ---------------- */
  const [layersOpen, setLayersOpen] = useState(false);
  const layersRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!layersOpen) return undefined;
    const onDocPointerDown = (e: PointerEvent) => {
      const root = layersRootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) setLayersOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [layersOpen]);

  const applyAnalysisPreset = useCallback(() => {
    updateView({ videoVisible: true, videoOpacity: 0.25, analysisVisible: true, analysisOpacity: 1 });
  }, [updateView]);

  const interactive = view.analysisVisible && view.analysisOpacity > 0 && !view.analysisLocked;

  // 主选节点：多选时取最后加入的选中节点（规格 5.1：多选需要一个主节点）。
  const primarySelectedNode = useMemo(() => {
    const primaryId = selectedNodeIds[selectedNodeIds.length - 1];
    return primaryId !== undefined ? curve.nodes.find((node) => node.id === primaryId) ?? null : null;
  }, [selectedNodeIds, curve.nodes]);
  const framePreview = useFramePreview({
    projectId: snapshot.id,
    timeMs: primarySelectedNode !== null ? primarySelectedNode.timeMs : null,
    width: FRAME_PREVIEW_WIDTH,
    height: FRAME_PREVIEW_HEIGHT,
    enabled: primarySelectedNode !== null,
  });

  const selectedAnnotation = annotations.find((a) => a.id === selectedAnnotationId) ?? null;
  const selectedSection =
    sections.find((s) => s.id === selectedSectionId) ??
    (selectedBoundaryId !== null
      ? sections.find((s) => s.startBoundaryId === selectedBoundaryId) ?? null
      : null);

  /** 底部状态提示（第十一点：按当前状态显示最相关的一组操作）。 */
  const hintText = useMemo(() => {
    if (selectedNodeIds.length > 0) {
      return '，/。 移动节点 · 1/2/3 曲线模式 · Delete 删除';
    }
    if (selectedAnnotationId !== null) {
      return `${PLATFORM.formatBinding('shift+m')} 下一条标注 · ${PLATFORM.formatBinding('mod+shift+m')} 上一条 · Delete 删除`;
    }
    if (selectedStructureId !== null) {
      return 'E 在播放头拆分当前层级 · Delete 合并到左侧 · 双击大纲改名';
    }
    if (selectedSectionId !== null || selectedBoundaryId !== null) {
      return 'E 添加分段 · 拖动边界调整 · Delete 删除';
    }
    return 'Space 播放 · A/D 逐帧 · Q 节点 · W 标注 · E 分段';
  }, [selectedNodeIds, selectedAnnotationId, selectedSectionId, selectedBoundaryId, selectedStructureId]);

  // 监视器只在焦点镜头附近显示"镜头识别边界"（选中 / 悬停 / 播放头所在镜头），
  // 其余大量镜头切点边界只保留在时间线（避免上百镜头把监视器画满竖线）。
  const structureFocusRange = useMemo(() => {
    const nodes = snapshot.structure ?? [];
    if (nodes.length === 0) {
      return null;
    }
    const ranges = deriveRanges(nodes, durationMs);
    const hovered = hoveredStructureId !== null ? findNode(nodes, hoveredStructureId) : undefined;
    if (hovered !== undefined && hovered.level === 'shot') {
      return ranges.get(hovered.id) ?? null;
    }
    const selected = selectedStructureId !== null ? findNode(nodes, selectedStructureId) : undefined;
    if (selected !== undefined && selected.level === 'shot') {
      return ranges.get(selected.id) ?? null;
    }
    const atPlayhead = resolveNodeAt(nodes, 'shot', view.playheadMs, durationMs);
    return atPlayhead !== null ? ranges.get(atPlayhead.id) ?? null : null;
  }, [snapshot.structure, hoveredStructureId, selectedStructureId, view.playheadMs, durationMs]);

  // 曲线层：叠加视图挂在视频画布上，谱面视图挂到读谱区的独立谱面（方案 §2 共用同一份）。
  const curveLayerElement = (
    <CurveLayer
      curve={curve}
      annotations={annotations}
      boundaries={boundaries}
      sections={sections}
      plotX={geometry}
      plotY={activePlotY}
      viewStartMs={view.viewStartMs}
      viewEndMs={view.viewEndMs}
      durationMs={durationMs}
      analysisVisible={view.analysisVisible}
      analysisOpacity={view.analysisOpacity}
      annotationsVisible={view.annotationsVisible}
      boundariesVisible={view.boundariesVisible}
      focusRange={structureFocusRange}
      locked={view.analysisLocked}
      tool={tool}
      selectedNodeIds={selectedNodeIds}
      selectedAnnotationId={selectedAnnotationId}
      selectedBoundaryId={selectedBoundaryId}
      selectedSectionId={selectedSectionId}
      onSelectNodes={(ids) => {
        setSelectedNodeIds(ids);
        if (ids.length > 0) {
          setSelectedAnnotationId(null);
          setSelectedBoundaryId(null);
          setSelectedSectionId(null);
          setSelectedStructureId(null);
          // 列表常驻右栏，无需关闭。
          // 单选节点即暂停并定位播放器，保证预览、右侧画面与主播放器同一帧（规格 5.1）。
          if (ids.length === 1) {
            const target = curve.nodes.find((node) => node.id === ids[0]);
            if (target) {
              controller.pause();
              controller.seekTo(target.timeMs, { final: true });
              ensureTimeVisible(target.timeMs);
            }
          }
        }
      }}
      onSelectAnnotation={(id) => {
        setSelectedAnnotationId(id);
        if (id !== null) {
          setSelectedNodeIds([]);
          setSelectedBoundaryId(null);
          setSelectedSectionId(null);
          setSelectedStructureId(null);
          // 列表常驻右栏，无需关闭。
          controller.pause();
          const target = annotations.find((a) => a.id === id);
          if (target) controller.seekTo(target.timeMs, { final: true });
        }
      }}
      onSelectBoundary={(id) => {
        setSelectedBoundaryId(id);
        if (id !== null) {
          setSelectedNodeIds([]);
          setSelectedAnnotationId(null);
          setSelectedSectionId(null);
          setSelectedStructureId(null);
          // 列表常驻右栏，无需关闭。
          const target = boundaries.find((b) => b.id === id);
          if (target) {
            controller.pause();
            controller.seekTo(target.timeMs, { final: true });
          }
        }
      }}
      onSelectSection={(id) => {
        setSelectedSectionId(id);
        if (id !== null) {
          setSelectedNodeIds([]);
          setSelectedAnnotationId(null);
          setSelectedBoundaryId(null);
          setSelectedStructureId(null);
          // 列表常驻右栏，无需关闭。
          const target = sections.find((s) => s.id === id);
          const boundary = target ? boundaries.find((b) => b.id === target.startBoundaryId) : undefined;
          if (boundary) {
            controller.pause();
            controller.seekTo(boundary.timeMs, { final: true });
          }
        }
      }}
      onCommit={commit}
      onRequestPause={controller.pause}
      onNotice={setToolNotice}
      onDrawComplete={handleDrawComplete}
      style={style}
      hideChrome={monitorMode === 'clean'}
    />
  );

  return (
    <div className={`lp-editor${splitterDragging || panelDragging ? ' is-resizing' : ''}`}>
      <header className="lp-topbar">
        <button type="button" className="lp-topbar-back" onClick={onClose} aria-label="返回项目库"><IconBack /><span>返回项目库</span></button>
        <div className="lp-topbar-title">
          <span className="lp-project-name">{snapshot.name}</span>
          {saveStatus && (
            <span className={`lp-save-status is-${saveStatus}`} role="status">
              {SAVE_STATE_LABELS[saveStatus]}
              {saveStatus === 'saved' && lastSavedAt !== null && lastSavedAt !== undefined
                ? ` · 最近保存 ${formatClockTime(lastSavedAt)}`
                : ''}
              {saveStatus === 'error' && onRetrySave !== undefined && (
                <button type="button" className="lp-save-retry" onClick={onRetrySave}>
                  重试
                </button>
              )}
            </span>
          )}
        </div>
        <div className="lp-topbar-actions">
          <button type="button" className="lp-topbar-button is-icon" disabled={!canUndo} data-tip="撤销（Cmd/Ctrl+Z）" aria-label="撤销" onClick={onUndo}><IconUndo /></button>
          <button type="button" className="lp-topbar-button is-icon" disabled={!canRedo} data-tip="重做（Cmd/Ctrl+Shift+Z）" aria-label="重做" onClick={onRedo}><IconRedo /></button>
          <button
            type="button"
            className={`lp-topbar-button is-icon${helpOpen ? ' is-active' : ''}`}
            onClick={() => setHelpOpen(true)}
            data-tip={`快捷键速查（${formatBinding(keymap['help.shortcuts'], isMac)}）`}
            aria-label="快捷键速查"
          >
            <IconKeyboard />
          </button>
        </div>
        <div className="lp-topbar-actions">
          <button
            type="button"
            className={`lp-topbar-button is-primary${exportOpen ? ' is-active' : ''}`}
            onClick={() => setExportOpen(true)}
            aria-haspopup="dialog"
            data-tip="导出"
          >
            <IconExport />
            <span>导出</span>
          </button>
        </div>
        <div className="lp-topbar-actions" ref={layersRootRef}>
          <button
            type="button"
            className={`lp-topbar-button is-icon${layersOpen ? ' is-active' : ''}`}
            onClick={() => setLayersOpen((open) => !open)}
            aria-expanded={layersOpen}
            aria-haspopup="dialog"
            data-tip="图层设置"
            aria-label="图层设置"
          >
            <IconLayers />
          </button>
          {layersOpen && (
            <div className="lp-layers-popover" role="dialog" aria-label="图层设置">
              <div className="lp-layer-row">
                <label className="lp-layer-name"><input type="checkbox" checked={view.videoVisible} onChange={(e) => updateView({ videoVisible: e.target.checked })} /><Icon name={view.videoVisible ? 'video-visible' : 'video-hidden'} size={15} />视频</label>
                <input type="range" className="lp-layer-slider" min={0} max={100} step={1} value={Math.round(view.videoOpacity * 100)} onChange={(e) => updateView({ videoOpacity: Number(e.target.value) / 100 })} aria-label="视频透明度" />
                <span className="lp-layer-value">{Math.round(view.videoOpacity * 100)}%</span>
              </div>
              <div className="lp-layer-row">
                <label className="lp-layer-name"><input type="checkbox" checked={view.analysisVisible} onChange={(e) => updateView({ analysisVisible: e.target.checked })} /><Icon name={view.analysisVisible ? 'curve-visible' : 'curve-hidden'} size={15} />曲线与标注</label>
                <input type="range" className="lp-layer-slider" min={0} max={100} step={1} value={Math.round(view.analysisOpacity * 100)} onChange={(e) => updateView({ analysisOpacity: Number(e.target.value) / 100 })} aria-label="分析层透明度" />
                <span className="lp-layer-value">{Math.round(view.analysisOpacity * 100)}%</span>
              </div>
              <label className="lp-layer-name"><input type="checkbox" checked={view.annotationsVisible} onChange={(e) => updateView({ annotationsVisible: e.target.checked })} /><Icon name="annotation-add" size={15} />标注点和文字</label>
              <label className="lp-layer-name"><input type="checkbox" checked={view.boundariesVisible} onChange={(e) => updateView({ boundariesVisible: e.target.checked })} /><Icon name="boundary-add" size={15} />分段线和名称</label>
              <label className="lp-layer-name"><input type="checkbox" checked={view.analysisLocked} onChange={(e) => updateView({ analysisLocked: e.target.checked })} /><Icon name={view.analysisLocked ? 'lock' : 'unlock'} size={15} />锁定分析层（禁止改曲线）</label>
              <button type="button" className="lp-preset-button" onClick={applyAnalysisPreset}>
                <Icon name="sliders" />
                <span>分析视图（视频 25% · 分析层 100%）</span>
              </button>
              <p className="lp-layer-hint">透明度与显示开关分别保存；隐藏视频不停止媒体时钟。</p>
            </div>
          )}
        </div>
      </header>

      {recovery != null && (
        <div className="lp-recovery-banner" role="alert">
          <span>
            检测到更新的未提交版本（revision {recovery.revision}，{recovery.updatedAt}）。可能是上次异常退出留下的内容。
          </span>
          <button type="button" className="lp-topbar-button" onClick={onRestoreRecovery}>
            恢复该版本
          </button>
          <button type="button" className="lp-topbar-button" onClick={onDiscardRecovery}>
            使用原版本
          </button>
        </div>
      )}

      {saveStatus === 'error' && saveError !== null && saveError !== undefined && (
        <div className="lp-save-error" role="alert">
          <span>保存失败：{saveError.message}</span>
          {onRetrySave !== undefined && (
            <button type="button" className="lp-topbar-button" onClick={onRetrySave}>
              重试保存
            </button>
          )}
          <button
            type="button"
            className="lp-topbar-button"
            onClick={() => void window.laipian?.projects.reveal({ projectId: snapshot.id })}
          >
            在{PLATFORM.fileManagerName}中检查目录
          </button>
        </div>
      )}

      <div className="lp-body">
        <ShotIndex
          structure={structure}
          durationMs={durationMs}
          thumbnails={thumbnails}
          selectedId={selectedStructureId}
          collapsed={view.railCollapsed === true}
          onToggleCollapse={() => updateView({ railCollapsed: !(view.railCollapsed === true) })}
          onSelectShot={(id, startMs) => {
            selectStructure(id);
            seekTo(startMs);
          }}
        />

        <div className="lp-center" ref={centerRef}>
          <div className="lp-stage">
            <div className="lp-monitor-bar" role="toolbar" aria-label="分析监视器工具条">
            <button type="button" className="lp-monitor-button" onClick={fitAll} data-tip="适应窗口" aria-label="适应窗口">
              <IconFitAll />
            </button>
            <button type="button" className="lp-monitor-button" disabled data-tip="缩放 100%（暂不可用）" aria-label="缩放 100%">
              100%
            </button>
            <button
              type="button"
              className={`lp-monitor-button${style.grid.visible ? ' is-active' : ''}`}
              aria-pressed={style.grid.visible}
              onClick={toggleGrid}
              data-tip="网格"
              aria-label="网格"
            >
              <IconGrid />
            </button>
            <button
              type="button"
              className={`lp-monitor-button${view.videoVisible ? ' is-active' : ''}`}
              aria-pressed={view.videoVisible}
              onClick={() => updateView({ videoVisible: !view.videoVisible })}
              data-tip="画面显示 / 隐藏"
              aria-label="画面显示 / 隐藏"
            >
              <Icon name={view.videoVisible ? 'video-visible' : 'video-hidden'} />
            </button>
            <button
              type="button"
              className={`lp-monitor-button${view.analysisVisible ? ' is-active' : ''}`}
              aria-pressed={view.analysisVisible}
              onClick={() => updateView({ analysisVisible: !view.analysisVisible })}
              data-tip="分析层显示 / 隐藏"
              aria-label="分析层显示 / 隐藏"
            >
              <Icon name={view.analysisVisible ? 'curve-visible' : 'curve-hidden'} />
            </button>
            <span className="lp-monitor-bar-sep" aria-hidden="true" />
            <button
              type="button"
              className={`lp-monitor-button${canvasLayout === 'overlay' ? ' is-active' : ''}`}
              aria-pressed={canvasLayout === 'overlay'}
              onClick={() => updateView({ canvasLayout: 'overlay' })}
              data-tip="叠加视图"
              aria-label="叠加视图"
            >
              <IconOverlay />
            </button>
            <button
              type="button"
              className={`lp-monitor-button${canvasLayout === 'sheet' ? ' is-active' : ''}`}
              aria-pressed={canvasLayout === 'sheet'}
              onClick={() => updateView({ canvasLayout: 'sheet' })}
              data-tip="谱面视图"
              aria-label="谱面视图"
            >
              <IconSheet />
            </button>
            <span className="lp-monitor-bar-spacer" />
            <button
              type="button"
              className={`lp-monitor-button${monitorMode === 'clean' ? ' is-active' : ''}`}
              aria-pressed={monitorMode === 'clean'}
              onClick={() => setMonitorMode((mode) => (mode === 'clean' ? 'edit' : 'clean'))}
              data-tip="干净预览"
              aria-label="干净预览"
            >
              <IconCleanPreview />
            </button>
            <button type="button" className="lp-monitor-button" onClick={toggleFullscreen} data-tip="全屏" aria-label="全屏">
              <IconFullscreen />
            </button>
          </div>
          <VideoCanvas
            mediaSrc={mediaSrc}
            videoRef={videoRef}
            hostRef={canvasRef}
            geometry={geometry}
            plotY={plotY}
            view={canvasLayout === 'sheet' ? { ...view, analysisVisible: false } : view}
            playheadStore={playheadStore}
            durationMs={durationMs}
            mediaError={controller.error}
            mediaReady={controller.ready}
            mediaMissing={mediaSrc === ''}
            gridVisible={canvasLayout === 'overlay' && monitorMode === 'edit' && style.grid.visible}
            gridOpacity={style.grid.opacity}
          >
            {canvasLayout === 'overlay' ? curveLayerElement : null}
          </VideoCanvas>
          {toolNotice !== null && <div className="lp-editor-notice" role="status">{toolNotice}</div>}
          <PlayerBar
            playing={controller.playing}
            ready={controller.ready}
            durationMs={durationMs}
            playheadStore={playheadStore}
            view={view}
            onTogglePlay={controller.togglePlay}
            onPlaybackRateChange={(rate) => updateView({ playbackRate: rate })}
            onVolumeChange={(volume) => updateView({ volume: clamp(volume, 0, 1) })}
            onMutedChange={(muted) => updateView({ muted })}
          />
          </div>

          <TimelineSplitter
            height={clampTimelineHeight(view.timelineHeight, timelineLimits)}
            limits={timelineLimits}
            onPreview={setPreviewTimelineHeight}
            onCommit={commitTimelineHeight}
            onReset={() => commitTimelineHeight(defaultTimelineHeight(timelineLimits))}
            onDraggingChange={setSplitterDragging}
          />

          <div className="lp-score" style={{ height: `${scoreHeight}px` }}>
            <div className="lp-score-toolbar" role="toolbar" aria-label="节奏谱工具条">
              <div className="lp-score-tools" role="group" aria-label="曲线与结构工具">
                {TOOLBAR_GROUPS.map((group) => (
                  <div className="lp-score-tool-group" key={group.title}>
                    {group.items.map((id) => {
                      const label = TOOLBAR_LABELS[id] ?? id;
                      const keyLabel = formatBinding(keymap[id], isMac);
                      const active =
                        (id === 'tool.select' && tool === 'select') ||
                        (id === 'draw.freehandOnce' && tool === 'freehand') ||
                        (id === 'draw.lineOnce' && tool === 'line');
                      const needsCurve =
                        id === 'node.add' ||
                        id === 'section.add' ||
                        id === 'draw.freehandOnce' ||
                        id === 'draw.lineOnce';
                      const disabled = needsCurve && !interactive;
                      return (
                        <button
                          key={id}
                          type="button"
                          className={`lp-tool-slot${active ? ' is-active' : ''}`}
                          disabled={disabled}
                          data-tip={disabled ? `${label}（需先显示曲线并提高透明度）` : `${label}（${keyLabel}）`}
                          aria-label={`${label}（${keyLabel}）`}
                          aria-pressed={active}
                          onClick={() => commandRef.current(id)}
                        >
                          <Icon name={TOOLBAR_ICONS[id] ?? 'select'} className="lp-tool-icon" />
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              <span className="lp-score-toolbar-spacer" />
              <div className="lp-shot-bar">
            <div className="lp-shot-menu" ref={shotMenuRootRef}>
              <button
                type="button"
                className={shotPanelOpen ? 'lp-topbar-button is-active' : 'lp-topbar-button'}
                onClick={() => setShotPanelOpen((open) => !open)}
                title="自动识别视频中的硬切镜头（本地 FFmpeg，不上传）"
                aria-expanded={shotPanelOpen}
              >
                <Icon name="smart-shot" />
                <span>智能识别镜头</span>
              </button>
              {shotPanelOpen && (
                <div className="lp-shot-panel" role="dialog" aria-label="智能识别镜头">
                  <div className="lp-shot-row">
                    <span className="lp-shot-label">灵敏度</span>
                    <div className="lp-shot-presets" role="group" aria-label="灵敏度">
                      {SHOT_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          className={shotPreset === preset.id ? 'lp-shot-preset is-active' : 'lp-shot-preset'}
                          aria-pressed={shotPreset === preset.id}
                          onClick={() => setShotPreset(preset.id)}
                          title={`scdet 阈值 ${preset.threshold}`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="lp-shot-row">
                    <span className="lp-shot-label">最短镜头</span>
                    <input
                      className="lp-shot-input"
                      type="number"
                      min={0.1}
                      step={0.1}
                      value={(shotMinShotMs / 1000).toString()}
                      onChange={(e) => {
                        const seconds = Number(e.target.value);
                        setShotMinShotMs(
                          Number.isFinite(seconds) && seconds > 0
                            ? Math.max(100, Math.round(seconds * 1000))
                            : DEFAULT_MIN_SHOT_MS,
                        );
                      }}
                      aria-label="最短镜头长度（秒）"
                    />
                    <span className="lp-shot-unit">秒</span>
                  </div>
                  <div className="lp-shot-actions">
                    <button
                      type="button"
                      className="lp-shot-action is-primary"
                      disabled={shotTarget === null || shotRunning}
                      title={
                        shotTarget === null
                          ? (shotTargetResult.message ?? '请先在时间线上选择一个章节、段落或时间区域。')
                          : '只分析选中区域，只修改该区域内的镜头'
                      }
                      onClick={() => {
                        if (shotTarget !== null) {
                          requestShotRun(shotTarget);
                        }
                      }}
                    >
                      <Icon name="detect-range" />
                      <span>分析选中区域</span>
                    </button>
                  </div>
                  <p className={`lp-shot-target${shotTarget === null ? ' is-empty' : ''}`}>
                    {shotTarget !== null
                      ? shotTarget.label
                      : (shotTargetResult.message ?? '请先在时间线上选择一个章节、段落或时间区域。')}
                  </p>
                  <div className="lp-shot-actions">
                    {shotRunning ? (
                      <button type="button" className="lp-shot-action" onClick={cancelShotDetect}>
                        <Icon name="close" />
                        <span>取消识别</span>
                      </button>
                    ) : (
                      <button type="button" className="lp-shot-action" onClick={startShotDetect}>
                        <Icon name="smart-shot" />
                        <span>识别整条视频</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="lp-shot-action"
                      disabled={candidateCutTimes.length === 0}
                      onClick={handleApplyShots}
                    >
                      <Icon name="accept-cuts" />
                      <span>应用结果（{candidateCutTimes.length}）</span>
                    </button>
                    <button
                      type="button"
                      className="lp-shot-action"
                      disabled={shotCuts.length === 0}
                      onClick={() => {
                        setShotCuts([]);
                        setShotMessage('已清除候选。');
                      }}
                    >
                      <Icon name="reject-cut" />
                      <span>清除候选</span>
                    </button>
                  </div>
                  {shotRunning && <p className="lp-shot-status">{shotStep ?? '正在识别镜头…'}</p>}
                  {!shotRunning && shotMessage !== null && <p className="lp-shot-status">{shotMessage}</p>}
                  {!shotRunning && candidateCutTimes.length > 0 && (
                    <p className="lp-shot-status">候选线已显示在时间线上；点击线上方的小圆点可删除误判。</p>
                  )}
                </div>
              )}
            </div>
            {candidateCutTimes.length > 0 && (
              <span className="lp-shot-count">候选 {candidateCutTimes.length}</span>
            )}
          </div>
</div>
            {canvasLayout === 'sheet' && (
              <div className="lp-score-canvas" ref={scoreCanvasRef}>
                <svg
                  className="lp-canvas-analysis"
                  width={geometry.plotLeft * 2 + geometry.plotWidth}
                  height={scorePlotY.plotTop * 2 + scorePlotY.plotHeight}
                  viewBox={`0 0 ${geometry.plotLeft * 2 + geometry.plotWidth} ${scorePlotY.plotTop * 2 + scorePlotY.plotHeight}`}
                  style={{
                    opacity: view.analysisOpacity,
                    visibility: view.analysisVisible ? 'visible' : 'hidden',
                  }}
                  aria-hidden="true"
                >
                  {monitorMode === 'edit' &&
                    style.grid.visible &&
                    [0, 25, 50, 75, 100].map((value) => {
                      const y = valueToY(value, scorePlotY);
                      return (
                        <line
                          key={value}
                          className="lp-grid-line"
                          x1={geometry.plotLeft}
                          x2={geometry.plotLeft + geometry.plotWidth}
                          y1={y}
                          y2={y}
                          style={{ opacity: style.grid.opacity }}
                        />
                      );
                    })}
                </svg>
                {curveLayerElement}
              </div>
            )}
            <Timeline
            durationMs={durationMs}
            geometry={geometry}
            view={view}
            height={timelineBodyHeight}
            playheadStore={playheadStore}
            followPlayhead={followPlayhead}
            onTimeRangeChange={handleTimeRangeChange}
            onUserPan={handleUserPan}
            onBackToPlayhead={handleBackToPlayhead}
            onSeek={controller.seekTo}
            onScrubStart={handleScrubStart}
            boundaries={boundaries}
            sections={sections}
            boundariesVisible={view.boundariesVisible}
            thumbnails={thumbnails}
            filmstripLoading={thumbnailsLoading}
            mediaReady={controller.ready}
            candidateCuts={candidateCutTimes}
            onRemoveCandidate={removeCandidate}
            resolveWheelIntent={resolveWheelIntent}
            structure={structure}
            selectedStructureId={selectedStructureId}
            projectId={snapshot.id}
            onHoverStructure={setHoveredStructureId}
            framesPaused={controller.playing}
            structureTracksVisible={view.boundariesVisible}
            onSelectStructure={(id, startMs) => {
              selectStructure(id);
              seekTo(startMs);
            }}
            onRecognizeShots={runShotForStructureNode}
            rangeSelection={rangeSelection}
            onSelectRange={(range) => {
              setRangeSelection(range);
              if (range !== null) {
                setSelectedStructureId(null);
                setSelectedNodeIds([]);
                setSelectedAnnotationId(null);
                setSelectedBoundaryId(null);
                setSelectedSectionId(null);
              }
            }}
          />
            <div className="lp-statusbar" role="status">
              <span className="lp-statusbar-hint">{hintText}</span>
              <span className="lp-statusbar-spacer" />
              <span className="lp-statusbar-scale">横向滚动 · Ctrl+滚轮缩放时间轴</span>
            </div>
          </div>
        </div>

        {/* 右侧栏：可收起（方案 §2）。收起后把空间交还给视频与曲线。 */}
        {view.inspectorCollapsed === true ? (
          <button
            type="button"
            className="lp-panel-handle"
            onClick={() => updateView({ inspectorCollapsed: false })}
            aria-label="展开检查器"
            data-tip="展开检查器"
          >
            <IconChevronLeft width={14} height={14} />
          </button>
        ) : (
        <>
        <PanelSplitter
          width={clampPanelWidth(view.inspectorWidth ?? DEFAULT_PANEL_WIDTH, panelLimits)}
          limits={panelLimits}
          onPreview={setPreviewPanelWidth}
          onCommit={commitPanelWidth}
          onReset={() => commitPanelWidth(defaultPanelWidth(panelLimits))}
          onDraggingChange={setPanelDragging}
        />
        <aside
          className="lp-panel is-open"
          aria-label="样式检查器"
          style={{ width: `${effectivePanelWidth}px` }}
        >
          <div className="lp-panel-tabs" role="tablist" aria-label="检查器页签">
            <button
              type="button"
              role="tab"
              className={`lp-panel-tab${inspectorTab === 'content' ? ' is-active' : ''}`}
              aria-selected={inspectorTab === 'content'}
              aria-label="内容"
              data-tip="内容"
              onClick={() => setInspectorTab('content')}
            >
              <Icon name="inspector-content" size={18} />
            </button>
            <button
              type="button"
              role="tab"
              className={`lp-panel-tab${inspectorTab === 'style' ? ' is-active' : ''}`}
              aria-selected={inspectorTab === 'style'}
              aria-label="样式"
              data-tip="样式"
              onClick={() => setInspectorTab('style')}
            >
              <Icon name="inspector-style" size={18} />
            </button>
            <button
              type="button"
              role="tab"
              className={`lp-panel-tab${inspectorTab === 'structure' ? ' is-active' : ''}`}
              aria-selected={inspectorTab === 'structure'}
              aria-label="结构"
              data-tip="结构"
              onClick={() => setInspectorTab('structure')}
            >
              <Icon name="inspector-structure" size={18} />
            </button>
            <span className="lp-panel-tabs-spacer" />
            <button
              type="button"
              className="lp-panel-collapse"
              onClick={() => updateView({ inspectorCollapsed: true })}
              aria-label="收起检查器"
              data-tip="收起检查器"
            >
              <IconChevronRight width={12} height={12} />
            </button>
          </div>
          <div className="lp-panel-attributes">
            {inspectorTab === 'structure' ? (
              <StructurePanel
                structure={structure}
                durationMs={durationMs}
                annotations={annotations}
                curve={curve}
                selectedId={selectedStructureId}
                onSelect={(id) => selectStructure(id)}
                onCommit={(patch, key) => commit(patch, key)}
                onSplit={splitStructureAt}
                onMerge={mergeStructure}
                onCoverAtPlayhead={setCoverAtPlayhead}
                onNotice={setToolNotice}
                onSeek={seekTo}
                onRunShotDetect={runShotForStructureNode}
                shotRunning={shotRunning}
              />
            ) : inspectorTab === 'style' ? (
              <StyleInspector
                style={style}
                curveColor={curve.color}
                onApplyPreset={applyStylePreset}
                onPatchStyle={patchStyle}
                onCurveColor={setCurveColor}
              />
            ) : selectedAnnotation !== null ? (
              <AnnotationPanel
                annotation={selectedAnnotation}
                annotations={annotations}
                boundaries={boundaries}
                sections={sections}
                durationMs={durationMs}
                onCommit={commit}
                onDelete={() => {
                  commit({ annotations: removeAnnotation(annotations, selectedAnnotation.id) });
                  setSelectedAnnotationId(null);
                }}
                onSeek={seekTo}
              />
            ) : selectedSection !== null ? (
              <SectionPanel
                boundaries={boundaries}
                sections={sections}
                selectedBoundaryId={selectedBoundaryId}
                selectedSection={selectedSection}
                onCommit={commit}
                onNotice={setToolNotice}
              />
            ) : selectedNodeIds.length > 0 ? (
              <NodePanel
                curveName={curve.name}
                nodes={curve.nodes}
                selectedNodeIds={selectedNodeIds}
                onChangeNodes={(next, key) => {
                  commit({ curve: { ...curve, nodes: next } }, key);
                  // 精确时间输入后：若节点被移出视口，平移使其保持可见（规格 5.1 第 7 条）。
                  if (key !== undefined && key.startsWith('node-time-')) {
                    const movedId = key.slice('node-time-'.length);
                    const moved = next.find((n) => n.id === movedId);
                    if (moved !== undefined) ensureTimeVisible(moved.timeMs);
                  }
                }}
                onRenameCurve={(name) => commit({ curve: { ...curve, name } }, 'curve-name')}
                frame={framePreview.frame}
                frameLoading={framePreview.loading}
                frameError={framePreview.error}
                onSeekFrame={seekTo}
              />
            ) : (
              <p className="lp-props-empty">未选择对象；可直接在下方列表中选择标注或段落。</p>
            )}
          </div>
          {inspectorTab !== 'structure' && (
          <div className="lp-panel-list">
            <ListPanel
              annotations={annotations}
              boundaries={boundaries}
              sections={sections}
              onSelectAnnotation={(id) => {
                setSelectedAnnotationId(id);
                setSelectedNodeIds([]);
                setSelectedBoundaryId(null);
                setSelectedSectionId(null);
                setSelectedStructureId(null);
                const target = annotations.find((a) => a.id === id);
                if (target) seekTo(target.timeMs);
              }}
              onSelectSection={(id) => {
                setSelectedSectionId(id);
                setSelectedNodeIds([]);
                setSelectedAnnotationId(null);
                setSelectedBoundaryId(null);
                setSelectedStructureId(null);
                const target = sections.find((s) => s.id === id);
                const boundary = target ? boundaries.find((b) => b.id === target.startBoundaryId) : undefined;
                if (boundary) seekTo(boundary.timeMs);
              }}
            />
          </div>
          )}
        </aside>
        </>
        )}
      </div>
      {pendingShotRun !== null && (
        <div
          className="lp-modal-backdrop"
          role="presentation"
          onClick={() => setPendingShotRun(null)}
        >
          <div
            className="lp-modal"
            role="dialog"
            aria-modal="true"
            aria-label="该区域已有镜头"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="lp-modal-title">该区域已有镜头</h3>
            <p className="lp-modal-message">“{pendingShotRun.label}”内已存在镜头，请选择处理方式。</p>
            <p className="lp-modal-impact">
              自动生成且未锁定的镜头会被重新识别结果替换；锁定镜头与用户手动创建的镜头始终保留，
              重叠的切点自动合并，不会产生重复边界。
            </p>
            <div className="lp-modal-actions">
              <button
                type="button"
                className="lp-section-button is-primary"
                onClick={() => startShotRange(pendingShotRun, 'replace-auto')}
              >
                重新识别自动镜头
              </button>
              <button
                type="button"
                className="lp-section-button"
                onClick={() => startShotRange(pendingShotRun, 'supplement')}
              >
                保留现有镜头并补充
              </button>
              <button
                type="button"
                className="lp-section-button"
                onClick={() => setPendingShotRun(null)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
      {helpOpen && (
        <ShortcutHelpDialog
          keymap={keymap}
          isMac={isMac}
          conflicts={conflicts}
          onRebind={rebind}
          onResetCommand={resetCommand}
          onResetAll={resetAll}
          onClose={() => setHelpOpen(false)}
        />
      )}
      <ExportDialog
        isOpen={exportOpen}
        snapshot={snapshot}
        selection={{
          structureId: selectedStructureId,
          sectionId: selectedSectionId,
          playheadMs: view.playheadMs,
        }}
        hasApi={typeof window !== 'undefined' && window.laipian !== undefined}
        onClose={() => setExportOpen(false)}
        onSaveRequested={onSaveRequested}
      />
    </div>
  );
}

function normalizeView(view: ProjectView, durationMs: number): ProjectView {
  // §6.2：旧项目"接近全片"视图一次性迁到以播放头为中心的 120 秒窗口（幂等）。
  const migrated = migrateTimelineView(view, durationMs);
  const range = clampViewRange(migrated.viewStartMs, migrated.viewEndMs, durationMs, Math.min(1000, durationMs));
  // 旧项目普遍保存为 160/200px；三级结构启用后直接迁到新的可编辑默认高度，
  // 而不是只夹到最小值，避免用户首次打开仍看到被压扁的三条细轨。
  const requestedTimelineHeight =
    migrated.timelineHeight < MIN_TIMELINE_HEIGHT ? DEFAULT_TIMELINE_HEIGHT : migrated.timelineHeight;
  return {
    ...migrated,
    ...range,
    playheadMs: clamp(Math.round(view.playheadMs), 0, durationMs),
    videoOpacity: clamp(view.videoOpacity, 0, 1),
    analysisOpacity: clamp(view.analysisOpacity, 0, 1),
    playbackRate: clamp(view.playbackRate, 0.5, 2),
    volume: clamp(view.volume, 0, 1),
    timelineHeight: clampTimelineHeight(requestedTimelineHeight, {
      min: MIN_TIMELINE_HEIGHT,
      max: ABSOLUTE_MAX_TIMELINE_HEIGHT,
    }),
    inspectorWidth: clampPanelWidth(view.inspectorWidth ?? DEFAULT_PANEL_WIDTH, {
      min: 280,
      max: 440,
    }),
  };
}
