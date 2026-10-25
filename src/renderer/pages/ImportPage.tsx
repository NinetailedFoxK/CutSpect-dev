import { useEffect, useMemo, useReducer, useState } from 'react';
import type { TaskEvent, TaskProgress } from '@shared/api-types';
import { formatTimeMs } from '@shared/time';
import { formatAspectRatio, formatBytes, formatResolution } from '../lib/format';
import type { ImportSourceMeta } from '../components/NewProjectDialog';
import { Icon } from '../components/Icons';

/**
 * 导入状态页 IMPORT（规格 2.4，阶段 A 步骤子集）。
 *
 * 步骤指示：检查 → 复制视频 → 读取信息 → 准备就绪
 * （试播与时间线缩略图属阶段 D，本阶段不显示，不做假步骤）。
 *
 * 真实数据来源：window.laipian.tasks.subscribe() 推送的 TaskEvent，
 * 过滤 projectId 匹配当前项目的事件；组件卸载时退订。
 * - copy / hash 任务的 bytes 进度 → 进度条 + MB 数字（totalBytes 未知时
 *   显示已处理字节数 + 不确定态进度条，不伪造总量与百分比）；
 * - probe 任务的 step 进度 → 显示当前步骤名；
 * - probe succeeded → onComplete()（App 切换到“正在进入工作台”中转态）；
 * - 任何任务 failed → 显示主进程给出的中文原因 + 返回项目库；
 * - cancelled → onCancelled() 返回项目库（临时文件清理由 main 负责，规格 2.4）。
 *
 * “取消导入”调用 tasks.cancel()；无 window.laipian 或尚无运行中任务时
 * 禁用并显示原因（不做假按钮）。
 * 浏览器预览模式渲染静态布局：进度 0%、按钮禁用 + 说明“需要桌面运行环境”。
 */

export interface ImportPageProps {
  hasApi: boolean;
  project: { projectId: string; projectName: string };
  /** 源视频元信息（名称/大小/时长/画面比例）；未能读取时为 null。 */
  source: ImportSourceMeta | null;
  /** 读取信息成功（导入完成）→ App 切换到工作台中转态。 */
  onComplete: () => void;
  /** 取消导入 / 失败后返回项目库。 */
  onCancelled: () => void;
  /** 导入失败后"重新导入"：返回项目库并重新打开新建弹窗。 */
  onRetry: () => void;
}

/** 步骤序号：0 检查 / 1 复制视频 / 2 读取信息 / 3 生成封面 / 4 准备就绪。 */
const IMPORT_STEPS = ['检查', '复制视频', '读取信息', '生成封面', '准备就绪'] as const;

type ImportPhase =
  | { kind: 'waiting' }
  | { kind: 'copying'; taskId: string; progress: TaskProgress | null }
  | { kind: 'copy-done' }
  | { kind: 'probing'; taskId: string; progress: TaskProgress | null }
  | { kind: 'covering' }
  | { kind: 'failed'; message: string; stepIndex: number }
  | { kind: 'cancelled' }
  | { kind: 'succeeded' };

/** 导入阶段（导出供 DOM 断言脚本与后续单测构造）。 */
export type { ImportPhase };

function activeStepIndex(phase: ImportPhase): number {
  switch (phase.kind) {
    case 'waiting':
      return 0;
    case 'copying':
      return 1;
    case 'copy-done':
      return 2;
    case 'probing':
      return 2;
    case 'covering':
      return 3;
    case 'failed':
      return phase.stepIndex;
    case 'cancelled':
      return 0;
    case 'succeeded':
      return 4;
  }
}

type ImportAction = { type: 'event'; event: TaskEvent };

/**
 * TaskEvent → 导入阶段的状态机（纯函数）。
 * 导出供 DOM 断言脚本与后续单测直接验证转换规则。
 */
