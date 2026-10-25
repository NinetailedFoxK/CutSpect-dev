import { createHash } from 'node:crypto';
import { open, rm, stat, statfs } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { err, ok } from '../../shared/api-types';
import type { Result } from '../../shared/api-types';
import { MediaServiceError, toMediaServiceError } from './errors';
import type { ProbeResult } from './ffmpeg';

/**
 * 媒体复制与哈希服务（规格 9.2 / 10.4 / 15）。
 *
 * - 复制全程 64KB 块流式读写，边复制边算 SHA-256，
 *   任何尺寸的源文件都不会被一次性读入内存（规格 9.2）。
 * - 取消/失败时销毁句柄并删除半成品副本，绝不触碰源文件；
 *   保留完整原片与已保存分析（规格 10.2）。
 * - 进度通过回调上抛（bytes 口径，对应 TaskProgress.kind='bytes'），
 *   本模块不感知 IPC / tasks 通道，由集成阶段接线。
 */

/* ------------------------------------------------------------------ */
/* 流式复制 + SHA-256                                                   */
/* ------------------------------------------------------------------ */

/** 复制块大小（规格 9.2 流式约定；兼顾调用开销与内存占用）。 */
const CHUNK_SIZE = 64 * 1024;
/** 进度回调最小间隔：UI 事件频率足够，避免大文件百万级回调。 */
const PROGRESS_INTERVAL_MS = 200;

export interface CopyProgress {
  completedBytes: number;
  totalBytes: number;
}

export interface CopyHashResult {
  /** 十六进制小写完整 SHA-256（规格 9.3 重新定位校验依据）。 */
  sha256: string;
  bytesCopied: number;
}

export interface CopyWithHashOptions {
  /** 字节进度回调（含 totalBytes；结束时保证有一次 completed==total）。 */
  onProgress?: (progress: CopyProgress) => void;
  /** 取消信号；触发后清理半成品并返回 CANCELLED。 */
  cancelToken?: AbortSignal;
}

async function writeFull(destHandle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await destHandle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) {
      throw new MediaServiceError('IO', '目标写入 0 字节，磁盘可能已满或不可写。', { retryable: true });
    }
    offset += bytesWritten;
  }
}

/** best-effort 清理半成品：清理失败不掩盖原始错误（残留由上层导入流程兜底）。 */
async function cleanupPartial(dest: string): Promise<void> {
  try {
    await rm(dest, { force: true });
  } catch {
    // 刻意吞掉：取消/失败的原始原因优先回报给调用方。
  }
}

/**
 * 流式复制并同步计算 SHA-256（规格 9.2）。
 *
 * 语义：
 * - 成功 → { sha256, bytesCopied }，bytesCopied === 源文件字节数；
 * - cancelToken 触发 → err CANCELLED，半成品已删除，源文件未受影响；
 * - 读写失败（含磁盘满 ENOSPC）→ 对应错误码，同样清理半成品。
 */
export async function copyWithHash(
  src: string,
  dest: string,
  options: CopyWithHashOptions = {},
): Promise<Result<CopyHashResult>> {
  const { onProgress, cancelToken } = options;
  let srcHandle: FileHandle | undefined;
  let destHandle: FileHandle | undefined;
  const hash = createHash('sha256');
  let bytesCopied = 0;
  // 以开始时刻为基准，而不是 0（否则首块恒满足 now - 0 ≥ 200ms，节流失效）。
  let lastReportAt = Date.now();
  let reportedOnce = false;

  const fail = async (error: MediaServiceError): Promise<Result<CopyHashResult>> => {
    if (srcHandle !== undefined) {
      await srcHandle.close().catch(() => undefined);
    }
    if (destHandle !== undefined) {
      await destHandle.close().catch(() => undefined);
    }
    await cleanupPartial(dest);
    return err(error.code, error.message, error.retryable);
  };

  try {
    const srcStat = await stat(src);
    if (!srcStat.isFile()) {
      return fail(new MediaServiceError('IO', '源路径不是常规文件，无法复制。'));
    }
    const totalBytes = srcStat.size;

    srcHandle = await open(src, 'r');
    destHandle = await open(dest, 'w');
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);

    for (;;) {
      // 每块读取前检查取消：本地盘单块读取毫秒级，轮询点足够及时。
      if (cancelToken?.aborted) {
        return fail(new MediaServiceError('CANCELLED', '复制已取消。'));
      }
      const { bytesRead } = await srcHandle.read(buffer, 0, CHUNK_SIZE, null);
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await writeFull(destHandle, chunk);
      bytesCopied += bytesRead;

      const now = Date.now();
      // 首块立即上报（UI 尽快从"排队"进入"进行中"），此后按周期节流，
      // 终态（completed == total）保证上报。
      const shouldReport =
        !reportedOnce || bytesCopied === totalBytes || now - lastReportAt >= PROGRESS_INTERVAL_MS;
      if (onProgress && shouldReport) {
        reportedOnce = true;
        lastReportAt = now;
        onProgress({ completedBytes: bytesCopied, totalBytes });
      }
    }

    await srcHandle.close();
    srcHandle = undefined;
    await destHandle.close();
    destHandle = undefined;

    // 收尾进度：确保 UI 拿到 completed == total 的终态（节流可能错过最后一块）。
    onProgress?.({ completedBytes: bytesCopied, totalBytes });
    return ok({ sha256: hash.digest('hex'), bytesCopied });
  } catch (error) {
    return fail(toMediaServiceError(error));
  }
}

