import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok } from '../../shared/api-types';
import type { DetectedCut, ProjectMedia, Result } from '../../shared/api-types';
import { runFfmpeg } from './ffmpeg';
import { writeFileAtomic } from './atomic-write';

/**
 * 智能镜头识别服务（硬切检测，复用内置 FFmpeg 的 scdet 滤镜）。
 *
 * - 只做硬切检测：`scale=480:-2,scdet=t=<阈值>`，不引入 Python/OpenCV/PySceneDetect/模型。
 * - 解析 ffmpeg stderr 中的 `lavfi.scd.score` / `lavfi.scd.time`，转整数毫秒并做过滤：
 *   去掉视频起点/终点、去掉超时长的点、按时间排序、同时间去重、最短镜头去重（保留高分）。
 * - 结果缓存到 `cache/shots/`，缓存键含视频 SHA-256 + 阈值 + 最短镜头长度；相同参数直接命中。
 * - 只写 cache，**绝不修改 project.json**；候选结果在用户确认前不进入正式分段数据。
 * - 主进程执行，renderer 不接触真实路径。
 */

export function shotsDir(folder: string): string {
  return path.join(folder, 'cache', 'shots');
}

/** 缓存文件名（含 SHA-256 前缀 + 阈值 + 最短镜头长度）。 */
export function shotCacheName(sha256: string, threshold: number, minShotMs: number): string {
  return `shots-${sha256.slice(0, 12)}-t${threshold}-m${minShotMs}.json`;
}

export interface RawCut {
  timeMs: number;
  score: number;
}

/**
 * 解析一行 scdet 日志 → 原始切点；非 scdet 行或不完整返回 null。
 * 兼容形如 `lavfi.scd.score: 12.3, lavfi.scd.time: 4.56` 的日志（顺序无关）。
 */
export function parseScdetLine(line: string): { timeMs: number; score: number } | null {
  if (!line.includes('lavfi.scd.')) {
    return null;
  }
  const timeMatch = /lavfi\.scd\.time:?\s*(-?[0-9.]+)/.exec(line);
  const scoreMatch = /lavfi\.scd\.score:?\s*(-?[0-9.]+)/.exec(line);
  if (timeMatch === null || scoreMatch === null || timeMatch[1] === undefined || scoreMatch[1] === undefined) {
    return null;
  }
  const timeSec = Number(timeMatch[1]);
  const score = Number(scoreMatch[1]);
  if (!Number.isFinite(timeSec) || !Number.isFinite(score)) {
    return null;
  }
  return { timeMs: timeSec * 1000, score };
}

/**
 * 过滤与去重原始切点：
 * 1. 去掉非有限值；
 * 2. 去掉视频起点与终点、以及超出时长的点（严格 0 < t < duration）；
 * 3. 同时间点去重，保留分数更高者；
 * 4. 最短镜头过滤：任意两点距离 < minShotMs 时只保留分数更高者（按分数贪心选择）；
 * 5. 输出按时间升序、整数毫秒。
 */
export function filterDetectedCuts(
  cuts: readonly RawCut[],
  durationMs: number,
  minShotMs: number,
): DetectedCut[] {
  const duration = Math.max(0, Math.floor(durationMs));
  const minGap = Math.max(0, minShotMs);

  const inRange: DetectedCut[] = [];
  for (const cut of cuts) {
    if (!Number.isFinite(cut.timeMs) || !Number.isFinite(cut.score)) {
      continue;
    }
    const timeMs = Math.round(cut.timeMs);
    if (timeMs <= 0 || timeMs >= duration) {
      continue;
    }
    inRange.push({ timeMs, score: cut.score });
  }
  inRange.sort((a, b) => a.timeMs - b.timeMs);

  // 同时间去重（保留更高分）。
  const deduped: DetectedCut[] = [];
  for (const cut of inRange) {
    const last = deduped[deduped.length - 1];
    if (last !== undefined && last.timeMs === cut.timeMs) {
      if (cut.score > last.score) {
        deduped[deduped.length - 1] = cut;
      }
      continue;
    }
    deduped.push(cut);
  }

  // 最短镜头过滤：按分数从高到低贪心，保证选中点两两间距 ≥ minGap。
  const byScore = [...deduped].sort((a, b) => b.score - a.score);
  const chosen: DetectedCut[] = [];
  for (const cut of byScore) {
    if (chosen.every((kept) => Math.abs(kept.timeMs - cut.timeMs) >= minGap)) {
      chosen.push(cut);
    }
  }
  chosen.sort((a, b) => a.timeMs - b.timeMs);
  return chosen;
}

