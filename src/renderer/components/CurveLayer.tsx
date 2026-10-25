/**
 * CurveLayer / 分析层（规格 4 / 5 / 6 / 7 / 12.3）。
 *
 * 在同一坐标系（Editor 下发的 plotX/plotY，以绘图区左上角为原点）内渲染：
 * - 红色曲线（按可见区间采样）、编辑节点与贝塞尔控制柄；
 * - 竖向分段虚线（顶部拖柄、锁定标记）与段落名；
 * - 黄色标注点、标题标签与细连接线。
 *
 * 交互（Pointer Events + 指针捕获）：统一命中优先级
 * 控制柄 > 节点 > 标注 > 分段线 > 段落名 > 曲线 > 空白（规格 5.5）。
 * 工具：选择 V / 节点 P / 自由画 B / 直线 L / 标注 M / 分段 S。
 * 编辑中为临时状态（预览），完成时回调 onCommit 提交一次（一条历史，规格 8.1）；
 * Esc/取消恢复。开始编辑前 onRequestPause 暂停。单次操作失败经 onNotice 提示。
 */
import type { CSSProperties, ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation, Boundary, Curve, CurveNode, Section } from '@shared/api-types';
import { DEFAULT_STYLE, type NodeShape, type ProjectStyle } from '@shared/style';

import { DEFAULT_LABEL_OFFSET, addAnnotation, updateAnnotation } from '@shared/annotations';
import { addBoundary, isShotGeneratedBoundary, moveBoundary, sectionRanges } from '@shared/sections';
import {
  bezierControls,
  clamp as clampNum,
  clampAllHandles,
  createCurveEvaluator,
  insertNodeAtTime,
  insertNodeWithValue,
  moveNodes,
  replaceRange,
  setSegmentOutMode,
  simplifyPolyline,
} from '@shared/geometry';
import type { PolyPoint } from '@shared/geometry';
import type { PlotXGeometry, PlotYGeometry } from '../editor/editor-geometry';
import { pickHit } from '../editor/tools';
import type { HitCandidate, ToolId } from '../editor/tools';

const HIT_RADIUS_PX = 8;
const FREEHAND_MIN_WIDTH_PX = 4;
const FREEHAND_TOLERANCE_PX = 3;

const HANDLE_RADIUS_PX = 3.2;
const BOUNDARY_HANDLE_H = 14;
const SECTION_BAND_H = 18;
const LABEL_H = 18;


let idSeq = 0;
function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  idSeq += 1;
  return `${prefix}-${Date.now()}-${idSeq}`;
}

function hypot(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

function labelWidth(title: string): number {
  return title.length === 0 ? 0 : Math.min(200, 14 + title.length * 12);
}

/** 节点形状 → SVG 元素（规格第六点；不含装饰形状）。fill 由 .lp-node-mark 的 CSS 状态控制。 */
function nodeShapeElement(shape: NodeShape, x: number, y: number, r: number): ReactElement {
  switch (shape) {
    case 'diamond': {
      const d = r * 1.35;
      return (
        <path
          className="lp-node-mark"
          d={`M ${x} ${y - d} L ${x + d} ${y} L ${x} ${y + d} L ${x - d} ${y} Z`}
        />
      );
    }
    case 'rounded': {
      const s = r * 1.84;
      return (
        <rect className="lp-node-mark" x={x - s / 2} y={y - s / 2} width={s} height={s} rx={3} />
      );
    }
    case 'hexagon': {
      const pts: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const angle = (Math.PI / 3) * i - Math.PI / 2;
        pts.push(
          `${(x + r * 1.08 * Math.cos(angle)).toFixed(2)},${(y + r * 1.08 * Math.sin(angle)).toFixed(2)}`,
        );
      }
      return <polygon className="lp-node-mark" points={pts.join(' ')} />;
    }
    case 'ring':
    case 'circle':
    default:
      return <circle className="lp-node-mark" cx={x} cy={y} r={r} />;
  }
}

export interface AnalysisPatch {
  curve?: Curve;
  annotations?: Annotation[];
  boundaries?: Boundary[];
  sections?: Section[];
}

type Gesture =
  | { kind: 'node'; startNodes: CurveNode[]; ids: string[]; startTime: number; startValue: number }
  | { kind: 'handle'; startNodes: CurveNode[]; ownerId: string; side: 'in' | 'out' }
  | { kind: 'freehand'; startNodes: CurveNode[]; pixels: PolyPoint[] }
  | { kind: 'line'; startNodes: CurveNode[]; start: PolyPoint; current: PolyPoint }
  | { kind: 'marquee'; start: PolyPoint; current: PolyPoint }
  | { kind: 'annotation-time'; startAnnotations: Annotation[]; id: string }
  | {
      kind: 'annotation-offset';
      startAnnotations: Annotation[];
      id: string;
      start: PolyPoint;
      baseOffset: { x: number; y: number };
    }
  | { kind: 'boundary'; startBoundaries: Boundary[]; id: string };

