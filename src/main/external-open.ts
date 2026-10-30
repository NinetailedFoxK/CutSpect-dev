/**
 * 把系统「打开方式」/ 命令行传入的本地视频，收成渲染层能消费的打开请求。
 *
 * 渲染层只收到一次性选择令牌和展示用元信息，收不到绝对路径（规格 12.4）。
 * 真正进入时间线仍走新建项目：用户确认保存位置后，视频被复制进项目。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExternalVideoOpen, VideoPickResult } from '../shared/api-types';
import { isSupportedVideoFileName } from '../shared/video-extensions';

export type { ExternalVideoOpen };

export interface ExternalVideoOpenDeps {
  cwd: string;
  now: () => number;
  /** 同一路径在该毫秒内重复到达（argv 与 open-file 双发）只处理一次。 */
  dedupeMs?: number;
  existsFile: (filePath: string) => Promise<boolean>;
  describeVideo: (filePath: string) => Promise<VideoPickResult>;
  deliver: (payload: ExternalVideoOpen) => void;
}

export interface ExternalVideoOpenCoordinator {
  /** ready 之前入队，start 之后立刻处理。 */
  enqueuePath(filePath: string): void;
  enqueueArgv(argv: readonly string[], cwd?: string): void;
  start(): void;
}

const DEFAULT_DEDUPE_MS = 1500;

function pathKey(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function displayName(filePath: string): string {
  const base = path.basename(filePath);
  return base.length > 0 ? base : '该视频';
}

/** 把用户传入的参数还原成绝对路径。无法解析时返回 null。 */
export function resolveUserPath(arg: string, cwd: string): string | null {
  let value = arg.trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1).trim();
  }
  if (value.length === 0 || value === '.' || value === './') {
    return null;
  }
  if (value.startsWith('file:')) {
    try {
      value = fileURLToPath(value);
    } catch {
      return null;
    }
  }
  if (value.length === 0) {
    return null;
  }
  return path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

/**
 * 从进程 argv 提取本地视频路径。
 * 跳过 argv[0]（可执行文件）和所有 `-` 开头的开关（含 Squirrel / Electron）。
 */
export function extractVideoPathsFromArgv(argv: readonly string[], cwd: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || arg.length === 0 || arg.startsWith('-')) {
      continue;
    }
    const resolved = resolveUserPath(arg, cwd);
    if (resolved === null || !isSupportedVideoFileName(resolved)) {
      continue;
    }
    const key = pathKey(resolved);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    found.push(resolved);
  }
  return found;
}

export function createExternalVideoOpenCoordinator(
  deps: ExternalVideoOpenDeps,
): ExternalVideoOpenCoordinator {
  const dedupeMs = deps.dedupeMs ?? DEFAULT_DEDUPE_MS;
  const queue: string[] = [];
  const recent = new Map<string, number>();
  let started = false;
  let pumping = false;

  const enqueuePath = (filePath: string): void => {
    const absolute = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(deps.cwd, filePath);
    if (!isSupportedVideoFileName(absolute)) {
      return;
    }
    const key = pathKey(absolute);
    const seenAt = recent.get(key);
    const now = deps.now();
    if (seenAt !== undefined && now - seenAt < dedupeMs) {
      return;
    }
    recent.set(key, now);
    queue.push(absolute);
    if (started) {
      void pump();
    }
  };

  const handle = async (filePath: string): Promise<void> => {
    const fileName = displayName(filePath);
    let exists = false;
    try {
      exists = await deps.existsFile(filePath);
    } catch {
      exists = false;
    }
    if (!exists) {
      deps.deliver({
        status: 'rejected',
        fileName,
        message: `找不到「${fileName}」，或它不是视频文件。`,
      });
      return;
    }
    try {
      const video = await deps.describeVideo(filePath);
      deps.deliver({ status: 'ready', video });
    } catch {
      deps.deliver({
        status: 'rejected',
        fileName,
        message: `无法读取「${fileName}」，请重新选择该视频。`,
      });
    }
  };

  const pump = async (): Promise<void> => {
    if (pumping) {
      return;
    }
    pumping = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) {
          break;
        }
        await handle(next);
      }
    } finally {
      pumping = false;
      if (started && queue.length > 0) {
        void pump();
      }
    }
  };

  return {
    enqueuePath,
    enqueueArgv(argv, cwd = deps.cwd) {
      for (const filePath of extractVideoPathsFromArgv(argv, cwd)) {
        enqueuePath(filePath);
      }
    },
    start() {
      started = true;
      void pump();
    },
  };
}