interface ShotCacheFile {
  version: string;
  sha256: string;
  threshold: number;
  minShotMs: number;
  cuts: DetectedCut[];
}

const CACHE_VERSION = 'shots-v1';

/** 读取缓存结果；缺失/损坏/参数不匹配返回 null。 */
export async function readCachedCuts(
  folder: string,
  sha256: string,
  threshold: number,
  minShotMs: number,
): Promise<DetectedCut[] | null> {
  const file = path.join(shotsDir(folder), shotCacheName(sha256, threshold, minShotMs));
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<ShotCacheFile>;
    if (
      parsed.version !== CACHE_VERSION ||
      parsed.sha256 !== sha256 ||
      parsed.threshold !== threshold ||
      parsed.minShotMs !== minShotMs ||
      !Array.isArray(parsed.cuts)
    ) {
      return null;
    }
    return parsed.cuts
      .filter((c): c is DetectedCut => c !== null && typeof c === 'object' && typeof c.timeMs === 'number' && typeof c.score === 'number')
      .map((c) => ({ timeMs: Math.round(c.timeMs), score: c.score }));
  } catch {
    return null;
  }
}

export interface DetectShotsOptions {
  projectFolder: string;
  sourceAbsPath: string;
  media: ProjectMedia;
  threshold: number;
  minShotMs: number;
  cancelSignal?: AbortSignal;
  /** 进度：已分析到的媒体时间（毫秒）。 */
  onProgress?: (timeMs: number) => void;
  /** 注入 ffmpeg 运行器（默认 runFfmpeg）；测试可替换。 */
  run?: (args: readonly string[], options?: Parameters<typeof runFfmpeg>[1]) => ReturnType<typeof runFfmpeg>;
}

/** scdet 检测参数（需求给定）：缩放到 480 宽、只处理视频轨、全部丢弃输出到 null。 */
export function shotDetectArgs(sourceAbsPath: string, threshold: number): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-i',
    sourceAbsPath,
    '-map',
    '0:v:0',
    '-vf',
    `scale=480:-2,scdet=t=${threshold}`,
    '-an',
    '-sn',
    '-dn',
    '-f',
    'null',
    '-',
  ];
}

/**
 * 运行检测（命中缓存直接返回）。失败/取消返回错误 Result，不写任何项目数据。
 */
export async function detectShots(options: DetectShotsOptions): Promise<Result<DetectedCut[]>> {
  const { media, threshold, minShotMs } = options;
  const cached = await readCachedCuts(options.projectFolder, media.sha256, threshold, minShotMs);
  if (cached !== null) {
    options.onProgress?.(media.durationMs);
    return ok(cached);
  }

  const run = options.run ?? runFfmpeg;
  const raw: RawCut[] = [];

  const result = await run(shotDetectArgs(options.sourceAbsPath, threshold), {
    cancelSignal: options.cancelSignal,
    onStderrLine: (line) => {
      const parsed = parseScdetLine(line);
      if (parsed !== null) {
        raw.push(parsed);
      }
    },
    onProgress: (progress) => {
      if (progress.outTimeUs !== null) {
        options.onProgress?.(progress.outTimeUs / 1000);
      }
    },
  });

  if (!result.ok) {
    return result.error.code === 'CANCELLED'
      ? err('CANCELLED', '镜头识别已取消。')
      : err(result.error.code, result.error.message);
  }

  const cuts = filterDetectedCuts(raw, media.durationMs, minShotMs);
  try {
    await mkdir(shotsDir(options.projectFolder), { recursive: true });
    const payload: ShotCacheFile = {
      version: CACHE_VERSION,
      sha256: media.sha256,
      threshold,
      minShotMs,
      cuts,
    };
    await writeFileAtomic(
      path.join(shotsDir(options.projectFolder), shotCacheName(media.sha256, threshold, minShotMs)),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  } catch {
    // 缓存写入失败不影响结果返回（非致命）。
  }
  await pruneShotCache(options.projectFolder).catch(() => undefined);
  return ok(cuts);
}

/** 清理超出上限的旧缓存文件（按 mtime），防止无限增长。 */
export async function pruneShotCache(folder: string, maxFiles = 40): Promise<void> {
  const dir = shotsDir(folder);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const files = names.filter((name) => name.startsWith('shots-') && name.endsWith('.json'));
  if (files.length <= maxFiles) {
    return;
  }
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
    if (entry !== undefined) {
      await rm(entry.abs, { force: true }).catch(() => undefined);
    }
  }
}

