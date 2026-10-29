import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildUpdateFeedUrl,
  compareVersions,
  isNewerVersion,
  isSquirrelFirstRun,
  parseSquirrelStartup,
  resolveUpdateConfig,
  UPDATE_ENV_KEYS,
} from '../src/shared/update';
import type { ResolvedUpdateConfig, UpdateState } from '../src/shared/update';
import { createUpdateService } from '../src/main/update/service';
import type { UpdateAutoUpdater } from '../src/main/update/service';
import {
  handleSquirrelStartup,
  resolveShortcutTargetName,
  resolveUpdateExePath,
} from '../src/main/update/squirrel';

/** 假 autoUpdater：记录调用并可手动触发事件（不依赖 electron 运行时）。 */
class FakeAutoUpdater implements UpdateAutoUpdater {
  autoDownload = false;
  readonly feedUrls: string[] = [];
  checkCalls = 0;
  quitAndInstallCalls = 0;
  throwOnCheck = false;
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  setFeedURL(options: { url: string }): void {
    this.feedUrls.push(options.url);
  }

  checkForUpdates(): void {
    this.checkCalls += 1;
    if (this.throwOnCheck) {
      throw new Error('network down');
    }
  }

  quitAndInstall(): void {
    this.quitAndInstallCalls += 1;
  }
}

function makeConfig(
  platform = 'win32',
  env: Record<string, string | undefined> = { [UPDATE_ENV_KEYS.repo]: 'ZevinZhao/CutSpect-downloads' },
): ResolvedUpdateConfig {
  return resolveUpdateConfig({
    isPackaged: true,
    platform,
    arch: 'x64',
    currentVersion: '0.10.0',
    signedForAutoUpdate: true,
    env,
  });
}

function createHarness(config: ResolvedUpdateConfig, isFirstRun = false) {
  const updater = new FakeAutoUpdater();
  const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
  const states: UpdateState[] = [];
  const service = createUpdateService({
    config,
    currentVersion: config.currentVersion,
    autoUpdater: updater,
    schedule: (fn, delayMs) => {
      scheduled.push({ fn, delayMs });
      return 0;
    },
    isFirstRun,
    onState: (state) => {
      states.push(state);
    },
  });
  return { updater, scheduled, states, service };
}

describe('更新地址配置（集中构造）', () => {
  it('默认使用 Electron 官方托管地址（platform 后直接跟版本，不含 arch）', () => {
    expect(buildUpdateFeedUrl('ZevinZhao/CutSpect-downloads', 'win32', '0.10.0')).toBe(
      'https://update.electronjs.org/ZevinZhao/CutSpect-downloads/win32/0.10.0',
    );
    expect(buildUpdateFeedUrl('ZevinZhao/CutSpect-downloads', 'darwin', '0.10.0')).toBe(
      'https://update.electronjs.org/ZevinZhao/CutSpect-downloads/darwin/0.10.0',
    );
  });

  it('自定义 feed 覆盖官方地址并去除末尾斜杠', () => {
    expect(buildUpdateFeedUrl('x/y', 'win32', '1.0.0', 'https://feed.example.com/')).toBe(
      'https://feed.example.com',
    );
  });

  it('打包环境读到仓库名时启用更新', () => {
    const config = makeConfig();
    expect(config.enabled).toBe(true);
    expect(config.reason).toBeNull();
    expect(config.repo).toBe('ZevinZhao/CutSpect-downloads');
    expect(config.feedUrl).toContain('update.electronjs.org');
  });

  it('未配置仓库名时不启用（not-configured）', () => {
    const config = resolveUpdateConfig({
      isPackaged: true,
      platform: 'win32',
      arch: 'x64',
      currentVersion: '0.10.0',
      signedForAutoUpdate: true,
      env: {},
    });
    expect(config.enabled).toBe(false);
    expect(config.reason).toBe('not-configured');
  });

  it('显式关闭优先级最高', () => {
    const config = resolveUpdateConfig({
      isPackaged: true,
      platform: 'win32',
      arch: 'x64',
      currentVersion: '0.10.0',
      signedForAutoUpdate: true,
      env: { [UPDATE_ENV_KEYS.repo]: 'a/b', [UPDATE_ENV_KEYS.disable]: '1' },
    });
    expect(config.enabled).toBe(false);
    expect(config.reason).toBe('disabled-by-env');
  });

  it('未签名 / ad-hoc 构建即使配置了仓库也不静默更新', () => {
    const config = resolveUpdateConfig({
      isPackaged: true,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.11.0',
      signedForAutoUpdate: false,
      env: { [UPDATE_ENV_KEYS.repo]: 'a/b' },
    });
    expect(config.enabled).toBe(false);
    expect(config.reason).toBe('unsigned');
    expect(config.feedUrl).toBeNull();
  });
});

