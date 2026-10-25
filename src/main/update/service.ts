/**
 * 自动更新编排服务（纯依赖注入，不 import Electron，可在 vitest 中直接测试）。
 *
 * 状态机：
 *   disabled ──（未配置/开发环境）
 *   idle → checking → up-to-date
 *   idle → checking → available（后台下载中）→ ready（可重启安装）
 *   * → error（任何异常都不冒泡，不阻塞应用）
 *
 * 约束：
 * - 不在开发环境检查（由 config.enabled 决定）；
 * - 首次安装启动延长检查延迟（isFirstRun）；
 * - 更新失败只更新状态与消息，绝不影响应用启动与项目保存；
 * - 不在此处接触任何 Token（更新源为公开仓库 / 官方托管）。
 */
import { INITIAL_UPDATE_STATE } from '../../shared/update';
import type { ResolvedUpdateConfig, UpdateState } from '../../shared/update';

/** Electron autoUpdater 的最小依赖面（便于注入假实现测试）。 */
export interface UpdateAutoUpdater {
  autoDownload: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
}

export interface UpdateServiceDeps {
  config: ResolvedUpdateConfig;
  currentVersion: string;
  autoUpdater: UpdateAutoUpdater;
  /** 注入定时器（main 用 setTimeout），便于测试同步驱动。 */
  schedule(fn: () => void, delayMs: number): unknown;
  /** 状态变更回调：main 侧转发给所有窗口。 */
  onState(state: UpdateState): void;
  /** 是否首次安装启动（--squirrel-firstrun）。 */
  isFirstRun?: boolean;
  logger?: (message: string) => void;
}

export interface UpdateService {
  getState(): UpdateState;
  /** 绑定事件并按延迟调度检查；disabled 时直接置为 disabled 状态。 */
  start(): void;
  /** 主动检查（manual=true 时即使刚检查过也可再次触发）。 */
  check(manual?: boolean): void;
  /** 用户确认后重启并安装。 */
  install(): void;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return '更新时发生未知错误。';
}

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const { config, autoUpdater, schedule, onState } = deps;
  const logger = deps.logger ?? ((): void => undefined);
  let state: UpdateState = { ...INITIAL_UPDATE_STATE };
  let checking = false;

  function publish(next: UpdateState): void {
    state = next;
    try {
      onState(state);
    } catch (error) {
      logger(`[update] onState 回调异常：${describeError(error)}`);
    }
  }

  function patch(partial: Partial<UpdateState>): void {
    publish({ ...state, ...partial });
  }

  function bindEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      checking = true;
      patch({ status: 'checking', message: '正在检查更新…' });
    });
    autoUpdater.on('update-available', () => {
      patch({ status: 'available', message: '发现新版本，正在后台下载…' });
    });
    autoUpdater.on('update-not-available', () => {
      checking = false;
      patch({ status: 'up-to-date', message: null });
    });
    autoUpdater.on('update-downloaded', (...args: unknown[]) => {
      checking = false;
      const releaseName = typeof args[1] === 'string' ? args[1] : null;
      patch({
        status: 'ready',
        version: releaseName ?? state.version,
        percent: 100,
        canInstall: true,
        message: '更新已准备好，可重启并安装。',
      });
    });
    autoUpdater.on('error', (error: unknown) => {
      checking = false;
      const message = describeError(error);
      logger(`[update] 更新错误（已忽略，不影响使用）：${message}`);
      patch({ status: 'error', canInstall: false, message: `更新失败：${message}` });
    });
  }

  function start(): void {
    if (!config.enabled || config.feedUrl === null) {
      publish({
        ...INITIAL_UPDATE_STATE,
        status: 'disabled',
        message:
          config.reason === 'dev'
            ? null
            : '当前构建未启用自动更新。',
      });
      return;
    }
    try {
      autoUpdater.autoDownload = true;
      autoUpdater.setFeedURL({ url: config.feedUrl });
    } catch (error) {
      logger(`[update] 配置更新源失败（已忽略）：${describeError(error)}`);
      publish({
        ...INITIAL_UPDATE_STATE,
        status: 'error',
        message: `更新不可用：${describeError(error)}`,
      });
      return;
    }
    bindEvents();
    publish({ ...INITIAL_UPDATE_STATE, status: 'idle' });
    const delay = deps.isFirstRun === true ? config.firstRunDelayMs : config.checkDelayMs;
    try {
      schedule(() => {
        check();
      }, delay);
    } catch (error) {
      logger(`[update] 调度检查失败（已忽略）：${describeError(error)}`);
    }
  }

  function check(manual = false): void {
    if (!config.enabled) {
      if (manual) {
        publish({ ...state, status: 'disabled', message: '当前构建未启用自动更新。' });
      }
      return;
    }
    if (checking || state.status === 'ready') {
      return;
    }
    try {
      checking = true;
      patch({ status: 'checking', message: '正在检查更新…' });
      autoUpdater.checkForUpdates();
    } catch (error) {
      checking = false;
      logger(`[update] 检查更新失败（已忽略）：${describeError(error)}`);
      patch({ status: 'error', canInstall: false, message: `检查更新失败：${describeError(error)}` });
    }
  }

  function install(): void {
    if (state.status !== 'ready') {
      return;
    }
    try {
      autoUpdater.quitAndInstall();
    } catch (error) {
      logger(`[update] 安装更新失败（已忽略）：${describeError(error)}`);
      patch({ status: 'error', canInstall: false, message: `安装更新失败：${describeError(error)}` });
    }
  }

  return {
    getState: () => state,
    start,
    check,
    install,
  };
}