/** 缓存键的短摘要（供调试/日志）。 */
export function shotCacheDigest(sha256: string, threshold: number, minShotMs: number): string {
  return createHash('sha256').update(`${sha256}|${threshold}|${minShotMs}`).digest('hex').slice(0, 12);
}
/* ------------------------------------------------------------------ */
/* 局部（选中区域）硬切检测                                              */
/* ------------------------------------------------------------------ */

/**
 * 局部检测参数：用输入定位（-ss 置于 -i 之前）只解码选区，再用 -t 限制输出时长，
 * 避免为了局部分析而重新扫描完整视频。
 *
 * 时间偏移说明（需求 2.4：不得直接假设，须针对实际命令验证）：
 * ffmpeg 对输入 `-ss` 默认启用 accurate_seek：从选区前的最近关键帧解码并丢弃，
 * 输出时间戳被重定位为以选区起点为 0。因此 scdet 报告的 `lavfi.scd.time`
 * 是“相对选区起点”的时间；转回项目全局时间需要加上 rangeStartMs。
 * 该偏移由 tests/shot-detect-range.test.ts 使用合成真实视频验证。
 */
export function shotDetectRangeArgs(
  sourceAbsPath: string,
  threshold: number,
  startMs: number,
  endMs: number,
): string[] {
  const startSec = (Math.max(0, startMs) / 1000).toFixed(3);
  const durSec = (Math.max(1, endMs - Math.max(0, startMs)) / 1000).toFixed(3);
  return [
    '-hide_banner',
    '-nostats',
    '-ss',
    startSec,
    '-i',
    sourceAbsPath,
    '-t',
    durSec,
    '-map',
    '0:v:0',
    '-vf',
    `scale=480:-2,scdet=t=${threshold}`,
    '-an',
    '-sn',
    '-dn',
    '-f',
    'null',
    '-',
  ];
}

export interface DetectShotsRangeOptions {
  sourceAbsPath: string;
  threshold: number;
  minShotMs: number;
  /** 选区起点（项目全局毫秒，闭区间）。 */
  inMs: number;
  /** 选区终点（项目全局毫秒，开区间）。 */
  outMs: number;
  /** 项目文件夹与视频摘要：提供时对同范围结果做缓存（加速重复运行）。 */
  projectFolder?: string;
  sha256?: string;
  cancelSignal?: AbortSignal;
  /** 进度：已分析到的全局时间（毫秒）。 */
  onProgress?: (timeMs: number) => void;
  /** 注入运行器（默认 runFfmpeg）；测试可替换。 */
  run?: (args: readonly string[], options?: Parameters<typeof runFfmpeg>[1]) => ReturnType<typeof runFfmpeg>;
}

/** 局部检测缓存文件名（含范围，避免与全片缓存互相覆盖）。 */
export function shotRangeCacheName(
  sha256: string,
  threshold: number,
  minShotMs: number,
  inMs: number,
  outMs: number,
): string {
  return `shots-${sha256.slice(0, 12)}-t${threshold}-m${minShotMs}-r${inMs}-${outMs}.json`;
}

