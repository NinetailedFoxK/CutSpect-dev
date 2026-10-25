import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok } from '../../shared/api-types';
import type { ProjectMedia, Result } from '../../shared/api-types';
import { runFfmpeg } from './ffmpeg';

/**
 * 导出代表帧抽取（批次 A-3）。
 *
 * 与时间线用的 frame-service 分开，原因是导出需要：
 * - 更高分辨率（可到源视频宽度，不受时间线 1280 上限约束）；
 * - 更高画质（JPEG q 可调）；
 * - 批量顺序抽取 + 进度 + 取消；
 * - **单帧失败不致命**：个别画面提取失败只记录，继续导出其余镜头（规格 3 画面要求）。
 *
 * 代表画面的时间点由 shared/export-document 计算（避开硬切瞬间），本模块只按
 * 给定时间点抽帧，不做时间语义判断，保证与曲线/标注/结构一致。
 */

export const EXPORT_FRAMES_DIR = 'export-frames';

export interface ExportFrameRequest {
  /** 唯一键：shot:<id> / curveNode:<ms> / annotation:<id>。 */
  key: string;
  timeMs: number;
}

export interface ExtractFramesOptions {
  projectFolder: string;
  sourceAbsPath: string;
  media: ProjectMedia;
  requests: readonly ExportFrameRequest[];
  /** 输出宽度（像素，已由 resolveFrameWidth 保证 ≤ 源宽度）。 */
  width: number;
  /** JPEG 质量（1—31，数值越小越清晰；默认 3）。 */
  quality?: number;
  cancelSignal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  /** 注入 ffmpeg 运行器（测试可替换）。 */
  run?: (args: readonly string[]) => Promise<Result<unknown>>;
}

export interface ExtractFramesResult {
  /** key → 抽帧成功后的绝对路径（失败或取消的不包含）。 */
  frames: Map<string, string>;
  /** 抽帧失败的 key（不影响其他帧）。 */
  failures: string[];
}

function framesDir(projectFolder: string): string {
  return path.join(projectFolder, 'cache', EXPORT_FRAMES_DIR);
}

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64);
}

function frameName(key: string, width: number, quality: number): string {
  return `${safeKey(key)}-w${width}-q${quality}.jpg`;
}

function frameArgs(
  source: string,
  timeMs: number,
  width: number,
  height: number,
  quality: number,
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
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    '-q:v',
    String(quality),
    out,
  ];
}

async function fileOk(absPath: string): Promise<boolean> {
  try {
    const stats = await stat(absPath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

/** LRU 清理导出帧目录（默认保留 2000 张；导出后一般无需长期保留）。 */
export async function pruneExportFrames(dir: string, maxFiles = 2000): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const files = names.filter((name) => name.endsWith('.jpg'));
  if (files.length <= maxFiles) return;
  const stats = await Promise.all(
    files.map(async (name) => {
      const abs = path.join(dir, name);
      const mtime = await stat(abs).then((s) => s.mtimeMs).catch(() => 0);
      return { abs, mtime };
    }),
  );
  stats.sort((a, b) => a.mtime - b.mtime);
  for (let i = 0; i < stats.length - maxFiles; i++) {
    const entry = stats[i];
    if (entry !== undefined) await rm(entry.abs, { force: true }).catch(() => undefined);
  }
}

/**
 * 顺序抽取代表帧。取消时返回 CANCELLED（已抽的帧保留，无害）。
 * 单帧失败仅计入 failures，不影响其余帧（规格：个别画面失败不能导致整体失败）。
 */
export async function extractFrames(
  options: ExtractFramesOptions,
): Promise<Result<ExtractFramesResult>> {
  const run =
    options.run ??
    ((args: readonly string[]) => runFfmpeg(args).then((r) => (r.ok ? ok(r.data as unknown) : r)));

  const width = Math.max(160, Math.round(options.width));
  const quality = Math.max(1, Math.min(31, Math.round(options.quality ?? 3)));
  const media = options.media;
  const aspect = media.width > 0 && media.height > 0 ? media.height / media.width : 9 / 16;
  const height = Math.max(90, Math.round(width * aspect));

  const dir = framesDir(options.projectFolder);
  await mkdir(dir, { recursive: true });

  const frames = new Map<string, string>();
  const failures: string[] = [];
  const total = options.requests.length;

  for (let i = 0; i < options.requests.length; i++) {
    if (options.cancelSignal?.aborted) {
      return err('CANCELLED', '导出已取消。');
    }
    const request = options.requests[i];
    if (request === undefined) continue;
    const abs = path.join(dir, frameName(request.key, width, quality));
    if (await fileOk(abs)) {
      frames.set(request.key, abs);
      options.onProgress?.(i + 1, total);
      continue;
    }
    const timeMs = Math.max(0, Math.round(request.timeMs));
    const result = await run(
      frameArgs(options.sourceAbsPath, timeMs, width, height, quality, abs),
    );
    if (result.ok && (await fileOk(abs))) {
      frames.set(request.key, abs);
    } else {
      await rm(abs, { force: true }).catch(() => undefined);
      failures.push(request.key);
    }
    options.onProgress?.(i + 1, total);
  }

  void pruneExportFrames(dir).catch(() => undefined);
  return ok({ frames, failures });
}