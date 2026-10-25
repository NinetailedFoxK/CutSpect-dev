/**
 * 统一用户反馈中枢（批次 1 基础设施）。
 *
 * 背景：此前"结果反馈"散落在各页面自建状态（Home 的 notice/removedToast、
 * App 的 errorText、各页 inline 错误卡片），导致每个操作都要各自重复实现
 * "成功提示 / 失败提示 / 撤销入口 / 确认弹窗"。本模块把这类反馈收敛为
 * 一个发布/订阅中枢，按操作生命周期（规格 0 的六个环节）提供三类原语：
 *
 *   pushToast   —— 即时反馈（成功/失败/信息），可带一个动作按钮（如"撤销"）。
 *   showBanner  —— 需要用户处理的通知（错误/提醒），可带多个"下一步"按钮。
 *   confirm     —— 会产生连带影响的危险操作二次确认（必须说清影响）。
 *
 * 设计约束（与 playhead-store 一致）：
 * - 纯逻辑、不依赖 React、不依赖 Electron，可在 vitest 下完整测试；
 * - subscribe 的单个 listener 抛错不影响其余订阅者；
 * - getSnapshot 返回稳定引用（仅在状态变化时重建），以适配 useSyncExternalStore。
 */

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  detail?: string;
  action?: ToastAction;
  /** 自动消失毫秒数；0 表示需用户手动关闭（用于必须被读到的错误）。 */
  durationMs: number;
}

export interface BannerAction {
  label: string;
  /** 主操作按钮高亮；每个 banner 最多一个 primary。 */
  primary?: boolean;
  run: () => void | Promise<void>;
}

/** 需要用户处理的横幅通知（错误→下一步；异常恢复等）。 */
export interface Banner {
  id: string;
  kind: 'error' | 'info';
  title: string;
  message: string;
  actions: BannerAction[];
  /** 面向开发者的技术详情；UI 折叠在"复制诊断信息"里，不吓到普通创作者。 */
  diagnostics?: string;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  /** 具体影响说明（规格 12：避免只写"确定删除吗"）。 */
  impact?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PendingConfirm {
  id: string;
  title: string;
  message: string;
  impact: string | null;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  resolve: (confirmed: boolean) => void;
}

export interface FeedbackSnapshot {
  toasts: Toast[];
  banner: Banner | null;
  confirm: PendingConfirm | null;
}

export interface PushToastInput {
  kind: ToastKind;
  message: string;
  detail?: string;
  action?: ToastAction;
  /** 缺省：success/info 4 秒自动消失；error 7 秒；带 action 时 6 秒。 */
  durationMs?: number;
}

export interface FeedbackStore {
  getSnapshot(): FeedbackSnapshot;
  subscribe(listener: () => void): () => void;
  /** 即时反馈；返回 toast id。 */
  pushToast(input: PushToastInput): string;
  dismissToast(id: string): void;
  /** 展示需要处理的通知横幅（同时只保留一条，后到覆盖先到）。 */
  showBanner(input: Omit<Banner, 'id'>): string;
  clearBanner(): void;
  /** 弹出确认对话框；用户选择后 Promise resolve 为 true/false。 */
  confirm(options: ConfirmOptions): Promise<boolean>;
  resolveConfirm(confirmed: boolean): void;
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}-${Date.now().toString(36)}`;
}

const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 4000,
  info: 4000,
  error: 7000,
};

export function createFeedbackStore(): FeedbackStore {
  let toasts: Toast[] = [];
  let banner: Banner | null = null;
  let confirm: PendingConfirm | null = null;
  let snapshot: FeedbackSnapshot = { toasts, banner, confirm };
  const listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const publish = (): void => {
    snapshot = { toasts: [...toasts], banner, confirm };
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // 单个订阅者异常不影响其余订阅者。
      }
    }
  };

  const clearTimer = (id: string): void => {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
  };

  const removeToast = (id: string): void => {
    clearTimer(id);
    const next = toasts.filter((t) => t.id !== id);
    if (next.length === toasts.length) {
      return;
    }
    toasts = next;
    publish();
  };

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    pushToast(input) {
      const id = nextId('toast');
      const durationMs =
        input.durationMs ??
        (input.action !== undefined ? 6000 : DEFAULT_DURATION[input.kind]);
      const toast: Toast = {
        id,
        kind: input.kind,
        message: input.message,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.action !== undefined ? { action: input.action } : {}),
        durationMs,
      };
      toasts = [...toasts, toast];
      publish();
      if (durationMs > 0) {
        timers.set(
          id,
          setTimeout(() => {
            removeToast(id);
          }, durationMs),
        );
      }
      return id;
    },

    dismissToast(id) {
      removeToast(id);
    },

    showBanner(input) {
      banner = { id: nextId('banner'), ...input };
      publish();
      return banner.id;
    },

    clearBanner() {
      if (banner === null) {
        return;
      }
      banner = null;
      publish();
    },

    confirm(options) {
      return new Promise<boolean>((resolve) => {
        // 同时只处理一条确认；未决的旧请求按"取消"处理，避免悬挂。
        if (confirm !== null) {
          confirm.resolve(false);
        }
        confirm = {
          id: nextId('confirm'),
          title: options.title,
          message: options.message,
          impact: options.impact ?? null,
          confirmLabel: options.confirmLabel,
          cancelLabel: options.cancelLabel ?? '取消',
          danger: options.danger ?? false,
          resolve,
        };
        publish();
      });
    },

    resolveConfirm(confirmed) {
      const current = confirm;
      if (current === null) {
        return;
      }
      confirm = null;
      publish();
      current.resolve(confirmed);
    },
  };
}