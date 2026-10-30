/**
 * Squirrel.Windows 启动参数处理（规格：安装 / 首次 / 卸载 / 快捷方式）。
 *
 * Squirrel 在安装、更新、卸载时会用 `--squirrel-*` 参数启动应用一次：
 * - 应用必须在「创建窗口之前」处理这些参数并尽快退出，否则会闪出一个空窗口；
 * - 快捷方式由同目录的 `Update.exe --createShortcut/--removeShortcut` 维护。
 *
 * 本模块只做参数解析与命令编排（注入 spawn/quit），便于单元测试。
 */
import path from 'node:path';
import { parseSquirrelStartup } from '../../shared/update';
import type { SquirrelStartup } from '../../shared/update';

export { parseSquirrelStartup };
export type { SquirrelStartup };

/** 执行外部命令（注入实现；调用方用 child_process.spawn 提供 Promise）。 */
export type SquirrelSpawner = (command: string, args: readonly string[]) => Promise<void> | undefined;

export interface HandleSquirrelStartupDeps {
  argv: readonly string[];
  /** process.execPath：当前应用可执行文件路径。 */
  execPath: string;
  spawn: SquirrelSpawner;
  /** 处理完成后退出（main 传 app.exit）。 */
  quit: (code: number) => void;
  logger?: (message: string) => void;
  /** 安装/更新时登记「打开方式」。失败不得阻断快捷方式。 */
  onInstall?: () => void;
  /** 卸载时移除「打开方式」。失败不得阻断快捷方式移除。 */
  onUninstall?: () => void;
}

/**
 * Squirrel 布局：`%LOCALAPPDATA%\\<appName>\\app-<version>\\<exe>`，
 * `Update.exe` 位于 `app-<version>` 的上一级目录。
 */
export function resolveUpdateExePath(execPath: string): string {
  return path.resolve(path.dirname(execPath), '..', 'Update.exe');
}

/** 由可执行文件名得到快捷方式目标名（Squirrel 用 exe 基名匹配快捷方式）。 */
export function resolveShortcutTargetName(execPath: string): string {
  return path.basename(execPath);
}

/**
 * 处理 Squirrel 启动参数。
 * 返回 true 表示已由 Squirrel 事件接管（调用方**不得**创建窗口，应等待 quit）。
 * 返回 false 表示正常启动（含 `--squirrel-firstrun`，此时应用应正常显示自己）。
 */
export function handleSquirrelStartup(deps: HandleSquirrelStartupDeps): boolean {
  const startup = parseSquirrelStartup(deps.argv);
  if (startup === null || startup.kind === 'firstrun') {
    return false;
  }
  const logger = deps.logger ?? ((): void => undefined);
  const updateExe = resolveUpdateExePath(deps.execPath);
  const target = resolveShortcutTargetName(deps.execPath);

  const runHook = (hook: (() => void) | undefined, label: string): void => {
    if (hook === undefined) {
      return;
    }
    try {
      hook();
    } catch (error) {
      logger(
        `[squirrel] ${label}失败（已忽略）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const runThenQuit = (args: readonly string[], code: number): void => {
    // Update.exe 为分离进程：按官方 electron-squirrel-startup 做法**立即**退出，
    // 不等待其完成（否则会闪出空窗口、或卡住安装/卸载流程）。
    try {
      void deps.spawn(updateExe, args);
    } catch (error) {
      logger(
        `[squirrel] Update.exe 调用失败（已忽略）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    deps.quit(code);
  };

  switch (startup.kind) {
    case 'install':
    case 'updated':
      runHook(deps.onInstall, '登记打开方式');
      runThenQuit(['--createShortcut', target], 0);
      return true;
    case 'uninstall':
      runHook(deps.onUninstall, '移除打开方式');
      runThenQuit(['--removeShortcut', target], 0);
      return true;
    case 'obsolete':
      deps.quit(0);
      return true;
    default:
      return false;
  }
}