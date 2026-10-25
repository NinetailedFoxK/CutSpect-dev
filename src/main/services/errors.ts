import type { LaipianError } from '../../shared/api-types';

/**
 * 媒体服务层错误（规格 15：错误信息面向创作者，不暴露堆栈）。
 *
 * 服务层（ffmpeg / media-service / protocol）不直接触碰 IPC；
 * 异常统一以本类型抛出或折叠进 Result.error，由集成阶段
 * （ipc.ts handler）转换为 renderer 可见的 Result。
 *
 * code 在 shared/api-types.ERROR_CODES 之外按需追加，保持全局唯一稳定。
 */

/** 媒体服务追加错误码（不与 ERROR_CODES 现有条目冲突）。 */
export const MEDIA_ERROR_CODES = {
  /** ffprobe 报告没有可用视频轨（规格 15"未找到可用视频轨"）。 */
  NO_VIDEO_TRACK: 'NO_VIDEO_TRACK',
  /** ffprobe 进程失败或输出不可解析。 */
  PROBE_FAILED: 'PROBE_FAILED',
  /** ffprobe JSON 缺少计算时长/帧率等必需字段。 */
  PROBE_INCOMPLETE: 'PROBE_INCOMPLETE',
  /** 找不到可用的 ffmpeg/ffprobe 可执行文件。 */
  FFMPEG_NOT_FOUND: 'FFMPEG_NOT_FOUND',
  /** ffmpeg 以非零退出码结束（含编码失败、参数错误）。 */
  FFMPEG_FAILED: 'FFMPEG_FAILED',
  /** 调用方通过 cancelToken/signal 主动取消。 */
  CANCELLED: 'CANCELLED',
  /** 无进度超时（规格 10.4：与用户取消严格区分）。 */
  NO_PROGRESS_TIMEOUT: 'NO_PROGRESS_TIMEOUT',
  /** 磁盘空间不足（规格 15：给出所需空间估算与当前可用量）。 */
  DISK_FULL: 'DISK_FULL',
  /** 文件读写失败（IO 错误、外接盘中途断开等）。 */
  IO: 'IO',
} as const;

export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[keyof typeof MEDIA_ERROR_CODES];

export interface MediaServiceErrorOptions {
  /** true 表示调用方可安全重试（如磁盘暂时占用）。 */
  retryable?: boolean;
  /** 原始异常（如 Node 系统错误的 code：ENOSPC/ENOENT）。 */
  cause?: unknown;
}

/** 带 stable code 的服务错误；message 为人类可读中文。 */
export class MediaServiceError extends Error {
  readonly code: MediaErrorCode;
  readonly retryable: boolean;

  constructor(code: MediaErrorCode, message: string, options: MediaServiceErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'MediaServiceError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }

  /** 转为 shared 契约的 LaipianError（供 Result.error 使用）。 */
  toLaipianError(): LaipianError {
    return { code: this.code, message: this.message, retryable: this.retryable || undefined };
  }
}

/** 判断未知异常是否为媒体服务错误并取回 code；其余返回 null。 */
export function getMediaErrorCode(error: unknown): MediaErrorCode | null {
  return error instanceof MediaServiceError ? error.code : null;
}

/** 把未知异常翻译为 MediaServiceError（保留可重试 IO 语义）。 */
export function toMediaServiceError(error: unknown): MediaServiceError {
  if (error instanceof MediaServiceError) {
    return error;
  }
  const nodeCode = (error as NodeJS.ErrnoException | null)?.code;
  if (nodeCode === 'ENOSPC') {
    return new MediaServiceError('DISK_FULL', '磁盘空间不足，无法完成写入。', { retryable: true, cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new MediaServiceError('IO', `文件读写失败：${message}`, { cause: error });
}