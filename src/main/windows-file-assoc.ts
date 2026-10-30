/**
 * Windows 当前用户的「打开方式」登记（不改默认播放器）。
 *
 * Squirrel 安装在每用户目录，所以只写 HKCU。
 * 不设置 `.mp4` 等扩展名的默认 ProgID，也不写 UserChoice：
 * CutSpect 只出现在「打开方式」里。
 *
 * 稳定目标是 Squirrel 根目录的 stub（`laipian-tai.exe`），
 * 而不是会随版本变化的 `app-<version>\\laipian-tai.exe`。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { VIDEO_EXTENSIONS } from '../shared/video-extensions';

export const WINDOWS_VIDEO_PROGID = 'CutSpect.Video';
export const WINDOWS_APP_FRIENDLY_NAME = 'CutSpect';

const CLASSES = 'HKCU\\Software\\Classes';
const FILE_EXTS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts';

export interface WindowsFileAssocPlan {
  action: 'install' | 'uninstall';
  /** `reg.exe` 的参数列表（不含 `reg.exe` 本身）。 */
  operations: string[][];
}

function addDefault(key: string, data: string): string[] {
  return ['add', key, '/ve', '/d', data, '/f'];
}

function addValue(key: string, name: string, data: string): string[] {
  return ['add', key, '/v', name, '/t', 'REG_SZ', '/d', data, '/f'];
}

function deleteKey(key: string): string[] {
  return ['delete', key, '/f'];
}

function deleteValue(key: string, name: string): string[] {
  return ['delete', key, '/v', name, '/f'];
}

/**
 * Squirrel 布局：`...\laipian-tai\app-0.11.0\laipian-tai.exe`
 * 关联应指向同级 stub `...\laipian-tai\laipian-tai.exe`（存在时）。
 * ZIP 直出的可执行文件不在 `app-<version>` 目录里，就用它自己。
 */
export function resolveWindowsAssociationTarget(
  execPath: string,
  exists: (candidate: string) => boolean = existsSync,
): string {
  const normalized = path.win32.normalize(execPath);
  const versionDir = path.win32.basename(path.win32.dirname(normalized));
  if (!/^app-\d/.test(versionDir)) {
    return normalized;
  }
  const stub = path.win32.normalize(
    path.win32.join(path.win32.dirname(normalized), '..', path.win32.basename(normalized)),
  );
  return exists(stub) ? stub : normalized;
}

export function planWindowsFileAssociationOps(
  action: 'install' | 'uninstall',
  exePath: string,
  extensions: readonly string[] = VIDEO_EXTENSIONS,
): WindowsFileAssocPlan {
  if (exePath.includes('"')) {
    throw new Error('可执行文件路径含引号，无法写入打开方式命令。');
  }
  const exeName = path.win32.basename(exePath);
  const progIdKey = `${CLASSES}\\${WINDOWS_VIDEO_PROGID}`;
  const appKey = `${CLASSES}\\Applications\\${exeName}`;
  const command = `"${exePath}" "%1"`;
  const operations: string[][] = [];

  if (action === 'install') {
    operations.push(addDefault(progIdKey, 'CutSpect 视频'));
    operations.push(addDefault(`${progIdKey}\\DefaultIcon`, `${exePath},0`));
    operations.push(addDefault(`${progIdKey}\\shell\\open\\command`, command));
    operations.push(addValue(appKey, 'FriendlyAppName', WINDOWS_APP_FRIENDLY_NAME));
    operations.push(addDefault(`${appKey}\\shell\\open\\command`, command));
    for (const extension of extensions) {
      const dot = `.${extension}`;
      // 值名才是 Windows 识别的扩展名 / ProgID；数据保持非空，避免 reg.exe 吃掉后续参数。
      operations.push(addValue(`${appKey}\\SupportedTypes`, dot, dot));
      operations.push(addValue(`${CLASSES}\\${dot}\\OpenWithProgids`, WINDOWS_VIDEO_PROGID, WINDOWS_VIDEO_PROGID));
      operations.push(
        addValue(`${FILE_EXTS}\\${dot}\\OpenWithProgids`, WINDOWS_VIDEO_PROGID, WINDOWS_VIDEO_PROGID),
      );
    }
  } else {
    operations.push(deleteKey(progIdKey));
    operations.push(deleteKey(appKey));
    for (const extension of extensions) {
      const dot = `.${extension}`;
      operations.push(deleteValue(`${CLASSES}\\${dot}\\OpenWithProgids`, WINDOWS_VIDEO_PROGID));
      operations.push(deleteValue(`${FILE_EXTS}\\${dot}\\OpenWithProgids`, WINDOWS_VIDEO_PROGID));
    }
  }

  return { action, operations };
}

export function applyWindowsFileAssociationsSync(
  action: 'install' | 'uninstall',
  execPath: string,
  logger: (message: string) => void = () => undefined,
): void {
  if (process.platform !== 'win32') {
    return;
  }
  const target = resolveWindowsAssociationTarget(execPath);
  const plan = planWindowsFileAssociationOps(action, target);
  for (const args of plan.operations) {
    const result = spawnSync('reg.exe', args, { windowsHide: true, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      const detail = `${result.stderr ?? ''} ${result.stdout ?? ''}`.trim();
      logger(
        `[open-with] 注册表${action === 'install' ? '登记' : '移除'}未成功：${detail || result.error?.message || 'reg.exe 失败'}`,
      );
    }
  }
}