/** 读取局部检测缓存；缺失/损坏/参数不匹配返回 null。 */
export async function readCachedRangeCuts(
  folder: string,
  sha256: string,
  threshold: number,
  minShotMs: number,
  inMs: number,
  outMs: number,
): Promise<DetectedCut[] | null> {
  const file = path.join(shotsDir(folder), shotRangeCacheName(sha256, threshold, minShotMs, inMs, outMs));
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<ShotCacheFile> & { inMs?: number; outMs?: number };
    if (
      parsed.version !== CACHE_VERSION ||
      parsed.sha256 !== sha256 ||
      parsed.threshold !== threshold ||
      parsed.minShotMs !== minShotMs ||
      parsed.inMs !== inMs ||
      parsed.outMs !== outMs ||
      !Array.isArray(parsed.cuts)
    ) {
      return null;
    }
    return parsed.cuts
      .filter((c): c is DetectedCut => c !== null && typeof c === 'object' && typeof c.timeMs === 'number' && typeof c.score === 'number')
      .map((c) => ({ timeMs: Math.round(c.timeMs), score: c.score }));
  } catch {
    return null;
  }
}

/**
 * 只分析所选时间范围，返回转换回全局时间的切点。不写项目数据；提供 folder/sha 时
 * 缓存同范围结果，避免重复扫描。切点严格位于 (inMs, outMs) 内部，并按最短镜头过滤。
 */
export async function detectShotsRange(options: DetectShotsRangeOptions): Promise<Result<DetectedCut[]>> {
  const inMs = Math.max(0, Math.round(options.inMs));
  const outMs = Math.max(inMs + 1, Math.round(options.outMs));
  const rangeMs = outMs - inMs;

  if (options.projectFolder !== undefined && options.sha256 !== undefined) {
    const cached = await readCachedRangeCuts(
      options.projectFolder,
      options.sha256,
      options.threshold,
      options.minShotMs,
      inMs,
      outMs,
    );
    if (cached !== null) {
      options.onProgress?.(outMs);
      return ok(cached);
    }
  }

  const run = options.run ?? runFfmpeg;
  const raw: RawCut[] = [];

  const result = await run(shotDetectRangeArgs(options.sourceAbsPath, options.threshold, inMs, outMs), {
    cancelSignal: options.cancelSignal,
    onStderrLine: (line) => {
      const parsed = parseScdetLine(line);
      if (parsed !== null) {
        raw.push(parsed);
      }
    },
    onProgress: (progress) => {
      if (progress.outTimeUs !== null) {
        options.onProgress?.(inMs + progress.outTimeUs / 1000);
      }
    },
  });

  if (!result.ok) {
    return result.error.code === 'CANCELLED'
      ? err('CANCELLED', '镜头识别已取消。')
      : err(result.error.code, result.error.message);
  }

  const localCuts = filterDetectedCuts(raw, rangeMs, options.minShotMs);
  const globalCuts: DetectedCut[] = localCuts.map((cut) => ({
    timeMs: Math.round(inMs + cut.timeMs),
    score: cut.score,
  }));

  if (options.projectFolder !== undefined && options.sha256 !== undefined) {
    try {
      await mkdir(shotsDir(options.projectFolder), { recursive: true });
      const payload = {
        version: CACHE_VERSION,
        sha256: options.sha256,
        threshold: options.threshold,
        minShotMs: options.minShotMs,
        inMs,
        outMs,
        cuts: globalCuts,
      };
      await writeFileAtomic(
        path.join(shotsDir(options.projectFolder), shotRangeCacheName(options.sha256, options.threshold, options.minShotMs, inMs, outMs)),
        `${JSON.stringify(payload, null, 2)}\n`,
      );
    } catch {
      // 缓存写入失败不致命。
    }
    await pruneShotCache(options.projectFolder).catch(() => undefined);
  }
  return ok(globalCuts);
}