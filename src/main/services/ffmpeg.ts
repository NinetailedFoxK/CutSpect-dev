import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import path from 'node:path';
import ffmpegStaticPath from 'ffmpeg-static';
import ffprobeStatic from '@ffprobe-installer/ffprobe';
import { err, ok } from '../../shared/api-types';
import type { FrameRate, Result } from '../../shared/api-types';
import { currentAdapter } from '../../platform/common';
import { MediaServiceError } from './errors';

/**
 * ffmpeg / ffprobe 子进程封装（规格 10.2 / 10.4 / 15）。
 *
 * 安全与稳健约定：
 * - 进程一律用参数数组 spawn，禁用 shell 拼接（规格 10.4），
 *   天然兼容中文、空格、emoji、引号与非 ASCII 路径。
 * - 超时采用"无进度超时"：仅在 -progress 长时间无输出时判死，
 *   不按总时长一刀切，合法长视频不会被误杀（规格 10.4）。
 * - 取消通过 AbortSignal 触发 SIGTERM（延迟不退再 SIGKILL），
 *   与超时、编码失败在错误码上严格区分。
 * - parseFfprobeJson / parseFfmpegProgress 为纯函数并单独导出，
 *   供 fixture 单测直接使用。
 */

/* ------------------------------------------------------------------ */
/* 可执行文件路径解析                                                    */
/* ------------------------------------------------------------------ */

export type FfmpegToolSource = 'env' | 'system-path' | 'dev-homebrew' | 'app-resources';

export interface ToolLookup {
  /** 可执行文件绝对路径。 */
  path: string;
  source: FfmpegToolSource;
}

export interface FfmpegPathResolution {
  ffmpeg: ToolLookup | null;
  ffprobe: ToolLookup | null;
}

const ENV_FFMPEG = 'LAIPIAN_FFMPEG_PATH';
const ENV_FFPROBE = 'LAIPIAN_FFPROBE_PATH';

/** 开发机常见安装目录（按平台适配；不假设其一定存在于 PATH 中）。 */
const DEV_FALLBACK_DIRS: readonly string[] = currentAdapter().ffmpegFallbackDirs;

/** Electron 主进程才有的全局（vitest / ELECTRON_RUN_AS_NODE 下不存在）。 */
function electronResourcesPath(): string | null {
  const res = (process as { resourcesPath?: unknown }).resourcesPath;
  return typeof res === 'string' && res.length > 0 ? res : null;
}

/** 阶段 D 打包布局候选（规格 16.2：随平台打进 resources；布局确定后收敛）。 */
function resourceCandidates(tool: string): string[] {
  const res = electronResourcesPath();
  if (!res) {
    return [];
  }
  return [path.join(res, 'ffmpeg', tool), path.join(res, 'ffmpeg', 'bin', tool)];
}

function unpackedExecutable(candidate: string): string {
  return candidate.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function bundledCandidate(tool: 'ffmpeg' | 'ffprobe'): string | null {
  const raw = tool === 'ffmpeg' ? ffmpegStaticPath : ffprobeStatic.path;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const candidate = unpackedExecutable(raw);
  return existsSync(candidate) && isExecutable(candidate) ? candidate : null;
}

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}


function searchDirsFor(dirs: readonly string[], tool: string): string | null {
  const names = currentAdapter().executableNames(tool);
  for (const dir of dirs) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate) && isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** 单个工具查找：显式 env → 随包二进制 → 系统 PATH → 开发回退目录。 */
function resolveTool(tool: 'ffmpeg' | 'ffprobe'): ToolLookup | null {
  const envKey = tool === 'ffmpeg' ? ENV_FFMPEG : ENV_FFPROBE;
  const envValue = process.env[envKey];
  if (envValue) {
    if (existsSync(envValue) && isExecutable(envValue)) {
      return { path: envValue, source: 'env' };
    }
    // 显式配置却无效时保留线索给开发者，不静默吞掉配置错误。
    console.warn(`[media] ${envKey}=${envValue} 不可用，回退到系统查找。`);
  }

  const fromBundle = bundledCandidate(tool);
  if (fromBundle) {
    return { path: fromBundle, source: 'app-resources' };
  }

  const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
  const fromPath = searchDirsFor(pathDirs, tool);
  if (fromPath) {
    return { path: fromPath, source: 'system-path' };
  }

  // 开发期回退：Homebrew 默认目录可能未进当前进程 PATH。
  const fromDev = searchDirsFor(DEV_FALLBACK_DIRS, tool);
  if (fromDev) {
    return { path: fromDev, source: 'dev-homebrew' };
  }

  // 兼容旧的 resources/ffmpeg 手工布局。
  const fromResources = searchDirsFor(resourceCandidates(tool), tool);
  if (fromResources) {
    return { path: fromResources, source: 'app-resources' };
  }
  return null;
}