describe('开发环境不检查更新', () => {
  it('未打包（isPackaged=false）时禁用，reason=dev', () => {
    const config = resolveUpdateConfig({
      isPackaged: false,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.10.0',
      signedForAutoUpdate: true,
      env: { [UPDATE_ENV_KEYS.repo]: 'a/b' },
    });
    expect(config.enabled).toBe(false);
    expect(config.reason).toBe('dev');
  });

  it('开发环境 start() 不设置更新源、不发起检查', () => {
    const config = resolveUpdateConfig({
      isPackaged: false,
      platform: 'win32',
      arch: 'x64',
      currentVersion: '0.10.0',
      signedForAutoUpdate: true,
      env: { [UPDATE_ENV_KEYS.repo]: 'a/b' },
    });
    const harness = createHarness(config);
    harness.service.start();
    expect(harness.updater.feedUrls).toHaveLength(0);
    expect(harness.updater.checkCalls).toBe(0);
    expect(harness.service.getState().status).toBe('disabled');
  });
});

describe('更新失败不阻塞应用', () => {
  it('checkForUpdates 抛错时不冒泡，仅进入 error 状态', () => {
    const harness = createHarness(makeConfig());
    harness.updater.throwOnCheck = true;
    harness.service.start();
    const first = harness.scheduled[0];
    expect(first).toBeDefined();
    expect(() => first?.fn()).not.toThrow();
    expect(harness.service.getState().status).toBe('error');
  });

  it('收到 error 事件只更新状态，不抛出', () => {
    const harness = createHarness(makeConfig());
    harness.service.start();
    expect(() => harness.updater.emit('error', new Error('boom'))).not.toThrow();
    const state = harness.service.getState();
    expect(state.status).toBe('error');
    expect(state.message).toContain('boom');
    expect(state.canInstall).toBe(false);
  });

  it('启用时 start() 设置 feed 并按延迟调度检查', () => {
    const harness = createHarness(makeConfig());
    harness.service.start();
    expect(harness.updater.feedUrls[0]).toContain('update.electronjs.org');
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.scheduled[0]?.delayMs).toBeGreaterThan(0);
  });

  it('首次安装启动延长检查延迟', () => {
    const harness = createHarness(makeConfig(), true);
    harness.service.start();
    expect(harness.scheduled[0]?.delayMs).toBe(60_000);
  });
});

describe('版本比较', () => {
  it('按语义化版本比较', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('v0.10.1', '0.10.0')).toBe(1);
  });

  it('isNewerVersion 判定', () => {
    expect(isNewerVersion('0.11.0', '0.10.0')).toBe(true);
    expect(isNewerVersion('0.10.0', '0.10.0')).toBe(false);
    expect(isNewerVersion('0.9.9', '0.10.0')).toBe(false);
  });
});

