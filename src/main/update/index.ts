/**
 * 自动更新装配（main 侧唯一入口）。
 *
 * - 集中读取运行时配置（resolveUpdateConfig）；
 * - 状态变更广播给所有窗口（renderer 只收到状态，不含任何仓库 Token）；
 * - 装配 electron autoUpdater；服务本身不接触 Token / 私有仓库地址。
 */
import { BrowserWindow, app } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { isSquirrelFirstRun, resolveUpdateConfig, UPDATE_ENV_KEYS } from '../../shared/update';
import type { UpdateState } from '../../shared/update';
import { createElectronAutoUpdater } from './electron';
import { createUpdateService } from './service';
import type { UpdateService } from './service';

export interface SetupAutoUpdateDeps {
  log: (message: string) => void;
}

/**
 * 读取更新配置来源。
 * 优先级：运行时环境变量（本地调试/测试）> 打包注入文件（resources/update-config.json）> 无。
 * 未配置任何公开仓库时禁用更新（安全默认），应用照常运行。
 */
function readRuntimeUpdateEnv(): Record<string, string> {
  const fromFile: Record<string, string> = {};
  try {
    const configPath = path.join(process.resourcesPath, 'update-config.json');
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      repo?: unknown;
      feed?: unknown;
    };
    if (typeof parsed.repo === 'string' && parsed.repo.trim().length > 0) {
      fromFile[UPDATE_ENV_KEYS.repo] = parsed.repo.trim();
    }
    if (typeof parsed.feed === 'string' && parsed.feed.trim().length > 0) {
      fromFile[UPDATE_ENV_KEYS.feed] = parsed.feed.trim();
    }
  } catch {
    // 文件缺失/损坏：忽略（开发构建或未注入配置）。
  }

  const fromEnv: Record<string, string> = {};
  for (const key of [UPDATE_ENV_KEYS.repo, UPDATE_ENV_KEYS.feed, UPDATE_ENV_KEYS.disable]) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      fromEnv[key] = value;
    }
  }

  return { ...fromFile, ...fromEnv };
}

/** 创建并启动更新服务（bootstrap 内调用一次）。 */
export function setupAutoUpdate(deps: SetupAutoUpdateDeps): UpdateService {
  const currentVersion = app.getVersion();
  const config = resolveUpdateConfig({
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    currentVersion,
    env: readRuntimeUpdateEnv(),
  });
  deps.log(
    `[update] enabled=${config.enabled} support=${config.support} reason=${config.reason ?? '-'} feed=${config.feedUrl ?? '-'}`,
  );

  const service = createUpdateService({
    config,
    currentVersion,
    autoUpdater: createElectronAutoUpdater(),
    schedule: (fn, delayMs) => setTimeout(fn, delayMs),
    isFirstRun: isSquirrelFirstRun(process.argv),
    logger: deps.log,
    onState: (state: UpdateState) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.updateEvent, state);
        }
      }
    },
  });
  service.start();
  return service;
}