/**
 * 解析 ffmpeg / ffprobe 可执行文件位置（规格 10.2/16.2）。
 * 优先级：env 覆盖 → 系统 PATH → 开发回退目录 → 应用 resources（打包分发）。
 * 未找到的条目为 null，由调用方决定报错方式；每次调用重新探测，无隐藏缓存。
 */
export function resolveFfmpegPaths(): FfmpegPathResolution {
  return { ffmpeg: resolveTool('ffmpeg'), ffprobe: resolveTool('ffprobe') };
}

/* ------------------------------------------------------------------ */
/* ffprobe JSON 解析（纯函数，单测入口）                                  */
/* ------------------------------------------------------------------ */

/** ffprobe JSON 的宽松子集（字段按需出现，缺失即触发回退或报错）。 */
export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_space?: string;
  color_primaries?: string;
  color_transfer?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
}

export interface FfprobeFormat {
  duration?: string;
  size?: string;
  nb_streams?: number;
  format_name?: string;
}

export interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

/** 探测结果（字段与 project.json 的 ProjectMedia 对齐）。 */
export interface ProbeResult {
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  avgFrameRate: FrameRate;
  isVfr: boolean;
  isHdr: boolean;
  sizeBytes: number;
}

/** "30/1"、"30000/1001"、"30" → FrameRate；0/0、负数、垃圾格式 → null。 */
export function parseRational(value: unknown): FrameRate | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  const fraction = /^(\d+)\/(\d+)$/.exec(text);
  if (fraction) {
    const num = Number(fraction[1]);
    const den = Number(fraction[2]);
    return Number.isSafeInteger(num) && Number.isSafeInteger(den) && num > 0 && den > 0
      ? { num, den }
      : null;
  }
  const plain = Number(text);
  if (Number.isFinite(plain) && plain > 0) {
    return { num: Math.round(plain * 1000), den: 1000 };
  }
  return null;
}

function parsePositiveNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * HDR 判定（规格 10.1：检测到 HDR 走兼容处理，不承诺直接播放）。
 * 依据 ffprobe 的 pix_fmt / color_space / color_primaries / color_transfer：
 * - 传输函数为 PQ（smpte2084）或 HLG（arib-std-b67）→ 必为 HDR；
 * - BT.2020 色域（primaries 或 matrix 以 bt2020 开头）→ 按宽色域 HDR 处理；
 * - 像素格式为 10bit 及以上（yuv420p10le / p010le / gray12 等）→ 按 HDR 处理。
 * 均不满足时返回 false（8bit bt709 等 SDR 常见组合）。
 */
export function detectHdr(stream: FfprobeStream): boolean {
  const transfer = stream.color_transfer ?? '';
  if (transfer === 'smpte2084' || transfer === 'arib-std-b67') {
    return true;
  }
  const primaries = stream.color_primaries ?? '';
  if (primaries.startsWith('bt2020')) {
    return true;
  }
  const colorSpace = stream.color_space ?? '';
  if (colorSpace.startsWith('bt2020')) {
    return true;
  }
  const pixFmt = stream.pix_fmt ?? '';
  // 8bit 常见格式（yuv420p/yuyv422 等）不含位深后缀；10/12/16bit 均带位深标记。
  if (/(^|[^0-9])(10|12|14|16)(le|be)?$/.test(pixFmt) || /^(p010|p016|gray10|gray12|gray16)/.test(pixFmt)) {
    return true;
  }
  return false;
}

/**
 * VFR 估算（规格 10.2）。
 * - 主信号：nb_frames 与 duration × avgFrameRate 的偏差超过 5% → VFR
 *   （CFR 时两者几乎相等；VFR 时 nb_frames 通常多于按平均帧率的推算值）。
 * - 辅助信号：r_frame_rate 与 avg_frame_rate 换算帧率差异超过 5%。
 * 两信号都拿不准（nb_frames 缺失、r==avg）时返回 false：
 * 宁可漏判交给"试播失败→兼容处理"兜底，也不误伤正常 CFR 素材。
 */
