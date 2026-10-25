/**
 * 确认对话框承载层（规格 12：删除行为分级 / 危险操作确认）。
 *
 * 展示 feedbackStore.confirm() 弹出的确认请求。要求：
 * - 必须说清具体影响（impact 文案，而非"确定删除吗"）；
 * - Esc / 点击遮罩 = 取消；Enter 提交主操作；
 * - 打开时焦点落在取消按钮（危险操作默认不误触确认）。
 */

import { useEffect, useRef } from 'react';
import { feedbackStore } from '../feedback/instance';
import { useFeedbackSnapshot } from '../feedback/hooks';

export function ConfirmHost() {
  const snapshot = useFeedbackSnapshot();
  const confirm = snapshot.confirm;
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirm === null) {
      return undefined;
    }
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        feedbackStore.resolveConfirm(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [confirm]);

  if (confirm === null) {
    return null;
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          feedbackStore.resolveConfirm(false);
        }
      }}
    >
      <div
        className={`dialog dialog--confirm${confirm.danger ? ' dialog--danger' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            feedbackStore.resolveConfirm(true);
          }
        }}
      >
        <h2 id="confirm-dialog-title">{confirm.title}</h2>
        <p id="confirm-dialog-message" className="dialog-confirm-message">
          {confirm.message}
        </p>
        {confirm.impact !== null && (
          <p className="dialog-confirm-impact">
            <strong>影响：</strong>
            {confirm.impact}
          </p>
        )}
        <div className="dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="dialog-button-secondary"
            onClick={() => feedbackStore.resolveConfirm(false)}
          >
            {confirm.cancelLabel}
          </button>
          <button
            type="button"
            className={confirm.danger ? 'danger-button' : 'primary-button'}
            onClick={() => feedbackStore.resolveConfirm(true)}
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
