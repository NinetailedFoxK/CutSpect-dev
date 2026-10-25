/**
 * 后台任务中心（批次 1 基础设施）。
 *
 * 规格 11（后台处理必须有明确结尾）：缩略图、兼容副本、导入、镜头识别等
 * 后台工作都需要统一回答"是否进行中 / 当前在做什么 / 能否取消 /
 * 是否可继续编辑 / 成功生成了什么 / 失败原因 / 如何重试"。
 *
 * 本模块把 main 推送的 TaskEvent（tasks.subscribe）收敛为可渲染的条目列表：
 * - 按 taskId 合并事件为一条 TaskCenterEntry；
 * - 调用方可在任务启动后用 announce() 注册人类可读名称与"重试"回调
 *   （任务事件本身不含 kind 之外的信息，重试动作是 renderer 的职责）；
 * - 纯逻辑、不依赖 React/Electron，可在 vitest 下测试。
 */

import type { TaskEvent, TaskKind, TaskProgress, TaskStatus } from '@shared/api-types';

export interface TaskCenterEntry {
  taskId: string;
  kind: TaskKind;
  projectId: string | null;
  status: TaskStatus;
  progress: TaskProgress | null;
  message: string | null;
  updatedAt: string;
  /** 人类可读名称（announce 提供，否则由 kind 推导）。 */
  label: string;
  /** 失败时的重试动作；未注册时为 null。 */
  retry: (() => void | Promise<void>) | null;
}

/** 任务种类 → 中文名称（规格 15：统一术语，不混用同义表达）。 */
export const TASK_KIND_LABEL: Record<TaskKind, string> = {
  copy: '复制视频',
  hash: '校验视频',
  probe: '读取视频信息',
  convert: '生成兼容副本',
  thumbnails: '生成缩略图',
  'shot-detect': '识别镜头',
  export: '导出',
};

/** 任务是否仍在进行（用于"运行中"分组与"可取消"判断）。 */
export function isActiveStatus(status: TaskStatus): boolean {
  return status === 'queued' || status === 'running';
}

export function isFinishedStatus(status: TaskStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export type TaskEventSource = {
  subscribe(listener: (event: TaskEvent) => void): () => void;
};

export interface AnnounceInput {
  taskId: string;
  /** 覆盖默认名称（如"生成封面"）。 */
  label?: string;
  retry?: () => void | Promise<void>;
}

export interface TaskCenterStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TaskCenterEntry[];
  /** 任务启动后登记展示名 / 重试回调（可先于或后于首个事件）。 */
  announce(input: AnnounceInput): void;
  /** 订阅任务事件源并合并；返回停止订阅函数。 */
  attachSource(source: TaskEventSource): () => void;
  /** 从列表移除一条已结束的任务。 */
  dismiss(taskId: string): void;
  /** 清空所有已结束任务（保留运行中）。 */
  clearFinished(): void;
}

export function createTaskCenterStore(): TaskCenterStore {
  const entries = new Map<string, TaskCenterEntry>();
  let snapshot: TaskCenterEntry[] = [];
  const listeners = new Set<() => void>();

  const rebuild = (): void => {
    const list = [...entries.values()].sort((a, b) =>
      a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0,
    );
    snapshot = list;
  };

  const publish = (): void => {
    rebuild();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // 单个订阅者异常不影响其余订阅者。
      }
    }
  };

  const upsert = (event: TaskEvent): void => {
    const previous = entries.get(event.taskId);
    const next: TaskCenterEntry = {
      taskId: event.taskId,
      kind: event.kind,
      projectId: event.projectId,
      status: event.status,
      progress: event.progress,
      message: event.message,
      updatedAt: event.updatedAt,
      label: previous?.label ?? TASK_KIND_LABEL[event.kind],
      retry: previous?.retry ?? null,
    };
    entries.set(event.taskId, next);
    publish();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot: () => snapshot,

    announce(input) {
      const existing = entries.get(input.taskId);
      if (existing === undefined) {
        // 尚未收到首个事件：先登记一条占位（merge 后到达的真实事件）。
        entries.set(input.taskId, {
          taskId: input.taskId,
          kind: 'probe',
          projectId: null,
          status: 'queued',
          progress: null,
          message: null,
          updatedAt: new Date().toISOString(),
          label: input.label ?? '后台任务',
          retry: input.retry ?? null,
        });
      } else {
        entries.set(input.taskId, {
          ...existing,
          label: input.label ?? existing.label,
          retry: input.retry ?? existing.retry,
        });
      }
      publish();
    },

    attachSource(source) {
      return source.subscribe((event) => {
        upsert(event);
      });
    },

    dismiss(taskId) {
      if (entries.delete(taskId)) {
        publish();
      }
    },

    clearFinished() {
      let changed = false;
      for (const [taskId, entry] of entries) {
        if (isFinishedStatus(entry.status)) {
          entries.delete(taskId);
          changed = true;
        }
      }
      if (changed) {
        publish();
      }
    },
  };
}