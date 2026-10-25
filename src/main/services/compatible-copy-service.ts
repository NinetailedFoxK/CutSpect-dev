import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok } from '../../shared/api-types';
import type { ProjectMedia, Result } from '../../shared/api-types';
import { runFfmpeg, probeFile } from './ffmpeg';
import type { ProbeResult } from './ffmpeg';

/**
 * 兼容副本生成（规格 10.2）。
 *
 * 固定 WebM/VP8/Opus：长边 ≤1280、保持比例不放大、30fps CFR、yuv420p；
 * 无音频则不创建假音轨（-an）。写到 .partial，只有转码成功且校验通过
 * （可播 + 时长差异 ≤100ms）才改正式名；取消/失败/磁盘满都保留原片与已保存分析。
 *
 * 依赖（run / probe）可注入，便于单测；真实转码用真实 ffmpeg 验证。
 */

export const COMPAT_LONG_EDGE = 1280;
export const COMPAT_FPS = 30;
/** 与标准时长差异容许上限（规格 10.2）。 */
export const COMPAT_DURATION_TOLERANCE_MS = 100;

export type FfmpegRunner = (
  args: readonly string[],
  options?: { cancelSignal?: AbortSignal },
) => Promise<Result<unknown>>;

export interface CompatibleCopyOptions {
  sourceAbsPath: string;
  /** 最终目标（如 <project>/media/playback.webm）。 */
  targetPath: string;
  media: ProjectMedia;
  cancelSignal?: AbortSignal;
  /** 进度上报（当前为步骤级；调用方映射为任务事件）。 */
  onProgress?: (step: string) => void;
  run?: FfmpegRunner;
  probe?: (absPath: string) => Promise<Result<ProbeResult>>;
}

export interface CompatibleCopyResult {
  path: string;
  durationMs: number;
}

/** 计算缩放滤镜：长边不超过 1280；不放大；强制偶数尺寸（yuv420p 要求）。 */
export function scaleFilterFor(media: ProjectMedia): string {
  if (media.width > COMPAT_LONG_EDGE) {
    return `scale=${COMPAT_LONG_EDGE}:-2`;
  }
  return 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
}

/** 组装转码参数（规格 10.2 固定参数）。 */
export function buildCompatibleArgs(source: string, partial: string, media: ProjectMedia): string[] {
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    source,
    '-c:v',
    'libvpx',
    '-b:v',
    '1200k',
    '-deadline',
    'realtime',
    '-cpu-used',
    '4',
    '-vf',
    scaleFilterFor(media),
    '-r',
    String(COMPAT_FPS),
    '-pix_fmt',
    'yuv420p',
  ];
  if (media.audioCodec !== null) {
    args.push('-c:a', 'libopus', '-b:a', '96k');
  } else {
    args.push('-an');
  }
  args.push('-f', 'webm', partial);
  return args;
}

export async function createCompatibleCopy(
  options: CompatibleCopyOptions,
): Promise<Result<CompatibleCopyResult>> {
  const run: FfmpegRunner =
    options.run ??
    ((args, runOptions) =>
      runFfmpeg(args, { cancelSignal: runOptions?.cancelSignal }).then((r) => (r.ok ? ok(r.data) : r)));
  const probe = options.probe ?? probeFile;

  const partial = `${options.targetPath}.partial`;
  await mkdir(path.dirname(options.targetPath), { recursive: true });

  options.onProgress?.('转换兼容副本');
  const transcoded = await run(buildCompatibleArgs(options.sourceAbsPath, partial, options.media), {
    cancelSignal: options.cancelSignal,
  });
  if (!transcoded.ok) {
    await rm(partial, { force: true }).catch(() => undefined);
    return transcoded;
  }
  if (options.cancelSignal?.aborted) {
    await rm(partial, { force: true }).catch(() => undefined);
    return err('CANCELLED', '兼容副本生成已取消。');
  }

  // 校验：产物存在、可探测、时长与标准差异 ≤100ms（规格 10.2）。
  let info;
  try {
    info = await stat(partial);
  } catch {
    return err('FFMPEG_FAILED', '兼容副本未生成。', true);
  }
  if (info.size === 0) {
    await rm(partial, { force: true }).catch(() => undefined);
    return err('FFMPEG_FAILED', '兼容副本为空。', true);
  }
  options.onProgress?.('校验兼容副本');
  const probed = await probe(partial);
  if (!probed.ok) {
    await rm(partial, { force: true }).catch(() => undefined);
    return probed;
  }
  const delta = Math.abs(probed.data.durationMs - options.media.durationMs);
  if (delta > COMPAT_DURATION_TOLERANCE_MS) {
    await rm(partial, { force: true }).catch(() => undefined);
    return err(
      'COMPAT_DURATION_MISMATCH',
      `兼容副本时长与标准相差 ${Math.round(delta)}ms（>${COMPAT_DURATION_TOLERANCE_MS}ms），已判为转换失败。`,
    );
  }

  try {
    await rename(partial, options.targetPath);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    return err('IO', `写入兼容副本失败：${(error as Error).message}`, true);
  }
  return ok({ path: options.targetPath, durationMs: probed.data.durationMs });
}