/**
 * PanelSplitter：右侧检查器宽度分割线（方案 §4：检查器 320 / 最小 280 / 最大 440）。
 *
 * 与分析监视器-时间线分割线（TimelineSplitter）职责相同，仅方向为竖直：
 * - Pointer Events + 指针捕获；向左拖动使面板变宽；
 * - 双击恢复默认宽度；键盘 ←/→（Shift 加大步长）；
 * - 松开 / 取消 / 失焦 / Escape 正确结束拖动；
 * - role="separator" + aria-orientation="vertical" + 当前/最小/最大。
 */
import { useEffect, useReducer, useRef } from 'react';
import {
  SPLITTER_KEY_STEP,
  SPLITTER_KEY_STEP_LARGE,
  widthFromDrag,
  type PanelLimits,
} from '../editor/layout';

export interface PanelSplitterProps {
  width: number;
  limits: PanelLimits;
  onPreview(width: number): void;
  onCommit(width: number): void;
  onReset(): void;
  onDraggingChange?(dragging: boolean): void;
}

interface State {
  dragging: boolean;
  pointerId: number | null;
  startX: number;
  startWidth: number;
  preview: number | null;
}

type Action =
  | { type: 'sync'; width: number }
  | { type: 'begin'; pointerId: number; x: number }
  | { type: 'move'; x: number; limits: PanelLimits }
  | { type: 'end' };

const idle = (width: number): State => ({
  dragging: false,
  pointerId: null,
  startX: 0,
  startWidth: width,
  preview: null,
});

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'sync':
      return state.dragging ? state : { ...state, startWidth: action.width };
    case 'begin':
      return {
        dragging: true,
        pointerId: action.pointerId,
        startX: action.x,
        startWidth: state.startWidth,
        preview: state.startWidth,
      };
    case 'move':
      if (!state.dragging) return state;
      return { ...state, preview: widthFromDrag(state.startWidth, action.x - state.startX, action.limits) };
    case 'end':
      if (!state.dragging) return state;
      return { ...state, dragging: false, pointerId: null, preview: null };
    default:
      return state;
  }
}

export function PanelSplitter({
  width,
  limits,
  onPreview,
  onCommit,
  onReset,
  onDraggingChange,
}: PanelSplitterProps) {
  const [state, dispatch] = useReducer(reducer, undefined, () => idle(width));
  const stateRef = useRef(state);
  stateRef.current = state;
  const widthRef = useRef(width);
  widthRef.current = width;
  const limitsRef = useRef(limits);
  limitsRef.current = limits;
  const cbRef = useRef({ onPreview, onCommit, onReset, onDraggingChange });
  cbRef.current = { onPreview, onCommit, onReset, onDraggingChange };

  useEffect(() => {
    dispatch({ type: 'sync', width });
  }, [width]);

  const finish = (commit: boolean): void => {
    const s = stateRef.current;
    if (!s.dragging) return;
    const finalWidth = s.preview ?? s.startWidth;
    dispatch({ type: 'end' });
    cbRef.current.onDraggingChange?.(false);
    if (commit && finalWidth !== widthRef.current) {
      cbRef.current.onCommit(finalWidth);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && stateRef.current.dragging) {
        event.preventDefault();
        finish(false);
      }
    };
    const onBlur = (): void => finish(false);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dispatch({ type: 'begin', pointerId: event.pointerId, x: event.clientX });
    cbRef.current.onDraggingChange?.(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const s = stateRef.current;
    if (!s.dragging || s.pointerId !== event.pointerId) return;
    event.preventDefault();
    const limits = limitsRef.current;
    const next = widthFromDrag(s.startWidth, event.clientX - s.startX, limits);
    dispatch({ type: 'move', x: event.clientX, limits });
    cbRef.current.onPreview(next);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (stateRef.current.pointerId !== event.pointerId) return;
    finish(true);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? SPLITTER_KEY_STEP_LARGE : SPLITTER_KEY_STEP;
    // ← 使面板变宽（+），→ 使面板变窄（-）。
    const delta = event.key === 'ArrowLeft' ? step : -step;
    const base = stateRef.current.preview ?? widthRef.current;
    const next = Math.round(Math.min(limitsRef.current.max, Math.max(limitsRef.current.min, base + delta)));
    cbRef.current.onPreview(next);
    cbRef.current.onCommit(next);
  };

  const effective = state.preview ?? width;

  return (
    <div
      className={`lp-panel-splitter${state.dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整检查器宽度"
      aria-valuenow={Math.round(effective)}
      aria-valuemin={Math.round(limits.min)}
      aria-valuemax={Math.round(limits.max)}
      tabIndex={0}
      title="拖动调整检查器宽度；双击恢复默认"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={(e) => {
        if (stateRef.current.pointerId === e.pointerId) finish(false);
      }}
      onLostPointerCapture={() => finish(false)}
      onDoubleClick={() => cbRef.current.onReset()}
      onKeyDown={onKeyDown}
    />
  );
}