describe('Squirrel 启动参数处理', () => {
  it('解析各启动参数', () => {
    expect(parseSquirrelStartup(['--foo', '--squirrel-install=1.0.0'])).toEqual({
      kind: 'install',
      version: '1.0.0',
    });
    expect(parseSquirrelStartup(['--squirrel-uninstall'])).toEqual({ kind: 'uninstall', version: null });
    expect(parseSquirrelStartup(['--squirrel-firstrun'])).toEqual({ kind: 'firstrun', version: null });
    expect(parseSquirrelStartup(['--no-such-flag'])).toBeNull();
    expect(isSquirrelFirstRun(['--squirrel-firstrun'])).toBe(true);
    expect(isSquirrelFirstRun(['--squirrel-install'])).toBe(false);
  });

  it('安装事件创建快捷方式并退出', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    let quitCode: number | null = null;
    const exePath = path.join('root', 'laipian-tai', 'app-1.0.0', 'laipian-tai.exe');
    const handled = handleSquirrelStartup({
      argv: ['--squirrel-install=1.0.0'],
      execPath: exePath,
      spawn: (cmd, args) => {
        calls.push({ cmd, args });
        return Promise.resolve();
      },
      quit: (code) => {
        quitCode = code;
      },
    });
    expect(handled).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['--createShortcut', resolveShortcutTargetName(exePath)]);
    expect(calls[0]?.cmd).toBe(resolveUpdateExePath(exePath));
    expect(quitCode).toBe(0);
  });

  it('卸载事件移除快捷方式', () => {
    const calls: Array<readonly string[]> = [];
    const exePath = path.join('root', 'laipian-tai', 'app-1.0.0', 'laipian-tai.exe');
    const handled = handleSquirrelStartup({
      argv: ['--squirrel-uninstall'],
      execPath: exePath,
      spawn: (_cmd, args) => {
        calls.push(args);
        return Promise.resolve();
      },
      quit: () => undefined,
    });
    expect(handled).toBe(true);
    expect(calls[0]?.[0]).toBe('--removeShortcut');
  });

  it('Update.exe 位于 app-<version> 的上一级', () => {
    const exePath = path.resolve('root', 'laipian-tai', 'app-1.0.0', 'laipian-tai.exe');
    expect(resolveUpdateExePath(exePath)).toBe(path.resolve('root', 'laipian-tai', 'Update.exe'));
  });

  it('首次运行不接管启动（应用正常显示）', () => {
    let quitCalled = false;
    const handled = handleSquirrelStartup({
      argv: ['--squirrel-firstrun'],
      execPath: path.join('root', 'app.exe'),
      spawn: () => Promise.resolve(),
      quit: () => {
        quitCalled = true;
      },
    });
    expect(handled).toBe(false);
    expect(quitCalled).toBe(false);
  });
});

describe('下载完成后重启安装', () => {
  it('非 ready 状态 install() 不触发；下载完成 later 可触发', () => {
    const harness = createHarness(makeConfig());
    harness.service.start();
    harness.service.install();
    expect(harness.updater.quitAndInstallCalls).toBe(0);

    harness.updater.emit('update-downloaded', {}, '0.11.0', '0.11.0', new Date(), 'https://url');
    expect(harness.service.getState().status).toBe('ready');
    expect(harness.service.getState().canInstall).toBe(true);

    harness.service.install();
    expect(harness.updater.quitAndInstallCalls).toBe(1);
  });
});

describe('不向渲染层暴露 Token', () => {
  it('更新配置字段集合固定，且不含 token/secret', () => {
    const config = makeConfig();
    expect(Object.keys(config).sort()).toEqual(
      [
        'arch',
        'checkDelayMs',
        'currentVersion',
        'enabled',
        'feedUrl',
        'firstRunDelayMs',
        'platform',
        'reason',
        'repo',
        'support',
      ].sort(),
    );
    const serialized = JSON.stringify(config).toLowerCase();
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('password');
  });
});

describe('平台支持判定（构建产物预期）', () => {
  it('Windows 使用 Squirrel feed', () => {
    const config = makeConfig('win32');
    expect(config.support).toBe('windows-squirrel');
    expect(config.feedUrl).toContain('/win32/');
  });

  it('macOS 使用 Squirrel.Mac feed（需签名与公证才能真正更新）', () => {
    const config = makeConfig('darwin');
    expect(config.support).toBe('macos-squirrel');
    expect(config.feedUrl).toContain('/darwin/');
  });

  it('不支持的平台禁用更新', () => {
    const config = makeConfig('linux');
    expect(config.enabled).toBe(false);
    expect(config.reason).toBe('unsupported-platform');
    expect(config.support).toBe('unsupported');
  });
});