/**
 * 后台任务中心（规格 11：后台处理必须有明确结尾）。
 *
 * 固定于右下角：有任务时显示入口按钮（带运行中数量徽标），点击展开抽屉，
 * 分为"进行中"（进度 / 取消）与"已结束"（成功 / 失败原因 / 重试）。
 * 无任何任务时不渲染入口，避免打扰。
 */

import { useState } from 'react';
import type { TaskProgress } from '@shared/api-types';
import { formatBytes } from '../lib/format';
import { taskCenterStore } from '../feedback/instance';
import { useTaskCenterEntries } from '../feedback/hooks';
import { isActiveStatus, isFinishedStatus } from '../feedback/task-center-store';
import type { TaskCenterEntry } from '../feedback/task-center-store';

/** 进度的人类可读文案（bytes → MB 数字；step → 当前步骤名）。 */
export function taskProgressText(progress: TaskProgress | null): string | null {
  if (progress === null) {
    return null;
  }
  if (progress.kind === 'bytes') {
    return `${formatBytes(progress.completedBytes)} / ${formatBytes(progress.totalBytes)}`;
  }
  return progress.step;
}

const STATUS_TEXT: Record<TaskCenterEntry['status'], string> = {
  queued: '排队中',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function TaskRow({ entry }: { entry: TaskCenterEntry }) {
  const active = isActiveStatus(entry.status);
  const progressText = taskProgressText(entry.progress);
  const canCancel =
    active && typeof window !== 'undefined' && window.laipian !== undefined;

  return (
    <li className={`task-row task-row--${entry.status}`}>
      <div className="task-row-head">
        <span className="task-row-label">{entry.label}</span>
        <span className="task-row-status">{STATUS_TEXT[entry.status]}</span>
      </div>
      {progressText !== null && <p className="task-row-progress">{progressText}</p>}
      {entry.message !== null && <p className="task-row-message">{entry.message}</p>}
      <div className="task-row-actions">
        {canCancel && (
          <button
            type="button"
            className="dialog-button-secondary"
            onClick={() => {
              void window.laipian?.tasks.cancel({ taskId: entry.taskId });
            }}
          >
            取消
          </button>
        )}
        {entry.status === 'failed' && entry.retry !== null && (
          <button
            type="button"
            className="dialog-button-secondary"
            onClick={() => {
              void entry.retry?.();
            }}
          >
            重试
          </button>
        )}
        {isFinishedStatus(entry.status) && (
          <button
            type="button"
            className="task-row-dismiss"
            aria-label="从任务中心移除"
            title="从任务中心移除"
            onClick={() => {
              taskCenterStore.dismiss(entry.taskId);
            }}
          >
            ×
          </button>
        )}
      </div>
    </li>
  );
}

export function TaskCenter({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const entries = useTaskCenterEntries();
  const [open, setOpen] = useState(defaultOpen);

  if (entries.length === 0) {
    return null;
  }

  const active = entries.filter((e) => isActiveStatus(e.status));
  const finished = entries
    .filter((e) => isFinishedStatus(e.status))
    .slice()
    .reverse();

  return (
    <div className="task-center">
      {open && (
        <div className="task-center-panel" role="dialog" aria-label="后台任务">
          <header className="task-center-header">
            <h2>后台任务</h2>
            <div className="task-center-header-actions">
              {finished.length > 0 && (
                <button
                  type="button"
                  className="task-center-clear"
                  onClick={() => {
                    taskCenterStore.clearFinished();
                  }}
                >
                  清除已完成
                </button>
              )}
              <button
                type="button"
                className="task-center-close"
                aria-label="收起任务中心"
                title="收起"
                onClick={() => {
                  setOpen(false);
                }}
              >
                ×
              </button>
            </div>
          </header>
          {active.length > 0 && (
            <>
              <p className="task-center-section">进行中</p>
              <ul className="task-center-list">
                {active.map((entry) => (
                  <TaskRow key={entry.taskId} entry={entry} />
                ))}
              </ul>
            </>
          )}
          {finished.length > 0 && (
            <>
              <p className="task-center-section">已结束</p>
              <ul className="task-center-list">
                {finished.map((entry) => (
                  <TaskRow key={entry.taskId} entry={entry} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <button
        type="button"
        className="task-center-toggle"
        aria-expanded={open}
        title="后台任务"
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <span aria-hidden="true">⧗</span>
        <span className="task-center-toggle-label">任务</span>
        {active.length > 0 && <span className="task-center-badge">{active.length}</span>}
      </button>
    </div>
  );
}