/* ------------------------------------------------------------------ */
/* 磁盘空间估算                                                         */
/* ------------------------------------------------------------------ */

/** 复制安全余量（规格 10.4：按源文件大小加余量检查；估算值非保证）。 */
const COPY_SAFETY_MARGIN_BYTES = 64 * 1024 * 1024;

export interface SpaceEstimate {
  sufficient: boolean;
  /** 建议预留空间 = 源文件大小 + 安全余量。 */
  requiredBytes: number;
  /** 目标目录当前可用空间（statfs bavail × bsize，非 root 可用口径）。 */
  availableBytes: number;
}

/**
 * 检查目标目录是否有足够空间容纳给定字节数（规格 10.4 / 15）。
 * 结果用于"所需空间估算与当前可用量"提示；运行中仍依赖写入错误兜底。
 */
export async function estimateSpaceFor(
  bytes: number,
  targetDir: string,
): Promise<Result<SpaceEstimate>> {
  try {
    const stats = await statfs(targetDir);
    const availableBytes = stats.bavail * stats.bsize;
    const requiredBytes = bytes + COPY_SAFETY_MARGIN_BYTES;
    return ok({ sufficient: availableBytes >= requiredBytes, requiredBytes, availableBytes });
  } catch (error) {
    const wrapped = toMediaServiceError(error);
    return err(wrapped.code, `无法检查目标目录磁盘空间：${wrapped.message}`, wrapped.retryable);
  }
}

/* ------------------------------------------------------------------ */
/* 媒体策略检查                                                         */
/* ------------------------------------------------------------------ */

export type MediaPolicyVerdict = 'ok' | 'needs-compatible-copy' | 'rejected';

/** 规格 10.1 容量基线：单文件 ≤ 20GB、时长 ≤ 2 小时，超出属产品边界。 */
const MAX_SOURCE_BYTES = 20 * 1024 ** 3;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
/** 基线分辨率 1080p（宽 ≤1920 且高 ≤1080；竖屏 1080×1920 按字面超规格，转码到长边 1280 更稳）。 */
const BASELINE_MAX_WIDTH = 1920;
const BASELINE_MAX_HEIGHT = 1080;
/** 基线帧率 ≤30fps；容差覆盖 30000/1001 ≈ 29.97 这类标称值。 */
const BASELINE_MAX_FPS = 30;
const FPS_TOLERANCE = 0.05;
/** 可直接播放的视频编码（h264 基线 + vp8 兼容副本格式本身）。 */
const BASELINE_VIDEO_CODECS = new Set(['h264', 'vp8']);
/** 可直接播放的音频编码（aac 基线 + opus 兼容副本格式本身；无音频轨不算违规）。 */
const BASELINE_AUDIO_CODECS = new Set(['aac', 'opus']);

/**
 * 判定素材走哪条导入路径（规格 10.1 / 15）：
 * - rejected：超出容量基线（>20GB 或 >2h），明确提示本版限制，不开始导入；
 * - needs-compatible-copy：高于 1080p / 高于 30fps / HDR / VFR / 非基线编码
 *   → 进入兼容处理选择，不让用户面对无提示黑屏；
 * - ok：基线范围内（MP4 H.264 8bit SDR AAC 或无音频）。
 *
 * DRM 说明：ffprobe 无法可靠检测 Widevine/FairPlay 等加密（PSSH 盒不保证暴露），
 * 本版不做 DRM 判定；受保护素材会在试播/转码阶段暴露失败，
 * 走规格 10.1"直接试播失败 → 兼容处理选择"兜底路径。
 */
export function checkMediaPolicy(probe: ProbeResult): MediaPolicyVerdict {
  if (probe.sizeBytes > MAX_SOURCE_BYTES || probe.durationMs > MAX_DURATION_MS) {
    return 'rejected';
  }
  const fps = probe.avgFrameRate.num / probe.avgFrameRate.den;
  const overResolution = probe.width > BASELINE_MAX_WIDTH || probe.height > BASELINE_MAX_HEIGHT;
  const overFps = fps > BASELINE_MAX_FPS * (1 + FPS_TOLERANCE);
  const nonBaselineVideo = !BASELINE_VIDEO_CODECS.has(probe.videoCodec);
  const nonBaselineAudio = probe.audioCodec !== null && !BASELINE_AUDIO_CODECS.has(probe.audioCodec);
  if (overResolution || overFps || probe.isHdr || probe.isVfr || nonBaselineVideo || nonBaselineAudio) {
    return 'needs-compatible-copy';
  }
  return 'ok';
}