import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok } from '../../shared/api-types';
import type { FramePreview, ProjectMedia, Result } from '../../shared/api-types';
import { buildMediaUrl } from '../../shared/media-url';
import { runFfmpeg } from './ffmpeg';

/**
 * 精确画面帧服务（规格 5.4 / 5.5）。
 *
 * - 按需从源视频抽取指定时间的单帧，写入项目 cache/frames/；绝不触碰 source。
 * - 缓存键包含 sha256 + 时间点 + 尺寸 + 缓存版本（规格 5.5），相同请求不重复生成。
 * - 精确帧数量用 LRU（按文件 mtime）限制上限，防止拖动节点无限增长（规格 5.5）。
 * - 帧号只在帧率可信（CFR）时给出，VFR 返回 null，不伪造精确帧号（规格 5.4）。
 * - ffmpeg 运行器可注入，便于无 FFmpeg 环境用桩测试。
 */

export const FRAME_CACHE_VERSION = 'frames-v1';
export const FRAME_MAX_FILES = 200;
export const FRAME_DEFAULT_WIDTH = 176;
export const FRAME_DEFAULT_HEIGHT = 99;
const FRAME_MIN_DIM = 32;
const FRAME_MAX_DIM = 1280;

export function framesDir(folder: string): string {
  return path.join(folder, 'cache', 'frames');
}

/** 缓存文件名（规格 5.5）：对 {sha,时间,尺寸,版本} 求短哈希，稳定且避免非法字符。 */
export function frameCacheName(
  sha256: string,
  timeMs: number,
  width: number,
  height: number,
): string {
  const hash = createHash('sha256')
    .update(`${sha256}|${timeMs}|${width}x${height}|${FRAME_CACHE_VERSION}`)
    .digest('hex')
    .slice(0, 24);
  return `frame-${hash}.jpg`;
}

/** 帧号：仅 CFR 且帧率可信时返回整数，VFR 恒为 null（规格 5.4）。 */
export function frameNumberFor(media: ProjectMedia, timeMs: number): number | null {
  if (media.isVfr) {
    return null;
  }
  const { num, den } = media.avgFrameRate;
  if (!(num > 0) || !(den > 0)) {
    return null;
  }
  const fps = num / den;
  if (!Number.isFinite(fps) || fps <= 0) {
    return null;
  }
  return Math.round((timeMs / 1000) * fps);
}

export interface GetFramePreviewOptions {
  projectId: string;
  projectFolder: string;
  sourceAbsPath: string;
  media: ProjectMedia;
  /** 请求时间（会被 clamp 到 [0, durationMs]）。 */
  timeMs: number;
  width?: number;
  height?: number;
  /** 注入 ffmpeg 运行器（默认 runFfmpeg）；测试可替换。 */
  run?: (args: readonly string[]) => Promise<Result<unknown>>;
}

function clampDim(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(FRAME_MAX_DIM, Math.max(FRAME_MIN_DIM, Math.round(value)));
}

function scaleFilter(width: number, height: number): string {
  // 只按比例缩放到不超过目标尺寸（不 pad）；空白填充交由渲染层
  // object-fit: contain 的深色容器完成，避免 pad 在「缩放结果恰等于目标尺寸」时的边界错误。
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease`;
}

function frameArgs(
  source: string,
  timeMs: number,
  width: number,
  height: number,
  out: string,
): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    (timeMs / 1000).toFixed(3),
    '-i',
    source,
    '-frames:v',
    '1',
    '-vf',
    scaleFilter(width, height),
    '-q:v',
    '4',
    out,
  ];
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    const stats = await stat(absPath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

/** 上次清理时间（节流）：避免"每生成一帧就扫描整个目录"（本轮性能要求）。 */
let lastPruneAt = 0;
const PRUNE_MIN_INTERVAL_MS = 8_000;

/**
 * LRU 清理：按 mtime 升序删除最旧文件，保留上限 FRAME_MAX_FILES（规格 5.5）。
 * 节流：minIntervalMs 内的重复调用直接返回，不做目录扫描（批量清理策略）。
 */
export async function pruneFrames(
  dir: string,
  maxFiles = FRAME_MAX_FILES,
  minIntervalMs = PRUNE_MIN_INTERVAL_MS,
): Promise<void> {
  const now = Date.now();
  if (minIntervalMs > 0 && now - lastPruneAt < minIntervalMs) {
    return;
  }
  lastPruneAt = now;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const frames = names.filter((name) => name.startsWith('frame-') && name.endsWith('.jpg'));
  if (frames.length <= maxFiles) {
    return;
  }
  const stats = await Promise.all(
    frames.map(async (name) => {
      const abs = path.join(dir, name);
      const mtime = await stat(abs).then((s) => s.mtimeMs).catch(() => 0);
      return { abs, mtime };
    }),
  );
  stats.sort((a, b) => a.mtime - b.mtime);
  const overflow = stats.length - maxFiles;
  for (let i = 0; i < overflow; i++) {
    const entry = stats[i];
    if (entry !== undefined) {
      await rm(entry.abs, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * 取指定时间的精确画面帧。缓存命中直接返回；否则抽帧、写入、按 LRU 清理超量缓存。
 * 失败返回错误 Result（抽帧失败不影响视频播放与曲线编辑，规格 5.5）。
 */
export async function getFramePreview(
  options: GetFramePreviewOptions,
): Promise<Result<FramePreview>> {
  const run =
    options.run ??
    ((args: readonly string[]) => runFfmpeg(args).then((r) => (r.ok ? ok(r.data as unknown) : r)));

  const durationMs = Math.max(0, Math.floor(options.media.durationMs));
  const requestedTimeMs = Math.min(Math.max(0, Math.round(options.timeMs)), durationMs);
  const width = clampDim(options.width ?? FRAME_DEFAULT_WIDTH, FRAME_DEFAULT_WIDTH);
  const height = clampDim(options.height ?? FRAME_DEFAULT_HEIGHT, FRAME_DEFAULT_HEIGHT);

  const name = frameCacheName(options.media.sha256, requestedTimeMs, width, height);
  const dir = framesDir(options.projectFolder);
  const abs = path.join(dir, name);

  if (!(await fileExists(abs))) {
    await mkdir(dir, { recursive: true });
    const result = await run(
      frameArgs(options.sourceAbsPath, requestedTimeMs, width, height, abs),
    );
    if (!result.ok) {
      await rm(abs, { force: true }).catch(() => undefined);
      return result;
    }
    if (!(await fileExists(abs))) {
      return err('FRAME_FAILED', '未能生成画面帧（素材可能不可解码）。');
    }
    await pruneFrames(dir).catch(() => undefined);
  }

  return ok({
    requestedTimeMs,
    // 精确 seek 后取最接近的显示帧；本地近似为请求时间，VFR 下不承诺数学帧号。
    resolvedTimeMs: requestedTimeMs,
    frameNumber: frameNumberFor(options.media, requestedTimeMs),
    mediaUrl: buildMediaUrl(options.projectId, options.media.id, 'frame', options.media.sha256, name),
  });
}