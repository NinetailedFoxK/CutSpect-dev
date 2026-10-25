/**
 * Toast 承载层（即时反馈）。
 *
 * 统一渲染 feedbackStore 的 toast 队列：成功 / 失败 / 信息，可带一个动作
 * 按钮（如移除后的"撤销"）。位于视口右下角，多条纵向堆叠、最新在底部。
 */

import { feedbackStore } from '../feedback/instance';
import { useFeedbackSnapshot } from '../feedback/hooks';
import type { Toast } from '../feedback/feedback-store';

const TOAST_ICON: Record<Toast['kind'], string> = {
  success: '✓',
  error: '!',
  info: 'i',
};

function ToastItem({ toast }: { toast: Toast }) {
  return (
    <div className={`toast toast--${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      <span className="toast-icon" aria-hidden="true">
        {TOAST_ICON[toast.kind]}
      </span>
      <div className="toast-body">
        <p className="toast-message">{toast.message}</p>
        {toast.detail !== undefined && <p className="toast-detail">{toast.detail}</p>}
      </div>
      {toast.action !== undefined && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            feedbackStore.dismissToast(toast.id);
            void toast.action?.run();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="toast-close"
        aria-label="关闭提示"
        title="关闭提示"
        onClick={() => {
          feedbackStore.dismissToast(toast.id);
        }}
      >
        ×
      </button>
    </div>
  );
}

export function ToastHost() {
  const snapshot = useFeedbackSnapshot();
  if (snapshot.toasts.length === 0) {
    return null;
  }
  return (
    <div className="toast-host" aria-live="polite">
      {snapshot.toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