export interface CurveLayerProps {
  curve: Curve;
  annotations?: readonly Annotation[];
  boundaries?: readonly Boundary[];
  sections?: readonly Section[];
  plotX: PlotXGeometry;
  plotY: PlotYGeometry;
  viewStartMs: number;
  viewEndMs: number;
  durationMs: number;
  analysisVisible: boolean;
  analysisOpacity: number;
  annotationsVisible?: boolean;
  boundariesVisible?: boolean;
  /**
   * 仅显示该时间范围内的"镜头识别边界"（选中 / 悬停 / 播放头所在镜头）；
   * 其余大量镜头切点边界只保留在时间线，不全部延伸到分析监视器。
   * null 时隐藏全部镜头边界（用户手动段落边界始终显示）。
   */
  focusRange?: { startMs: number; endMs: number } | null;
  locked: boolean;
  tool: ToolId;
  selectedNodeIds: readonly string[];
  selectedAnnotationId?: string | null;
  selectedBoundaryId?: string | null;
  selectedSectionId?: string | null;
  onSelectNodes(ids: string[]): void;
  onSelectAnnotation?(id: string | null): void;
  onSelectBoundary?(id: string | null): void;
  onSelectSection?(id: string | null): void;
  /** 提交内容变更（进历史并保存）。 */
  onCommit(patch: AnalysisPatch, coalesceKey?: string): void;
  /** 开始编辑前暂停播放。 */
  onRequestPause(): void;
/** 单次操作提示（如分段失败原因）。 */
  onNotice?(message: string): void;
  /** 一次性绘制（自由画 / 直线）提交后通知，供编辑器切回智能选择。 */
  onDrawComplete?(): void;
  /** 分析监视器样式（第一阶段）；缺省用专业默认。 */
  style?: ProjectStyle;
  /** 干净预览：隐藏节点、控制柄与分段把手（只显示视频/曲线/标注/分段线），不改变数据。 */
  hideChrome?: boolean;
}