export function importReducer(state: ImportPhase, action: ImportAction): ImportPhase {
  if (action.type !== 'event') {
    return state;
  }
  const event = action.event;
  // 终态不再接受迟到事件，避免覆盖结果。
  if (state.kind === 'failed' || state.kind === 'cancelled' || state.kind === 'succeeded') {
    return state;
  }

  switch (event.status) {
    case 'failed':
      return {
        kind: 'failed',
        message: event.message ?? '导入失败（主进程未提供具体原因）',
        stepIndex: activeStepIndex(state),
      };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'queued':
    case 'running':
      if (event.kind === 'copy' || event.kind === 'hash') {
        // 复制与流式哈希同属“复制视频”步骤（规格 2.4）。
        return { kind: 'copying', taskId: event.taskId, progress: event.progress };
      }
      if (event.kind === 'probe') {
        // "生成封面"是探测阶段内的后续步骤（规格 2.4），单独呈现但不改任务种类。
        if (
          event.progress !== null &&
          event.progress.kind === 'step' &&
          event.progress.step.includes('生成封面')
        ) {
          return { kind: 'covering' };
        }
        return { kind: 'probing', taskId: event.taskId, progress: event.progress };
      }
      // convert / thumbnails 属阶段 D，不驱动本页。
      return state;
    case 'succeeded':
      if (event.kind === 'copy' || event.kind === 'hash') {
        // 即使错过 running 事件也推进；探测已开始时保持探测态。
        return state.kind === 'probing' ? state : { kind: 'copy-done' };
      }
      if (event.kind === 'probe') {
        return { kind: 'succeeded' };
      }
      return state;
    default:
      return state;
  }
}

/** 步骤指示条的单步状态。 */
type StepVisualState = 'done' | 'active' | 'todo' | 'failed';

function stepVisualState(
  phase: ImportPhase,
  activeIndex: number,
  stepIndex: number,
): StepVisualState {
  if (phase.kind === 'failed' && phase.stepIndex === stepIndex) {
    return 'failed';
  }
  if (phase.kind === 'succeeded') {
    return 'done';
  }
  if (stepIndex < activeIndex) {
    return 'done';
  }
  if (stepIndex === activeIndex) {
    return 'active';
  }
  return 'todo';
}

/** bytes 进度的百分比（0-100）；totalBytes 未知返回 null。 */
function percentOf(progress: TaskProgress): number | null {
  if (progress.kind !== 'bytes' || progress.totalBytes === null || progress.totalBytes <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, (progress.completedBytes / progress.totalBytes) * 100));
}

/**
 * 导入进度面板（真实 TaskEvent 数据；浏览器预览模式固定 0%）。
 * 导出为独立组件供 DOM 断言脚本与后续单测直接渲染各分支。
 */
