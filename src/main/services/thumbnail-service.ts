import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { err, ok } from '../../shared/api-types';
import type { Result } from '../../shared/api-types';
import { runFfmpeg } from './ffmpeg';
import { writeFileAtomic } from './atomic-write';

/**
 * 缩略图与封面生成（规格 10.3）。
 *
 * - 约 320×180，保持比例、空白补底；全片最多 120 张，间隔 max(1000ms, durationMs/120)；
 *   短视频至少生成首帧；
 * - 缓存键包含源文件 SHA-256 + 生成参数 + 缓存版本（规格 10.3）；不匹配则重建；
 * - 单帧失败非致命（保留可用播放器，显示占位图）；取消返回 CANCELLED；
 * - ffmpeg 运行器可注入，便于在无 FFmpeg 环境用桩测试；真实抽帧用真实 ffmpeg 验证。
 *
 * 缩略图只写 cache/thumbs 与 cache/cover.jpg，绝不触碰 source/playback（规格 10.4）。
 */

export const THUMB_WIDTH = 320;
export const THUMB_HEIGHT = 180;
export const COVER_WIDTH = 320;
export const COVER_HEIGHT = 180;
export const MAX_THUMBS = 120;
/** 缓存版本：生成参数变化时递增即可使旧缓存失效（规格 10.3）。 */
const CACHE_VERSION = 'thumbs-v2';

export interface ThumbnailResult {
  generated: number;
  total: number;
  coverPath: string | null;
  cached: boolean;
}

export interface GenerateThumbnailsOptions {
  sourceAbsPath: string;
  projectFolder: string;
  durationMs: number;
  sha256: string;
  cancelSignal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  /** 注入 ffmpeg 运行器（默认 runFfmpeg）；测试可替换。 */
  run?: (args: readonly string[]) => Promise<Result<unknown>>;
  /** 忽略缓存强制重建。 */
  force?: boolean;
}

export interface GenerateCoverOptions {
  sourceAbsPath: string;
  projectFolder: string;
  /** 注入 ffmpeg 运行器（默认 runFfmpeg）；测试可替换。 */
  run?: (args: readonly string[]) => Promise<Result<unknown>>;
  /** 忽略已存在的封面强制重建。 */
  force?: boolean;
}

interface ThumbsMeta {
  sha256: string;
  version: string;
  count: number;
  generatedAt: string;
}

export function thumbsDir(folder: string): string {
  return path.join(folder, 'cache', 'thumbs');
}

export function coverPath(folder: string): string {
  return path.join(folder, 'cache', 'cover.jpg');
}

function metaPath(folder: string): string {
  return path.join(thumbsDir(folder), '.meta.json');
}

/** 采样时间点：首帧 + 等间隔，间隔 max(1000ms, durationMs/120)，最多 120 张。 */
export function sampleTimes(durationMs: number): number[] {
  const duration = Math.max(1, Math.floor(durationMs));
  const interval = Math.max(1000, duration / MAX_THUMBS);
  const times: number[] = [0];
  for (let t = interval; t < duration && times.length < MAX_THUMBS; t += interval) {
    times.push(Math.round(t));
  }
  return times.slice(0, MAX_THUMBS);
}

function scalePadFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x0d0e12`;
}

function frameArgs(source: string, timeSec: number, width: number, height: number, out: string): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    timeSec.toFixed(3),
    '-i',
    source,
    '-frames:v',
    '1',
    '-vf',
    scalePadFilter(width, height),
    '-q:v',
    '4',
    out,
  ];
}

async function readMeta(folder: string): Promise<ThumbsMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(metaPath(folder), 'utf8')) as ThumbsMeta;
    if (typeof parsed.sha256 === 'string' && typeof parsed.version === 'string' && typeof parsed.count === 'number') {
      return parsed;
    }
  } catch {
    // 无 meta / 损坏：视为无缓存。
  }
  return null;
}

/**
 * 生成缩略图与封面。缓存命中（SHA + 版本一致且封面存在）直接返回 cached:true。
 */
export async function generateThumbnails(
  options: GenerateThumbnailsOptions,
): Promise<Result<ThumbnailResult>> {
  const run =
    options.run ??
    ((args: readonly string[]) => runFfmpeg(args).then((r) => (r.ok ? ok(r.data) : r)));
  const cover = coverPath(options.projectFolder);
  const dir = thumbsDir(options.projectFolder);

  const meta = await readMeta(options.projectFolder);
  if (
    options.force !== true &&
    meta !== null &&
    meta.sha256 === options.sha256 &&
    meta.version === CACHE_VERSION
  ) {
    // 封面存在即视为有效缓存。
    try {
      const coverBytes = await readFile(cover);
      if (coverBytes.length > 0) {
        return ok({ generated: 0, total: meta.count, coverPath: cover, cached: true });
      }
    } catch {
      // 封面缺失：继续重建。
    }
  }

  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(dir, { recursive: true });

  const times = sampleTimes(options.durationMs);
  const total = times.length;

  // 封面（首帧，较大尺寸）。
  const coverResult = await run(frameArgs(options.sourceAbsPath, 0, COVER_WIDTH, COVER_HEIGHT, cover));
  const coverOk = coverResult.ok;

  let generated = 0;
  for (let i = 0; i < times.length; i++) {
    if (options.cancelSignal?.aborted) {
      return err('CANCELLED', '缩略图生成已取消。');
    }
    const out = path.join(dir, `thumb-${String(i).padStart(3, '0')}.jpg`);
    const result = await run(frameArgs(options.sourceAbsPath, (times[i] ?? 0) / 1000, THUMB_WIDTH, THUMB_HEIGHT, out));
    if (result.ok) {
      generated += 1;
    }
    // 单帧失败非致命：继续其余帧（规格 15：缩略图失败保留播放器 + 占位图）。
    options.onProgress?.(i + 1, total);
  }

  if (generated === 0 && !coverOk) {
    return err('THUMBNAIL_FAILED', '无法生成缩略图（素材可能不可解码）。', true);
  }

  const nextMeta: ThumbsMeta = {
    sha256: options.sha256,
    version: CACHE_VERSION,
    count: generated,
    generatedAt: new Date().toISOString(),
  };
  await writeFileAtomic(metaPath(options.projectFolder), `${JSON.stringify(nextMeta, null, 2)}\n`);

  return ok({ generated, total, coverPath: coverOk ? cover : null, cached: false });
}

/**
 * 仅生成封面（首帧，320×180）。导入流程的"生成封面"阶段使用：
 * 比全量缩略图快得多，且失败可由调用方选择性忽略（规格 15：缩略图失败
 * 仍允许进入编辑器）。已存在且非空的封面直接命中缓存。
 */
export async function generateCover(
  options: GenerateCoverOptions,
): Promise<Result<{ coverPath: string; cached: boolean }>> {
  const run =
    options.run ??
    ((args: readonly string[]) => runFfmpeg(args).then((r) => (r.ok ? ok(r.data) : r)));
  const cover = coverPath(options.projectFolder);
  if (options.force !== true) {
    try {
      const existing = await readFile(cover);
      if (existing.length > 0) {
        return ok({ coverPath: cover, cached: true });
      }
    } catch {
      // 无封面：继续生成。
    }
  }
  await mkdir(path.join(options.projectFolder, 'cache'), { recursive: true });
  const result = await run(frameArgs(options.sourceAbsPath, 0, COVER_WIDTH, COVER_HEIGHT, cover));
  if (!result.ok) {
    return err('THUMBNAIL_FAILED', '无法生成封面画面（素材可能不可解码）。', true);
  }
  return ok({ coverPath: cover, cached: false });
}

/** 列出已生成的缩略图文件名（供渲染层按采样时间复用；无则空数组）。 */
export async function listThumbnails(folder: string): Promise<string[]> {
  try {
    const names = await readdir(thumbsDir(folder));
    return names.filter((name) => name.startsWith('thumb-') && name.endsWith('.jpg')).sort();
  } catch {
    return [];
  }
}
/** 时间线缩略图条目：受控文件名 + 其对应的采样时间点（规格 4.4）。 */
export interface ThumbnailEntry {
  name: string;
  timeMs: number;
}

/**
 * 列出已生成缩略图及其时间点。文件名 `thumb-NNN.jpg` 的序号映射到 sampleTimes 的第 N 项；
 * 序号越界（缓存参数变化导致）的条目直接跳过，不伪造时间。按时间升序返回。
 */
export async function listThumbnailEntries(
  folder: string,
  durationMs: number,
): Promise<ThumbnailEntry[]> {
  const names = await listThumbnails(folder);
  const times = sampleTimes(durationMs);
  const entries: ThumbnailEntry[] = [];
  for (const name of names) {
    const match = /^thumb-(\d{1,4})\.jpg$/.exec(name);
    if (!match || match[1] === undefined) {
      continue;
    }
    const timeMs = times[Number(match[1])];
    if (timeMs === undefined) {
      continue;
    }
    entries.push({ name, timeMs });
  }
  entries.sort((a, b) => a.timeMs - b.timeMs);
  return entries;
}