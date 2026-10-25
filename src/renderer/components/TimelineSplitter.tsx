/**
 * TimelineSplitter：分析监视器与时间线之间的可拖动水平分割线（规格：可调整高度）。
 *
 * 行为：
 * - Pointer Events + 指针捕获：拖出分割线范围仍持续生效；
 * - 向上拖动扩大时间线，向下拖动缩小；双击恢复默认高度；
 * - 松开 / 取消 / 窗口失焦 / Escape 均正确结束拖动（取消不提交）；
 * - 键盘：获焦后用 ↑/↓ 微调（Shift 加大步长）；
 * - 可访问性：role="separator" + aria-orientation / valuenow / valuemin / valuemax。
 *
 * 视觉克制：默认 1px 细线，可点击区 10px；悬停/拖动时轻量高亮。高度限制与
 * 换算全部来自 ../editor/layout，组件只做事件接线。
 */
import { useEffect, useReducer, useRef } from 'react';
import {
  SPLITTER_KEY_STEP,
  SPLITTER_KEY_STEP_LARGE,

  nudgeTimelineHeight,
  splitterCommitHeight,
  splitterIdle,
  splitterReducer,
  type TimelineLimits,
} from '../editor/layout';

export interface TimelineSplitterProps {
  /** 已提交的时间线高度（拖动起点与无预览时的取值）。 */
  height: number;
  limits: TimelineLimits;
  /** 拖动中的实时预览高度（不写盘）。 */
  onPreview(height: number): void;
  /** 拖动结束提交最终高度（一次写入视图状态）。 */
  onCommit(height: number): void;
  /** 双击恢复默认高度。 */
  onReset(): void;
  /** 拖动起止通知（供外部禁用文本选择等）。 */
  onDraggingChange?(dragging: boolean): void;
}

export function TimelineSplitter({
  height,
  limits,
  onPreview,
  onCommit,
  onReset,
  onDraggingChange,
}: TimelineSplitterProps) {
  const [state, dispatch] = useReducer(splitterReducer, undefined, () => splitterIdle(height));
  const stateRef = useRef(state);
  stateRef.current = state;
  const heightRef = useRef(height);
  heightRef.current = height;
  const limitsRef = useRef(limits);
  limitsRef.current = limits;
  const callbacksRef = useRef({ onPreview, onCommit, onReset, onDraggingChange });
  callbacksRef.current = { onPreview, onCommit, onReset, onDraggingChange };

  // 外部提交值同步进状态机（拖动中不覆盖，避免打断拖动）。
  useEffect(() => {
    dispatch({ type: 'sync', height });
  }, [height]);

  const finish = (commit: boolean): void => {
    const s = stateRef.current;
    if (!s.dragging) {
      return;
    }
    const finalHeight = splitterCommitHeight(s);
    dispatch({ type: commit ? 'end' : 'cancel' });
    callbacksRef.current.onDraggingChange?.(false);
    if (commit && finalHeight !== heightRef.current) {
      callbacksRef.current.onCommit(finalHeight);
    }
  };

  // 窗口失焦 / Escape 结束拖动（取消语义：不提交半途高度）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && stateRef.current.dragging) {
        event.preventDefault();
        finish(false);
      }
    };
    const onBlur = (): void => {
      finish(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
    };
    // finish 使用 ref，无需在依赖中列回调。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dispatch({ type: 'begin', pointerId: event.pointerId, y: event.clientY });
    callbacksRef.current.onDraggingChange?.(true);
    callbacksRef.current.onPreview(heightRef.current);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const s = stateRef.current;
    if (!s.dragging || s.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const limits = limitsRef.current;
    // 复用纯换算函数（避免在此处重复夹紧逻辑）。
    const moved = splitterReducer(s, { type: 'move', y: event.clientY, limits });
    dispatch({ type: 'move', y: event.clientY, limits });
    callbacksRef.current.onPreview(moved.preview ?? s.startHeight);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (stateRef.current.pointerId !== event.pointerId) {
      return;
    }
    finish(true);
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (stateRef.current.pointerId !== event.pointerId) {
      return;
    }
    finish(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return;
    }
    event.preventDefault();
    const step = event.shiftKey ? SPLITTER_KEY_STEP_LARGE : SPLITTER_KEY_STEP;
    const direction = event.key === 'ArrowUp' ? 'up' : 'down';
    const base = stateRef.current.preview ?? heightRef.current;
    const next = nudgeTimelineHeight(base, direction, step, limitsRef.current);
    callbacksRef.current.onPreview(next);
    callbacksRef.current.onCommit(next);
  };

  const effectiveHeight = state.preview ?? height;

  return (
    <div
      className={`lp-splitter${state.dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation="horizontal"
      aria-label="调整分析监视器与时间线高度"
      aria-valuenow={Math.round(effectiveHeight)}
      aria-valuemin={Math.round(limits.min)}
      aria-valuemax={Math.round(limits.max)}
      tabIndex={0}
      title="拖动调整时间线高度；双击恢复默认"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={() => finish(false)}
      onDoubleClick={() => callbacksRef.current.onReset()}
      onKeyDown={onKeyDown}
    >
      <span className="lp-splitter-grip" aria-hidden="true" />
    </div>
  );
}