export function ImportProgressPanel({
  hasApi,
  phase,
}: {
  hasApi: boolean;
  phase: ImportPhase;
}) {
  if (!hasApi) {
    return (
      <div className="import-progress">
        <div
          className="import-progress-track"
          role="progressbar"
          aria-label="复制视频进度（预览模式，无真实进度）"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
        >
          <div className="import-progress-fill" style={{ width: '0%' }} />
        </div>
        <p className="import-progress-text">0.0 MB / —</p>
      </div>
    );
  }
  if (phase.kind === 'copying' && phase.progress !== null) {
    const percent = percentOf(phase.progress);
    if (phase.progress.kind === 'bytes') {
      const completedText = formatBytes(phase.progress.completedBytes);
      const totalText = formatBytes(phase.progress.totalBytes);
      if (percent !== null) {
        return (
          <div className="import-progress">
            <div
              className="import-progress-track"
              role="progressbar"
              aria-label="复制视频进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
            >
              <div className="import-progress-fill" style={{ width: `${percent.toFixed(1)}%` }} />
            </div>
            <p className="import-progress-text">
              {completedText} / {totalText}（{percent.toFixed(1)}%）
            </p>
          </div>
        );
      }
      // 总量未知：不确定态进度条 + 已处理字节（真实数据，不伪造总量）。
      return (
        <div className="import-progress">
          <div
            className="import-progress-track import-progress-track--indeterminate"
            role="progressbar"
            aria-label="复制视频进度（总量未知）"
          >
            <div className="import-progress-fill import-progress-fill--indeterminate" />
          </div>
          <p className="import-progress-text">已处理 {completedText}（总量未知）</p>
        </div>
      );
    }
    // step 进度（复制阶段的检查步骤名）。
    return (
      <div className="import-progress">
        <p className="import-progress-text">正在：{phase.progress.step}</p>
      </div>
    );
  }
  if (phase.kind === 'copy-done') {
    return (
      <div className="import-progress">
        <div
          className="import-progress-track"
          role="progressbar"
          aria-label="复制视频进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={100}
        >
          <div className="import-progress-fill" style={{ width: '100%' }} />
        </div>
        <p className="import-progress-text">复制完成，等待读取信息…</p>
      </div>
    );
  }
  if (phase.kind === 'probing') {
    return (
      <div className="import-progress">
        <p className="import-progress-text">
          {phase.progress !== null && phase.progress.kind === 'step'
            ? `正在：${phase.progress.step}`
            : '正在读取视频信息…（无可靠百分比，显示当前步骤）'}
        </p>
      </div>
    );
  }
  if (phase.kind === 'covering') {
    return (
      <div className="import-progress">
        <p className="import-progress-text">正在生成封面…（完成后即进入工作台）</p>
      </div>
    );
  }
  return (
    <div className="import-progress">
      <p className="import-progress-text">正在检查导入条件，等待任务事件…</p>
    </div>
  );
}