export function detectVfr(stream: FfprobeStream, durationSec: number, avgFrameRate: FrameRate): boolean {
  const expectedFps = avgFrameRate.num / avgFrameRate.den;
  const nbFrames = parsePositiveNumber(stream.nb_frames);
  if (nbFrames !== null && durationSec > 0 && expectedFps > 0) {
    const expectedFrames = durationSec * expectedFps;
    if (Math.abs(nbFrames - expectedFrames) / expectedFrames > 0.05) {
      return true;
    }
  }
  const rRate = parseRational(stream.r_frame_rate);
  if (rRate !== null) {
    const rFps = rRate.num / rRate.den;
    if (expectedFps > 0 && Math.abs(rFps - expectedFps) / expectedFps > 0.05) {
      return true;
    }
  }
  return false;
}

/**
 * 解析 ffprobe `-print_format json -show_format -show_streams` 输出（纯函数）。
 * 无视频轨抛 NO_VIDEO_TRACK（规格 15"未找到可用视频轨"）；
 * 时长/尺寸/帧率缺失或不可计算抛 PROBE_INCOMPLETE。
 */
export function parseFfprobeJson(json: unknown): ProbeResult {
  const data = json as FfprobeJson;
  const streams = Array.isArray(data?.streams) ? (data.streams as FfprobeStream[]) : [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) {
    throw new MediaServiceError('NO_VIDEO_TRACK', '未找到可用视频轨，请重新选择视频文件。');
  }
  const audio = streams.find((s) => s.codec_type === 'audio');

  const width = video.width;
  const height = video.height;
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
    throw new MediaServiceError('PROBE_INCOMPLETE', '视频流缺少有效的分辨率信息。');
  }
  if (typeof video.codec_name !== 'string' || video.codec_name.length === 0) {
    throw new MediaServiceError('PROBE_INCOMPLETE', '视频流缺少编码格式信息。');
  }

  // 帧率：avg_frame_rate 优先，0/0 等无效值回退 r_frame_rate（部分封装不填 avg）。
  const avgFrameRate = parseRational(video.avg_frame_rate) ?? parseRational(video.r_frame_rate);
  if (!avgFrameRate) {
    throw new MediaServiceError('PROBE_INCOMPLETE', '无法解析视频帧率信息。');
  }

  // 时长：format.duration 优先（含容器级信息），回退视频流 duration，
  // 再回退 nb_frames ÷ avgFrameRate 估算；全部缺失无法建立唯一时间域。
  const formatDurationSec = parsePositiveNumber(data?.format?.duration);
  const streamDurationSec = parsePositiveNumber(video.duration);
  const nbFrames = parsePositiveNumber(video.nb_frames);
  const fps = avgFrameRate.num / avgFrameRate.den;
  const estimatedSec = nbFrames !== null && fps > 0 ? nbFrames / fps : null;
  const durationSec = formatDurationSec ?? streamDurationSec ?? estimatedSec;
  if (durationSec === null) {
    throw new MediaServiceError('PROBE_INCOMPLETE', '无法确定视频时长。');
  }
  const durationMs = Math.round(durationSec * 1000);

  const sizeBytes = parsePositiveNumber(data?.format?.size);

  return {
    durationMs,
    width,
    height,
    videoCodec: video.codec_name,
    audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name : null,
    avgFrameRate,
    isVfr: detectVfr(video, durationSec, avgFrameRate),
    isHdr: detectHdr(video),
    sizeBytes: sizeBytes ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* 子进程公共逻辑                                                       */
/* ------------------------------------------------------------------ */

/** 子进程 stdout/stderr 累积上限：只保留尾部用于错误信息，防内存膨胀。 */
const STDERR_TAIL_LIMIT = 16 * 1024;

function appendTail(current: string, chunk: string): string {
  const merged = current + chunk;
  return merged.length > STDERR_TAIL_LIMIT ? merged.slice(-STDERR_TAIL_LIMIT) : merged;
}

interface ChildRun {
  stdoutText: string;
  stderrTail: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
}

/**
 * 运行一个"一次性输出型"子进程（ffprobe）：
 * 收集 stdout 全量（JSON）、stderr 尾部，带无输出看门狗。
 */
function runCaptureTool(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ChildRun> {
  return new Promise((resolve) => {
    // 参数数组 spawn，禁用 shell（规格 10.4）。
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdoutText = '';
    let stderrTail = '';
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutText += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = appendTail(stderrTail, chunk.toString('utf8'));
    });

    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    watchdog.unref?.();

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      resolve({ stdoutText, stderrTail, exitCode, signal, timedOut, cancelled: false });
    };
    child.on('close', finish);
    child.on('error', (error) => {
      stderrTail = appendTail(stderrTail, String(error));
      finish(null, null);
    });
  });
}