export function CurveLayer(props: CurveLayerProps) {
  const {
    curve,
    annotations = [],
    boundaries = [],
    sections = [],
    plotX,
    plotY,
    viewStartMs,
    viewEndMs,
    durationMs,
    analysisVisible,
    analysisOpacity,
    annotationsVisible = true,
    boundariesVisible = true,
    focusRange = null,
    locked,
    tool,
    selectedNodeIds,
    selectedAnnotationId = null,
    selectedBoundaryId = null,
    selectedSectionId = null,
    onSelectNodes,
    onSelectAnnotation,
    onSelectBoundary,
    onSelectSection,
    onCommit,
    onRequestPause,
    onNotice,
    onDrawComplete,
    style = DEFAULT_STYLE,
    hideChrome = false,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const previewNodesRef = useRef<CurveNode[] | null>(null);
  const previewAnnotationsRef = useRef<Annotation[] | null>(null);
  const previewBoundariesRef = useRef<Boundary[] | null>(null);
  const [previewNodes, setPreviewNodes] = useState<CurveNode[] | null>(null);
  const [previewAnnotations, setPreviewAnnotations] = useState<Annotation[] | null>(null);
  const [previewBoundaries, setPreviewBoundaries] = useState<Boundary[] | null>(null);
  const [previewPixels, setPreviewPixels] = useState<PolyPoint[] | null>(null);
  const [previewLine, setPreviewLine] = useState<{ a: PolyPoint; b: PolyPoint } | null>(null);
  const [marquee, setMarquee] = useState<{ a: PolyPoint; b: PolyPoint } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: string; segmentIndex: number } | null>(null);
  /** 悬停命中的对象 id（节点/标注/边界）：给出即时反馈（规格 5.1）。 */
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** 拖动到编辑区边缘（受约束）：节点给出视觉反馈（规格 5.1 阻尼/约束反馈）。 */
  const [constrained, setConstrained] = useState(false);

  previewNodesRef.current = previewNodes;
  previewAnnotationsRef.current = previewAnnotations;
  previewBoundariesRef.current = previewBoundaries;

  const interactive = analysisVisible && analysisOpacity > 0 && !locked;
  const nodes = previewNodes ?? curve.nodes;
  const anns = previewAnnotations ?? annotations;
  const bounds = previewBoundaries ?? boundaries;

  const { plotLeft, plotWidth } = plotX;
  const { plotTop, plotHeight } = plotY;
  const span = viewEndMs - viewStartMs;

  const lx = useCallback(
    (timeMs: number): number => (span > 0 ? ((timeMs - viewStartMs) / span) * plotWidth : 0),
    [span, viewStartMs, plotWidth],
  );
  const ly = useCallback(
    (value: number): number => (1 - clampNum(value, 0, 100) / 100) * plotHeight,
    [plotHeight],
  );
  const timeAt = useCallback(
    (x: number): number => Math.round(viewStartMs + (plotWidth > 0 ? x / plotWidth : 0) * span),
    [viewStartMs, plotWidth, span],
  );
  const valueAt = useCallback(
    (y: number): number => clampNum((1 - (plotHeight > 0 ? y / plotHeight : 0)) * 100, 0, 100),
    [plotHeight],
  );

  const evaluator = useMemo(() => createCurveEvaluator(nodes), [nodes]);

  const pathD = useMemo(() => {
    const count = Math.max(2, Math.min(2000, Math.ceil(plotWidth)));
    const points = evaluator.sample(viewStartMs, viewEndMs, count);
    const first = points[0];
    if (first === undefined) {
      return '';
    }
    let d = `M ${lx(first.timeMs).toFixed(2)} ${ly(first.value).toFixed(2)}`;
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      if (p === undefined) {
        continue;
      }
      d += ` L ${lx(p.timeMs).toFixed(2)} ${ly(p.value).toFixed(2)}`;
    }
    return d;
  }, [evaluator, viewStartMs, viewEndMs, plotWidth, lx, ly]);

  const ranges = useMemo(() => sectionRanges(bounds, sections), [bounds, sections]);

  const annotationGeometry = useCallback(
    (a: Annotation): { px: number; py: number; ax: number; ay: number; w: number } => {
      const px = lx(a.timeMs);
      const py = ly(evaluator.at(a.timeMs));
      const w = labelWidth(a.title);
      const ax = clampNum(px + a.labelOffset.x, 0, Math.max(0, plotWidth - Math.max(w, 8)));
      const ay = clampNum(py + a.labelOffset.y, 0, Math.max(0, plotHeight - LABEL_H));
      return { px, py, ax, ay, w };
    },
    [lx, ly, evaluator, plotWidth, plotHeight],
  );

  const buildCandidates = useCallback(
    (lp: PolyPoint): HitCandidate[] => {
      const candidates: HitCandidate[] = [];
      const selected = new Set(selectedNodeIds);

      for (let i = 0; i < nodes.length - 1; i++) {
        const a = nodes[i];
        const b = nodes[i + 1];
        if (a === undefined || b === undefined || a.outMode !== 'bezier') {
          continue;
        }
        if (!(selected.has(a.id) || selected.has(b.id))) {
          continue;
        }
        const controls = bezierControls(a, b);
        candidates.push({ kind: 'handle', id: a.id, side: 'out', distancePx: hypot(lp.x, lp.y, lx(controls.c1x), ly(controls.c1v)) });
        candidates.push({ kind: 'handle', id: b.id, side: 'in', distancePx: hypot(lp.x, lp.y, lx(controls.c2x), ly(controls.c2v)) });
      }

      for (const node of nodes) {
        const x = lx(node.timeMs);
        if (x < -24 || x > plotWidth + 24) {
          continue;
        }
        candidates.push({ kind: 'node', id: node.id, distancePx: hypot(lp.x, lp.y, x, ly(node.value)) });
      }

      if (annotationsVisible) {
        for (const a of anns) {
          const { px, py, ax, ay, w } = annotationGeometry(a);
          const inLabel =
            w > 0 && lp.x >= ax - 4 && lp.x <= ax + w + 4 && lp.y >= ay - 4 && lp.y <= ay + LABEL_H + 4;
          const distPoint = hypot(lp.x, lp.y, px, py);
          candidates.push({
            kind: 'annotation',
            id: a.id,
            distancePx: inLabel ? Math.min(distPoint, 2) : distPoint,
          });
        }
      }

      if (boundariesVisible) {
        for (const boundary of bounds) {
          const x = lx(boundary.timeMs);
          if (x < -8 || x > plotWidth + 8) {
            continue;
          }
          if (lp.y <= BOUNDARY_HANDLE_H + 4) {
            candidates.push({ kind: 'boundary', id: boundary.id, distancePx: Math.abs(lp.x - x) });
          }
        }
        for (const range of ranges) {
          const sx = lx(range.startMs);
          const ex = lx(range.endMs);
          if (lp.y <= SECTION_BAND_H && lp.x >= sx && lp.x <= ex) {
            candidates.push({ kind: 'section', id: range.section.id, distancePx: lp.y });
          }
        }
      }

      if (lp.x >= 0 && lp.x <= plotWidth) {
        candidates.push({ kind: 'curve', id: 'curve', distancePx: Math.abs(lp.y - ly(evaluator.at(timeAt(lp.x)))) });
      }
      return candidates;
    },
    [
      nodes,
      selectedNodeIds,
      anns,
      bounds,
      ranges,
      annotationsVisible,
      boundariesVisible,
      annotationGeometry,
      evaluator,
      lx,
      ly,
      timeAt,
      plotWidth,
    ],
  );

  const localPoint = useCallback((event: React.PointerEvent | React.MouseEvent): PolyPoint => {
    const container = containerRef.current;
    if (!container) {
      return { x: 0, y: 0 };
    }
    const rect = container.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const clearPreviews = useCallback((): void => {
    setPreviewNodes(null);
    setPreviewAnnotations(null);
    setPreviewBoundaries(null);
    setPreviewPixels(null);
    setPreviewLine(null);
    setMarquee(null);
    setConstrained(false);
  }, []);

  const cancelGesture = useCallback((): void => {
    gestureRef.current = null;
    clearPreviews();
  }, [clearPreviews]);

  useEffect(() => {
    if (notice === null) {
      return undefined;
    }
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const reportNotice = useCallback(
    (message: string) => {
      if (onNotice) {
        onNotice(message);
      } else {
        setNotice(message);
      }
    },
    [onNotice],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (!interactive || event.button === 2) {
        return;
      }
      const lp = localPoint(event);
      const picked = pickHit(buildCandidates(lp), HIT_RADIUS_PX);
      onRequestPause();

      if (tool === 'note') {
        const time = timeAt(lp.x);
        const result = addAnnotation(anns, time, newId('note'), DEFAULT_LABEL_OFFSET);
        onCommit({ annotations: result.annotations });
        const created = result.created ? result.annotations.find((a) => a.timeMs === time) : result.existing;
        onSelectAnnotation?.(created?.id ?? null);
        return;
      }
      if (tool === 'section') {
        const result = addBoundary(bounds, sections, timeAt(lp.x), newId('b'), newId('s'), durationMs);
        if (!result.ok) {
          reportNotice(result.message ?? '无法在此添加分段。');
        } else {
          onCommit({ boundaries: result.boundaries, sections: result.sections });
        }
        return;
      }

      if (tool === 'select') {
        if (picked?.kind === 'handle' && picked.side !== undefined) {
          event.currentTarget.setPointerCapture(event.pointerId);
          gestureRef.current = { kind: 'handle', startNodes: nodes.map((n) => ({ ...n })), ownerId: picked.id, side: picked.side };
          return;
        }
        if (picked?.kind === 'node') {
          const isSelected = selectedNodeIds.includes(picked.id);
          if (event.shiftKey && isSelected) {
            onSelectNodes(selectedNodeIds.filter((id) => id !== picked.id));
            return;
          }
          const nextSelection = event.shiftKey ? [...selectedNodeIds, picked.id] : isSelected ? [...selectedNodeIds] : [picked.id];
          onSelectNodes(nextSelection);
          onSelectAnnotation?.(null);
          onSelectBoundary?.(null);
          onSelectSection?.(null);
          event.currentTarget.setPointerCapture(event.pointerId);
          gestureRef.current = { kind: 'node', startNodes: nodes.map((n) => ({ ...n })), ids: nextSelection, startTime: timeAt(lp.x), startValue: valueAt(lp.y) };
          return;
        }
        if (picked?.kind === 'annotation') {
          const target = anns.find((a) => a.id === picked.id);
          if (target !== undefined) {
            onSelectAnnotation?.(target.id);
            onSelectNodes([]);
            const { ax, ay, w } = annotationGeometry(target);
            const inLabel = w > 0 && lp.x >= ax - 4 && lp.x <= ax + w + 4 && lp.y >= ay - 4 && lp.y <= ay + LABEL_H + 4;
            event.currentTarget.setPointerCapture(event.pointerId);
            gestureRef.current = inLabel
              ? { kind: 'annotation-offset', startAnnotations: anns.map((a) => ({ ...a })), id: target.id, start: lp, baseOffset: { ...target.labelOffset } }
              : { kind: 'annotation-time', startAnnotations: anns.map((a) => ({ ...a })), id: target.id };
          }
          return;
        }
        if (picked?.kind === 'boundary') {
          const target = bounds.find((b) => b.id === picked.id);
          if (target !== undefined) {
            onSelectBoundary?.(target.id);
            onSelectNodes([]);
            onSelectAnnotation?.(null);
            if (!target.fixed && !target.locked) {
              event.currentTarget.setPointerCapture(event.pointerId);
              gestureRef.current = { kind: 'boundary', startBoundaries: bounds.map((b) => ({ ...b })), id: target.id };
            }
          }
          return;
        }
        if (picked?.kind === 'section') {
          onSelectSection?.(picked.id);
          onSelectNodes([]);
          onSelectAnnotation?.(null);
          onSelectBoundary?.(null);
          return;
        }
        if (picked?.kind === 'curve') {
          if (!event.shiftKey) {
            onSelectNodes([]);
            onSelectAnnotation?.(null);
            onSelectBoundary?.(null);
            onSelectSection?.(null);
          }
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        gestureRef.current = { kind: 'marquee', start: lp, current: lp };
        setMarquee({ a: lp, b: lp });
        if (!event.shiftKey) {
          onSelectNodes([]);
          onSelectAnnotation?.(null);
          onSelectBoundary?.(null);
          onSelectSection?.(null);
        }
        return;
      }

      if (tool === 'node') {
        if (picked?.kind === 'node') {
          onSelectNodes([picked.id]);
          return;
        }
        const next = insertNodeWithValue(nodes, timeAt(lp.x), valueAt(lp.y), newId('n'));
        if (next.length > nodes.length) {
          onCommit({ curve: { ...curve, nodes: next } });
          const inserted = next.find((n) => !nodes.some((old) => old.id === n.id));
          onSelectNodes(inserted ? [inserted.id] : []);
        }
        return;
      }

      if (tool === 'freehand') {
        event.currentTarget.setPointerCapture(event.pointerId);
        gestureRef.current = { kind: 'freehand', startNodes: nodes.map((n) => ({ ...n })), pixels: [lp] };
        setPreviewPixels([lp]);
        return;
      }
      if (tool === 'line') {
        event.currentTarget.setPointerCapture(event.pointerId);
        gestureRef.current = { kind: 'line', startNodes: nodes.map((n) => ({ ...n })), start: lp, current: lp };
        setPreviewLine({ a: lp, b: lp });
      }
    },
    [
      interactive,
      localPoint,
      buildCandidates,
      onRequestPause,
      tool,
      nodes,
      anns,
      bounds,
      curve,
      sections,
      durationMs,
      timeAt,
      valueAt,
      selectedNodeIds,
      onSelectNodes,
      onSelectAnnotation,
      onSelectBoundary,
      onSelectSection,
      onCommit,
      annotationGeometry,
      reportNotice,
    ],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const gesture = gestureRef.current;
      const lp = localPoint(event);
      if (!gesture) {
        // 非拖动：更新悬停高亮（规格 5.1：悬停时出现明确反馈）。
        if (!interactive) {
          return;
        }
        const picked = pickHit(buildCandidates(lp), HIT_RADIUS_PX);
        const hovered =
          picked?.kind === 'node' || picked?.kind === 'annotation' || picked?.kind === 'boundary'
            ? picked.id
            : null;
        setHoverId((prev) => (prev === hovered ? prev : hovered));
        return;
      }
      // 指针越出编辑区：约束反馈（拖动到合法范围边缘）。
      const atEdge = lp.x <= 0 || lp.x >= plotWidth || lp.y <= 0 || lp.y >= plotHeight;
      switch (gesture.kind) {
        case 'node': {
          const result = moveNodes(gesture.startNodes, gesture.ids, timeAt(lp.x) - gesture.startTime, valueAt(lp.y) - gesture.startValue);
          setPreviewNodes(result.nodes);
          setConstrained(atEdge);
          break;
        }
        case 'handle': {
          const arr = gesture.startNodes.map((n) => ({ ...n }));
          const owner = arr.find((n) => n.id === gesture.ownerId);
          if (owner) {
            const handle = { dtMs: timeAt(lp.x) - owner.timeMs, dv: valueAt(lp.y) - owner.value };
            if (gesture.side === 'out') {
              owner.outHandle = handle;
            } else {
              owner.inHandle = handle;
            }
            setPreviewNodes(clampAllHandles(arr));
          }
          setConstrained(atEdge);
          break;
        }
        case 'freehand': {
          const last = gesture.pixels[gesture.pixels.length - 1];
          if (last === undefined || lp.x > last.x + 0.5) {
            gesture.pixels.push(lp);
            setPreviewPixels([...gesture.pixels]);
          }
          break;
        }
        case 'line':
          gesture.current = lp;
          setPreviewLine({ a: gesture.start, b: lp });
          break;
        case 'marquee':
          gesture.current = lp;
          setMarquee({ a: gesture.start, b: lp });
          break;
        case 'annotation-time': {
          const result = updateAnnotation(gesture.startAnnotations, gesture.id, { timeMs: clampNum(timeAt(lp.x), 0, durationMs) });
          setPreviewAnnotations(result.ok ? result.annotations : gesture.startAnnotations);
          break;
        }
        case 'annotation-offset': {
          const dx = lp.x - gesture.start.x;
          const dy = lp.y - gesture.start.y;
          const result = updateAnnotation(gesture.startAnnotations, gesture.id, {
            labelOffset: { x: gesture.baseOffset.x + dx, y: gesture.baseOffset.y + dy },
          });
          setPreviewAnnotations(result.annotations);
          break;
        }
        case 'boundary': {
          const result = moveBoundary(gesture.startBoundaries, sections, gesture.id, timeAt(lp.x));
          if (result.ok) {
            setPreviewBoundaries(result.boundaries);
          }
          setConstrained(atEdge);
          break;
        }
        default:
          break;
      }
    },
    [localPoint, timeAt, valueAt, durationMs, sections, interactive, buildCandidates, plotWidth, plotHeight],
  );

  const finalizeFreehand = useCallback(
    (gesture: Extract<Gesture, { kind: 'freehand' }>): void => {
      const pixels = gesture.pixels;
      if (pixels.length < 2) {
        return;
      }
      const first = pixels[0];
      const last = pixels[pixels.length - 1];
      if (first === undefined || last === undefined || last.x - first.x < FREEHAND_MIN_WIDTH_PX) {
        return;
      }
      const simplified = simplifyPolyline(pixels, FREEHAND_TOLERANCE_PX);
      const points: { timeMs: number; value: number }[] = [];
      for (const p of simplified) {
        const timeMs = timeAt(p.x);
        const prev = points[points.length - 1];
        if (prev !== undefined && timeMs <= prev.timeMs) {
          continue;
        }
        points.push({ timeMs, value: valueAt(p.y) });
      }
      const startPoint = points[0];
      const endPoint = points[points.length - 1];
      if (startPoint === undefined || endPoint === undefined || startPoint.timeMs >= endPoint.timeMs) {
        return;
      }
      const interior = points.slice(1, -1).map((p) => ({ timeMs: p.timeMs, value: p.value }));
      onCommit({
        curve: {
          ...curve,
          nodes: replaceRange(gesture.startNodes, startPoint.timeMs, endPoint.timeMs, {
            interior,
            durationMs,
            idFactory: () => newId('n'),
          }),
        },
      });
      reportNotice('已应用一笔自由画；可继续绘制或按 V 返回选择工具。');
    },
    [timeAt, valueAt, onCommit, curve, durationMs, reportNotice],
  );

  const finalizeLine = useCallback(
    (gesture: Extract<Gesture, { kind: 'line' }>): void => {
      const { start, current } = gesture;
      if (current.x - start.x < FREEHAND_MIN_WIDTH_PX) {
        return;
      }
      const startMs = timeAt(start.x);
      const endMs = timeAt(current.x);
      if (startMs >= endMs) {
        return;
      }
      onCommit({
        curve: {
          ...curve,
          nodes: replaceRange(gesture.startNodes, startMs, endMs, {
            lineMode: true,
            interior: [],
            durationMs,
            idFactory: () => newId('n'),
          }),
        },
      });
      reportNotice('已应用一段直线；可继续绘制或按 V 返回选择工具。');
    },
    [timeAt, onCommit, curve, durationMs, reportNotice],
  );

  const selectInMarquee = useCallback(
    (gesture: Extract<Gesture, { kind: 'marquee' }>): void => {
      const minX = Math.min(gesture.start.x, gesture.current.x);
      const maxX = Math.max(gesture.start.x, gesture.current.x);
      const minY = Math.min(gesture.start.y, gesture.current.y);
      const maxY = Math.max(gesture.start.y, gesture.current.y);
      const ids: string[] = [];
      for (const node of nodes) {
        const x = lx(node.timeMs);
        const y = ly(node.value);
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
          ids.push(node.id);
        }
      }
      onSelectNodes(ids);
    },
    [nodes, lx, ly, onSelectNodes],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // 指针未捕获时忽略。
      }
      if (!gesture) {
        clearPreviews();
        return;
      }
      if (gesture.kind === 'node' || gesture.kind === 'handle') {
        if (previewNodesRef.current !== null) {
          onCommit({ curve: { ...curve, nodes: previewNodesRef.current } });
        }
      } else if (gesture.kind === 'annotation-time' || gesture.kind === 'annotation-offset') {
        if (previewAnnotationsRef.current !== null) {
          onCommit({ annotations: previewAnnotationsRef.current });
        }
      } else if (gesture.kind === 'boundary') {
        if (previewBoundariesRef.current !== null) {
          onCommit({ boundaries: previewBoundariesRef.current, sections: sections.map((s) => ({ ...s })) });
        }
      } else if (gesture.kind === 'freehand') {
        finalizeFreehand(gesture);
        onDrawComplete?.();
      } else if (gesture.kind === 'line') {
        finalizeLine(gesture);
        onDrawComplete?.();
      } else if (gesture.kind === 'marquee') {
        selectInMarquee(gesture);
      }
      clearPreviews();
    },
    [clearPreviews, onCommit, curve, sections, finalizeFreehand, finalizeLine, selectInMarquee, onDrawComplete],
  );

  const onDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (!interactive || tool !== 'select') {
        return;
      }
      const lp = localPoint(event);
      const picked = pickHit(buildCandidates(lp), HIT_RADIUS_PX);
      if (picked?.kind === 'node' || picked?.kind === 'annotation' || picked?.kind === 'boundary') {
        return;
      }
      const id = newId('n');
      const next = insertNodeAtTime(nodes, timeAt(lp.x), id);
      if (next.length > nodes.length) {
        onRequestPause();
        onCommit({ curve: { ...curve, nodes: next } });
        onSelectNodes([id]);
      }
    },
    [interactive, tool, localPoint, buildCandidates, nodes, curve, timeAt, onCommit, onSelectNodes, onRequestPause],
  );

  const onContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (!interactive || tool !== 'select') {
        return;
      }
      const lp = localPoint(event);
      const picked = pickHit(buildCandidates(lp), HIT_RADIUS_PX);
      // 无论命中什么，都阻止浏览器/系统默认菜单（规格 5.5：菜单只作用于命中对象）。
      event.preventDefault();
      if (picked?.kind === 'annotation') {
        onSelectAnnotation?.(picked.id);
        onSelectNodes([]);
        onSelectBoundary?.(null);
        onSelectSection?.(null);
        return;
      }
      if (picked?.kind === 'boundary') {
        onSelectBoundary?.(picked.id);
        onSelectNodes([]);
        onSelectAnnotation?.(null);
        onSelectSection?.(null);
        return;
      }
      if (picked?.kind !== 'node') {
        return;
      }
      // 右键命中节点：先使其成为当前选择，再弹出作用于该节点的菜单。
      if (!selectedNodeIds.includes(picked.id)) {
        onSelectNodes([picked.id]);
        onSelectAnnotation?.(null);
        onSelectBoundary?.(null);
        onSelectSection?.(null);
      }
      const index = nodes.findIndex((n) => n.id === picked.id);
      const segmentIndex = index >= 0 && index < nodes.length - 1 ? index : Math.max(0, index - 1);
      setMenu({ x: lp.x, y: lp.y, nodeId: picked.id, segmentIndex });
    },
    [
      interactive,
      tool,
      localPoint,
      buildCandidates,
      nodes,
      selectedNodeIds,
      onSelectNodes,
      onSelectAnnotation,
      onSelectBoundary,
      onSelectSection,
    ],
  );

  useEffect(() => {
    if (menu === null) {
      return undefined;
    }
    const close = (): void => setMenu(null);
    window.addEventListener('pointerdown', close, { capture: true });
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close, { capture: true });
      window.removeEventListener('keydown', close);
    };
  }, [menu]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && gestureRef.current !== null) {
        cancelGesture();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancelGesture]);

  const applySegmentMode = useCallback(
    (index: number, mode: CurveNode['outMode']): void => {
      onCommit({ curve: { ...curve, nodes: setSegmentOutMode(nodes, index, mode) } });
      setMenu(null);
    },
    [nodes, curve, onCommit],
  );

  const applyRemoveNode = useCallback(
    (id: string): void => {
      const next = nodes.filter((n) => n.id !== id);
      if (next.length >= 2) {
        onCommit({ curve: { ...curve, nodes: next } });
        onSelectNodes(selectedNodeIds.filter((nodeId) => nodeId !== id));
      }
      setMenu(null);
    },
    [nodes, curve, onCommit, onSelectNodes, selectedNodeIds],
  );

  const selectedNodeSet = new Set(selectedNodeIds);
  const visibleNodes = nodes.filter((node) => {
    const x = lx(node.timeMs);
    return x >= -24 && x <= plotWidth + 24;
  });
  const visibleAnnotations = annotationsVisible
    ? anns.filter((a) => {
        const x = lx(a.timeMs);
        return x >= -40 && x <= plotWidth + 40;
      })
    : [];
  const visibleBoundaries = boundariesVisible
    ? bounds.filter((b) => {
        const x = lx(b.timeMs);
        if (x < -8 || x > plotWidth + 8) {
          return false;
        }
        // 镜头识别边界：只在焦点镜头（选中/悬停/播放头）附近显示；
        // 其余大量切点边界留在时间线，不全部延伸到监视器。
        if (isShotGeneratedBoundary(b.id)) {
          if (focusRange === null) {
            return false;
          }
          return b.timeMs >= focusRange.startMs - 1 && b.timeMs <= focusRange.endMs + 1;
        }
        return true;
      })
    : [];

  const cursor =
    tool === 'node' || tool === 'freehand' || tool === 'line' || tool === 'note' || tool === 'section'
      ? 'crosshair'
      : 'default';


  const menuNode = menu !== null ? nodes.find((n) => n.id === menu.nodeId) : undefined;
  const menuIndex = menuNode !== undefined ? nodes.findIndex((n) => n.id === menuNode.id) : -1;
  const isEndpoint = menuIndex === 0 || menuIndex === nodes.length - 1;

  return (
    <div
      ref={containerRef}
      className="lp-curve-layer"
      style={{
        left: plotLeft,
        top: plotTop,
        width: plotWidth,
        height: plotHeight,
        opacity: analysisOpacity,
        visibility: analysisVisible ? 'visible' : 'hidden',
        pointerEvents: interactive ? 'auto' : 'none',
        cursor,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancelGesture}
      onPointerLeave={() => setHoverId(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      role="presentation"
    >
      <svg
        className="lp-curve-svg"
        width={plotWidth}
        height={plotHeight}
        viewBox={`0 0 ${plotWidth} ${plotHeight}`}
        style={{ pointerEvents: 'none' }}
        aria-hidden="true"
      >
        {/* 分段虚线 + 顶部拖柄 + 段落名 */}
        {visibleBoundaries.map((boundary) => {
          const x = lx(boundary.timeMs);
          const isEdge = boundary.fixed;
          return (
            <g
              key={`bd-${boundary.id}`}
              className={`lp-boundary${boundary.locked ? ' is-locked' : ''}${selectedBoundaryId === boundary.id ? ' is-selected' : ''}${hoverId === boundary.id ? ' is-hover' : ''}`}
            >
              <line className="lp-boundary-line" x1={x} y1={0} x2={x} y2={plotHeight} />
              {!isEdge && !hideChrome && <rect className="lp-boundary-handle" x={x - 5} y={0} width={10} height={BOUNDARY_HANDLE_H} />}
              {boundary.locked && !isEdge && <rect className="lp-boundary-lock" x={x - 3} y={3} width={6} height={7} />}
            </g>
          );
        })}
        {boundariesVisible &&
          ranges.map((range) => {
            const sx = lx(range.startMs);
            const ex = lx(range.endMs);
            if (ex < 0 || sx > plotWidth) {
              return null;
            }
            const name = range.section.name;
            const maxChars = Math.max(2, Math.floor((ex - sx - 12) / 12));
            const text = name.length > maxChars ? `${name.slice(0, maxChars)}…` : name;
            // 段名居中于「两边界线之间」的区间（而非贴在起点边界线上）。
            const midX = (Math.max(sx, 0) + Math.min(ex, plotWidth)) / 2;
            return (
              <text
                key={`sec-${range.section.id}`}
                className={`lp-section-name${selectedSectionId === range.section.id ? ' is-selected' : ''}`}
                x={midX}
                y={13}
                textAnchor="middle"
              >
                {text}
                <title>{name}</title>
              </text>
            );
          })}

        <path
          className="lp-curve-halo"
          d={pathD}
          style={{
            stroke: curve.color,
            strokeWidth: style.curve.width + 4,
            opacity: style.curve.opacity * style.curve.halo,
          }}
        />
        <path
          className={`lp-curve-path${locked ? ' is-locked' : ''}`}
          d={pathD}
          style={{
            stroke: curve.color,
            strokeWidth: style.curve.width,
            opacity: locked ? style.curve.opacity * style.curve.lockedOpacity : style.curve.opacity,
          }}
        />

        {nodes.map((a, i) => {
          const b = nodes[i + 1];
          if (b === undefined || a.outMode !== 'bezier' || !(selectedNodeSet.has(a.id) || selectedNodeSet.has(b.id)) || hideChrome) {
            return null;
          }
          const controls = bezierControls(a, b);
          const ax = lx(a.timeMs);
          const ay = ly(a.value);
          const bx = lx(b.timeMs);
          const by = ly(b.value);
          const c1x = lx(controls.c1x);
          const c1y = ly(controls.c1v);
          const c2x = lx(controls.c2x);
          const c2y = ly(controls.c2v);
          return (
            <g key={`h-${a.id}`}>
              <line className="lp-handle-line" x1={ax} y1={ay} x2={c1x} y2={c1y} />
              <line className="lp-handle-line" x1={bx} y1={by} x2={c2x} y2={c2y} />
              <rect className="lp-handle-point" x={c1x - HANDLE_RADIUS_PX} y={c1y - HANDLE_RADIUS_PX} width={HANDLE_RADIUS_PX * 2} height={HANDLE_RADIUS_PX * 2} />
              <rect className="lp-handle-point" x={c2x - HANDLE_RADIUS_PX} y={c2y - HANDLE_RADIUS_PX} width={HANDLE_RADIUS_PX * 2} height={HANDLE_RADIUS_PX * 2} />
            </g>
          );
        })}

        {visibleAnnotations.map((a) => {
          const { px, py, ax, ay, w } = annotationGeometry(a);
          const selected = selectedAnnotationId === a.id;
          const noteColor = style.annotation.color;
          return (
            <g key={`an-${a.id}`} className={`lp-annotation${selected ? ' is-selected' : ''}${hoverId === a.id ? ' is-hover' : ''}`}>
              {w > 0 && <line className="lp-annotation-link" x1={px} y1={py} x2={ax} y2={ay + LABEL_H / 2} />}
              {w > 0 && (
                <>
                  <rect className="lp-annotation-label-bg" x={ax} y={ay} width={w} height={LABEL_H} rx={4} />
                  <rect
                    className="lp-annotation-accent"
                    x={ax}
                    y={ay}
                    width={w}
                    height={2}
                    rx={1}
                    style={{ fill: noteColor }}
                  />
                  <text className="lp-annotation-label" x={ax + 6} y={ay + 13}>
                    {a.title.length > 16 ? `${a.title.slice(0, 16)}…` : a.title}
                  </text>
                </>
              )}
              <circle className="lp-annotation-point" cx={px} cy={py} r={4} style={{ fill: noteColor }} />
            </g>
          );
        })}

        {previewPixels !== null && previewPixels.length > 1 && (
          <polyline className="lp-curve-preview" points={previewPixels.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} />
        )}
        {previewLine !== null && (
          <line className="lp-curve-preview" x1={previewLine.a.x} y1={previewLine.a.y} x2={previewLine.b.x} y2={previewLine.b.y} />
        )}
        {marquee !== null && (
          <rect
            className="lp-marquee"
            x={Math.min(marquee.a.x, marquee.b.x)}
            y={Math.min(marquee.a.y, marquee.b.y)}
            width={Math.abs(marquee.a.x - marquee.b.x)}
            height={Math.abs(marquee.a.y - marquee.b.y)}
          />
        )}

        {interactive && !hideChrome &&
          visibleNodes.map((node, index) => {
            const x = lx(node.timeMs);
            const y = ly(node.value);
            const fixed = index === 0 || index === nodes.length - 1;
            const selected = selectedNodeSet.has(node.id);
            const hovered = hoverId === node.id;
            const shape = fixed ? style.node.endpointShape : style.node.shape;
            const radius = style.node.size / 2 + (selected || hovered ? 1 : 0);
            const strokeColor = style.node.color ?? curve.color;
            return (
              <g
                key={node.id}
                className={`lp-node${fixed ? ' is-fixed' : ''}${selected ? ' is-selected' : ''}${hovered ? ' is-hover' : ''}${constrained && selected ? ' is-constrained' : ''}${shape === 'ring' ? ' is-ring' : ''}${locked ? ' is-locked' : ''}`}
                style={
                  {
                    '--lp-node-color': strokeColor,
                    '--lp-node-stroke': String(style.node.stroke),
                  } as CSSProperties
                }
              >
                {nodeShapeElement(shape, x, y, radius)}
                {selected && <circle className="lp-node-ring" cx={x} cy={y} r={radius + 3.5} />}
              </g>
            );
          })}
      </svg>

      {notice !== null && (
        <div className="lp-layer-notice" role="status">
          {notice}
        </div>
      )}


      {menu !== null && (
        <div className="lp-curve-menu" style={{ left: menu.x, top: menu.y }} role="menu" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => applySegmentMode(menu.segmentIndex, 'auto')}>
            该段自动平滑
          </button>
          <button type="button" role="menuitem" onClick={() => applySegmentMode(menu.segmentIndex, 'linear')}>
            该段改为直线
          </button>
          <button type="button" role="menuitem" onClick={() => applySegmentMode(menu.segmentIndex, 'bezier')}>
            编辑控制柄（转贝塞尔）
          </button>
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            disabled={isEndpoint}
            title={isEndpoint ? '首尾端点不可删除（可改高度）' : '删除该节点'}
            onClick={() => applyRemoveNode(menu.nodeId)}
          >
            删除节点
          </button>
        </div>
      )}
    </div>
  );
}