import { randomUUID } from 'node:crypto';
import { err } from '../../shared/api-types';
import type { Result, TaskEvent, TaskKind, TaskProgress, TaskStatus } from '../../shared/api-types';

/**
 * 后台任务管理器（规格 10.4 / 12.3 第 4 层）。
 *
 * 职责：
 * - 为复制 / 探测 / 转码 / 缩略图等后台工作分配稳定 taskId，维护 queued →
 *   running → succeeded | failed | cancelled 状态机；
 * - 把事件（含真实进度与取消状态）广播给订阅者（main.ts 再转发到窗口）；
 * - 提供 cancel：置取消标记并 abort，运行体通过 signal 观察后返回 CANCELLED。
 *
 * 边界（规格 12.3）：任务状态属于“后台任务状态”层，绝不写入 project.json 正文；
 * 本模块不 import electron，可在纯 Node / vitest 下完整测试。
 */

export interface TaskContext {
  readonly taskId: string;
  /** 取消信号：运行体须观察它并尽快返回 CANCELLED（历史进度保留）。 */
  readonly signal: AbortSignal;
  /** 上报进度（bytes 或 step），会立即广播一次 running 事件。 */
  report(progress: TaskProgress): void;
  /** 便捷方法：上报当前步骤名（无可靠百分比的任务）。 */
  reportStep(step: string): void;
}

export interface RunTaskOptions {
  kind: TaskKind;
  /** 任务所属项目；与任何项目无关时为 null。 */
  projectId: string | null;
  /** 开始前上报的步骤名（可选）。 */
  initialStep?: string;
}

export interface RunningTaskInfo {
  taskId: string;
  kind: TaskKind;
  projectId: string | null;
}

export interface TaskManager {
  subscribe(listener: (event: TaskEvent) => void): () => void;
  /** 请求取消；任务不存在或已结束返回 false。 */
  cancel(taskId: string): boolean;
  isRunning(taskId: string): boolean;
  /** 某项目当前运行中的任务（用于同项目并发策略，如转码时暂停缩略图）。 */
  runningForProject(projectId: string): RunningTaskInfo[];
  /**
   * 返回该项目最近一次各任务事件（按时间升序）。
   * 用途：导入页在 createProject 之后才挂载订阅时，补齐可能错过的
   * 早期 queued/running 事件，避免页面停在“等待事件”而卡死。
   */
  snapshotForProject(projectId: string): TaskEvent[];
  /**
   * 启动任务并立即返回 taskId 与完成 Promise。
   * 用于“需要先把 taskId 返回给渲染层、再等其完成”的通道
   * （如 media.rebuildThumbnails 返回 { taskId }）。
   */
  startTask<T>(
    options: RunTaskOptions,
    fn: (ctx: TaskContext) => Promise<Result<T>>,
  ): { taskId: string; done: Promise<Result<T>> };
  /**
   * 运行一个后台任务并等待完成。fn 收到的 ctx 提供取消信号与进度上报；
   * fn 的返回 Result 决定终态：ok → succeeded；error.code=CANCELLED → cancelled；
   * 其余 error → failed。取消标记优先于返回值（用户取消即 cancelled）。
   */
  run<T>(options: RunTaskOptions, fn: (ctx: TaskContext) => Promise<Result<T>>): Promise<Result<T>>;
}

interface InternalTask {
  taskId: string;
  kind: TaskKind;
  projectId: string | null;
  controller: AbortController;
  cancelRequested: boolean;
  lastProgress: TaskProgress | null;
}

export function createTaskManager(): TaskManager {
  const listeners = new Set<(event: TaskEvent) => void>();
  const running = new Map<string, InternalTask>();
  // 每个任务的最新事件，供 snapshotForProject 补齐（上限保护，避免无界增长）。
  const latestEvents = new Map<string, TaskEvent>();
  const LATEST_EVENTS_LIMIT = 100;

  const emit = (
    task: InternalTask,
    status: TaskStatus,
    progress: TaskProgress | null,
    message: string | null,
  ): void => {
    const event: TaskEvent = {
      taskId: task.taskId,
      kind: task.kind,
      status,
      projectId: task.projectId,
      progress,
      message,
      updatedAt: new Date().toISOString(),
    };
    latestEvents.set(task.taskId, event);
    if (latestEvents.size > LATEST_EVENTS_LIMIT) {
      // 删除最早插入的条目（Map 保持插入顺序）。
      const oldestKey = latestEvents.keys().next().value;
      if (oldestKey !== undefined) {
        latestEvents.delete(oldestKey);
      }
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不影响其余订阅者与任务本体。
      }
    }
  };

  const startTask = <T>(
    options: RunTaskOptions,
    fn: (ctx: TaskContext) => Promise<Result<T>>,
  ): { taskId: string; done: Promise<Result<T>> } => {
    const task: InternalTask = {
      taskId: randomUUID(),
      kind: options.kind,
      projectId: options.projectId,
      controller: new AbortController(),
      cancelRequested: false,
      lastProgress: null,
    };
    running.set(task.taskId, task);

    emit(task, 'queued', null, options.initialStep ?? null);
    emit(task, 'running', options.initialStep ? { kind: 'step', step: options.initialStep } : null, null);

    const ctx: TaskContext = {
      taskId: task.taskId,
      signal: task.controller.signal,
      report: (progress) => {
        task.lastProgress = progress;
        emit(task, 'running', progress, null);
      },
      reportStep: (step) => {
        ctx.report({ kind: 'step', step });
      },
    };

    const done = (async (): Promise<Result<T>> => {
      let result: Result<T>;
      try {
        result = await fn(ctx);
      } catch (error) {
        // 防御：运行体未自行兜底时折叠为 INTERNAL，保证任务不悬挂。
        result = err('INTERNAL', error instanceof Error ? error.message : String(error));
      }
      // 终态判定：取消标记优先于返回值。
      const wasCancelled = task.cancelRequested || task.controller.signal.aborted;
      let status: TaskStatus;
      let message: string | null;
      if (wasCancelled) {
        status = 'cancelled';
        message = '任务已取消。';
      } else if (result.ok) {
        status = 'succeeded';
        message = null;
      } else if (result.error.code === 'CANCELLED') {
        status = 'cancelled';
        message = result.error.message;
      } else {
        status = 'failed';
        message = result.error.message;
      }
      emit(task, status, task.lastProgress, message);
      running.delete(task.taskId);
      return result;
    })();

    return { taskId: task.taskId, done };
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    cancel(taskId) {
      const task = running.get(taskId);
      if (!task) {
        return false;
      }
      task.cancelRequested = true;
      task.controller.abort();
      return true;
    },

    isRunning(taskId) {
      return running.has(taskId);
    },

    runningForProject(projectId) {
      const result: RunningTaskInfo[] = [];
      for (const task of running.values()) {
        if (task.projectId === projectId) {
          result.push({ taskId: task.taskId, kind: task.kind, projectId: task.projectId });
        }
      }
      return result;
    },

    snapshotForProject(projectId) {
      return [...latestEvents.values()]
        .filter((event) => event.projectId === projectId)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
    },

    startTask,

    run<T>(
      options: RunTaskOptions,
      fn: (ctx: TaskContext) => Promise<Result<T>>,
    ): Promise<Result<T>> {
      return startTask(options, fn).done;
    },
  };
}