/** ffprobe 无输出看门狗（探测正常情况亚秒级完成）。 */
const PROBE_WATCHDOG_MS = 60_000;

/**
 * 探测单个媒体文件（规格 10.1：扩展名仅用于筛选，实际由 ffprobe 检查）。
 * 返回 Result；无视频轨 → NO_VIDEO_TRACK；找不到可执行文件 → FFMPEG_NOT_FOUND。
 */
export async function probeFile(absPath: string): Promise<Result<ProbeResult>> {
  const { ffprobe } = resolveFfmpegPaths();
  if (!ffprobe) {
    return err(
      'FFMPEG_NOT_FOUND',
      '未找到 ffprobe，请安装 FFmpeg 或通过 LAIPIAN_FFPROBE_PATH 指定路径。',
      true,
    );
  }
  const run = await runCaptureTool(
    ffprobe.path,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absPath],
    PROBE_WATCHDOG_MS,
  );
  if (run.timedOut) {
    return err('NO_PROGRESS_TIMEOUT', '探测媒体信息超时，该文件可能损坏或读取极慢。', true);
  }
  if (run.exitCode !== 0) {
    const detail = run.stderrTail.trim().split('\n').pop() ?? '';
    return err('PROBE_FAILED', `读取媒体信息失败：${detail || `ffprobe 退出码 ${run.exitCode}`}`);
  }
  try {
    const json = JSON.parse(run.stdoutText) as unknown;
    return ok(parseFfprobeJson(json));
  } catch (error) {
    if (error instanceof MediaServiceError) {
      return err(error.code, error.message, error.retryable);
    }
    return err('PROBE_FAILED', '媒体信息格式无法解析。');
  }
}

/* ------------------------------------------------------------------ */
/* ffmpeg 进度型运行                                                    */
/* ------------------------------------------------------------------ */

/** `-progress pipe:1` 单块 key=value 快照。 */
export interface FfmpegProgress {
  frame: number | null;
  fps: number | null;
  /** 已输出字节数（total_size）。 */
  totalSize: number | null;
  /** 输出时间（微秒，out_time_us）。 */
  outTimeUs: number | null;
  /** 编码速度倍率（speed=1.53x）。 */
  speed: number | null;
  /** 本块结尾标记：continue 为进行中，end 为结束块。 */
  progress: 'continue' | 'end';
}

function parseProgressNumber(raw: string): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * 解析一个 -progress 输出块（纯函数）。
 * 输入为不含上一块残余的文本块（以 progress=… 行收尾）；
 * 缺失字段置 null，块内无 progress= 行返回 null（半截块）。
 */
export function parseFfmpegProgress(chunk: string): FfmpegProgress | null {
  let frame: number | null = null;
  let fps: number | null = null;
  let totalSize: number | null = null;
  let outTimeUs: number | null = null;
  let speed: number | null = null;
  let progress: 'continue' | 'end' | null = null;

  for (const line of chunk.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case 'frame':
        frame = parseProgressNumber(value);
        break;
      case 'fps':
        fps = parseProgressNumber(value);
        break;
      case 'total_size':
        totalSize = parseProgressNumber(value);
        break;
      case 'out_time_us':
        outTimeUs = parseProgressNumber(value);
        break;
      case 'speed': {
        const matched = /^(\d+(?:\.\d+)?)x/.exec(value);
        speed = matched ? Number(matched[1]) : null;
        break;
      }
      case 'progress':
        progress = value === 'end' ? 'end' : 'continue';
        break;
      default:
        break;
    }
  }
  if (progress === null) {
    return null;
  }
  return { frame, fps, totalSize, outTimeUs, speed, progress };
}

export interface FfmpegRunOptions {
  /** 每收到一个完整 -progress 块回调一次。 */
  onProgress?: (progress: FfmpegProgress) => void;
  /** 每收到一行 stderr 回调一次（如 scdet 日志解析）；尾部仍累积用于错误摘要。 */
  onStderrLine?: (line: string) => void;
  /** 取消信号：触发 SIGTERM（3s 不退再 SIGKILL），结果是 CANCELLED。 */
  cancelSignal?: AbortSignal;
  /** 无进度超时（规格 10.4），默认 30s；-progress 停止输出即计时。 */
  noProgressTimeoutMs?: number;
}