export function ImportPage({
  hasApi,
  project,
  source,
  onComplete,
  onCancelled,
  onRetry,
}: ImportPageProps) {
  const [phase, dispatch] = useReducer(importReducer, { kind: 'waiting' } as ImportPhase);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // 订阅当前项目的后台任务事件；卸载时退订（契约：返回取消订阅函数）。
  useEffect(() => {
    const api = window.laipian;
    if (!api) {
      return undefined;
    }
    const unsubscribe = api.tasks.subscribe((event) => {
      if (event.projectId !== project.projectId) {
        return;
      }
      dispatch({ type: 'event', event });
    });
    return unsubscribe;
  }, [project.projectId]);

  // 补齐早期事件：create 返回后本页才挂载订阅，可能错过 queued/running
  // （复制很快的小文件尤甚）。拉取 tasks.snapshot 重放该项目已发生的事件，
  // 避免页面停在“等待事件”而永远不触发 onComplete。
  useEffect(() => {
    const api = window.laipian;
    if (!api) {
      return undefined;
    }
    let cancelled = false;
    void api.tasks.snapshot({ projectId: project.projectId }).then((result) => {
      if (cancelled || !result.ok) {
        return;
      }
      // 按时间升序重放；reducer 对终态幂等。
      for (const event of result.data) {
        dispatch({ type: 'event', event });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [project.projectId]);

  // 读取信息成功 → 导入完成。
  useEffect(() => {
    if (phase.kind === 'succeeded') {
      onComplete();
    }
  }, [phase.kind, onComplete]);

  // 任务取消（事件确认）→ 返回项目库。
  useEffect(() => {
    if (phase.kind === 'cancelled') {
      onCancelled();
    }
  }, [phase.kind, onCancelled]);

  const activeTaskId =
    phase.kind === 'copying' || phase.kind === 'probing' ? phase.taskId : null;

  const cancelDisabledReason = !hasApi
    ? '需要桌面运行环境（浏览器预览模式无后台任务）'
    : cancelling
      ? '正在请求取消…'
      : activeTaskId === null
        ? '当前没有可取消的运行中任务（等待主进程任务事件）'
        : null;

  const cancelImport = async (): Promise<void> => {
    const api = window.laipian;
    if (!api || activeTaskId === null) {
      return;
    }
    setCancelling(true);
    setCancelError(null);
    try {
      const result = await api.tasks.cancel({ taskId: activeTaskId });
      if (!result.ok) {
        setCancelError(`取消失败：${result.error.message}`);
        return;
      }
      // 取消请求已被 main 受理：返回项目库，临时文件清理由 main 负责（规格 2.4）。
      onCancelled();
    } finally {
      setCancelling(false);
    }
  };

  const activeIndex = activeStepIndex(phase);
  const steps = useMemo(
    () =>
      IMPORT_STEPS.map((label, index) => ({
        label,
        index,
        visual: stepVisualState(phase, activeIndex, index),
      })),
    [phase, activeIndex],
  );

  return (
    <div className="import-page">
      <header className="import-header">
        <h1>正在导入「{project.projectName}」</h1>
        <p className="import-header-sub">
          视频将复制到项目文件夹，原文件保持不变（规格 2.4）。
        </p>
        {source !== null && (
          <dl className="import-source-meta">
            <div className="import-source-meta-row">
              <dt>视频</dt>
              <dd title={source.fileName}>{source.fileName}</dd>
            </div>
            <div className="import-source-meta-row">
              <dt>大小</dt>
              <dd>{formatBytes(source.sizeBytes)}</dd>
            </div>
            <div className="import-source-meta-row">
              <dt>时长</dt>
              <dd>{source.durationMs !== null ? formatTimeMs(source.durationMs) : '—'}</dd>
            </div>
            <div className="import-source-meta-row">
              <dt>画面比例</dt>
              <dd>
                {source.width !== null && source.height !== null
                  ? `${formatResolution(source.width, source.height)} · ${formatAspectRatio(source.width, source.height)}`
                  : '—'}
              </dd>
            </div>
          </dl>
        )}
      </header>

      <ol className="import-steps" aria-label="导入步骤">
        {steps.map(({ label, index, visual }) => (
          <li key={label} className={`import-step import-step--${visual}`}>
            <span className="import-step-dot" aria-hidden="true">
              {visual === 'done' ? (
                <Icon name="check" size={12} />
              ) : visual === 'failed' ? (
                <Icon name="close" size={12} />
              ) : (
                index + 1
              )}
            </span>
            <span className="import-step-label">{label}</span>
            {visual === 'active' && <span className="import-step-current">进行中</span>}
          </li>
        ))}
      </ol>

      <section className="import-body">
        {phase.kind === 'failed' ? (
          <div className="import-error-card" role="alert">
            <h2>导入失败</h2>
            <p>{phase.message}</p>
            <p className="import-error-hint">源视频文件未被修改；可重新选择视频再试一次。</p>
            <div className="import-error-actions">
              <button type="button" className="primary-button" onClick={onRetry}>
                <Icon name="retry" />
                <span>重新导入</span>
              </button>
              <button type="button" className="dialog-button-secondary" onClick={onCancelled}>
                <Icon name="arrow-left" />
                <span>返回项目库</span>
              </button>
            </div>
          </div>
        ) : (
          <>
            <ImportProgressPanel hasApi={hasApi} phase={phase} />
            {!hasApi && (
              <div className="import-preview-note" role="note">
                浏览器预览模式：导入进度来自真实后台任务事件（window.laipian.tasks.subscribe），
                需要桌面运行环境。此处仅展示静态布局，不模拟进度。
              </div>
            )}
            {cancelError !== null && (
              <p className="import-cancel-error" role="alert">
                {cancelError}
              </p>
            )}
            <div className="import-actions">
              <button
                type="button"
                className="dialog-button-secondary"
                disabled={cancelDisabledReason !== null}
                title={cancelDisabledReason ?? '停止当前进程并清理本次未完成临时文件，返回项目库'}
                onClick={() => void cancelImport()}
              >
                <Icon name="close" />
                <span>{cancelling ? '正在取消…' : '取消导入'}</span>
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}