export interface FfmpegRunOutcome {
  /** 最后一个进度块（含结束块）；无输出时为 null。 */
  lastProgress: FfmpegProgress | null;
}

const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 30_000;
/** 取消后给 ffmpeg 的体面退出时间，超时升级 SIGKILL（进程树兜底）。 */
const CANCEL_KILL_GRACE_MS = 3_000;

/**
 * 运行 ffmpeg（规格 10.4）。args 由调用方组装（如转码参数）；
 * 本函数自动保证 `-progress pipe:1` 存在（全局选项，前置合法），
 * 以驱动进度回调与无进度看门狗。
 * 退出码 0 → ok；取消 → CANCELLED；无进度 → NO_PROGRESS_TIMEOUT；
 * 其余非零退出 → FFMPEG_FAILED（附 stderr 尾部摘要）。
 */
export function runFfmpeg(
  args: readonly string[],
  options: FfmpegRunOptions = {},
): Promise<Result<FfmpegRunOutcome>> {
  const { onProgress, onStderrLine, cancelSignal, noProgressTimeoutMs = DEFAULT_NO_PROGRESS_TIMEOUT_MS } = options;
  return new Promise((resolve) => {
    const { ffmpeg } = resolveFfmpegPaths();
    if (!ffmpeg) {
      resolve(
        err('FFMPEG_NOT_FOUND', '未找到 ffmpeg，请安装 FFmpeg 或通过 LAIPIAN_FFMPEG_PATH 指定路径。', true),
      );
      return;
    }

    const finalArgs = args.includes('-progress')
      ? [...args]
      : ['-progress', 'pipe:1', ...args];

    const child = spawn(ffmpeg.path, finalArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderrTail = '';
    let pendingErr = '';
    let lastProgress: FfmpegProgress | null = null;
    let pendingLines: string[] = [];
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    let watchdog: NodeJS.Timeout | undefined;
    const armWatchdog = (): void => {
      clearTimeout(watchdog);
      // 仅在收到新进度输出时重置：无进度超时而非总时长超时（规格 10.4）。
      watchdog = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, noProgressTimeoutMs);
      watchdog.unref?.();
    };

    const killTree = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill('SIGTERM');
      // SIGTERM 后仍存活则升级 SIGKILL，确保不留下后台转码进程（规格 10.4）。
      const escalator = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, CANCEL_KILL_GRACE_MS);
      escalator.unref?.();
    };

    const onAbort = (): void => {
      cancelled = true;
      killTree();
    };
    cancelSignal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      pendingLines.push(chunk.toString('utf8'));
      // 按行缓冲：progress= 行标志块结束，整块解析后回调。
      const text = pendingLines.join('');
      const lines = text.split('\n');
      pendingLines = [lines.pop() ?? ''];
      const block = lines.join('\n');
      if (block.includes('progress=')) {
        const parsed = parseFfmpegProgress(block);
        if (parsed) {
          lastProgress = parsed;
          onProgress?.(parsed);
        }
        armWatchdog();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = pendingErr + chunk.toString('utf8');
      const lines = text.split('\n');
      pendingErr = lines.pop() ?? '';
      for (const line of lines) {
        stderrTail = appendTail(stderrTail, `${line}\n`);
        if (onStderrLine !== undefined && line.length > 0) {
          onStderrLine(line);
        }
      }
    });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      cancelSignal?.removeEventListener('abort', onAbort);
      if (cancelled || signal === 'SIGTERM' || signal === 'SIGKILL') {
        resolve(err('CANCELLED', '操作已取消。'));
      } else if (timedOut) {
        resolve(err('NO_PROGRESS_TIMEOUT', `ffmpeg ${noProgressTimeoutMs / 1000}s 无进度输出，已终止。`, true));
      } else if (exitCode === 0) {
        resolve(ok({ lastProgress }));
      } else {
        const detail = stderrTail.trim().split('\n').pop() ?? '';
        resolve(
          err('FFMPEG_FAILED', `ffmpeg 执行失败（退出码 ${exitCode ?? 'unknown'}）：${detail}`),
        );
      }
    };
    child.on('close', finish);
    child.on('error', (error) => {
      stderrTail = appendTail(stderrTail, String(error));
      finish(null, null);
    });

    armWatchdog();
  });
}
