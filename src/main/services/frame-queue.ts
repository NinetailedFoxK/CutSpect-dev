import { createHash } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { err, ok } from '../../shared/api-types';
import type { ProjectMedia, Result } from '../../shared/api-types';
import { buildMediaUrl } from '../../shared/media-url';
import { runFfmpeg } from './ffmpeg';
import { framesDir } from './frame-service';

/**
 * 应用级抽帧队列（规格 5.5 / 9；本轮重构：替代"每帧一次 ffmpeg、每次渲染独立队列"）。
 *
 * 设计（对齐验收"FFmpeg 进程始终不超过 2 个"）：
 * - **单例**：模块级唯一队列，所有时间线/组件共用（不随渲染创建）；
 * - **批处理**：一次 ffmpeg 用 fps 滤镜按等间隔抽一批帧（一张图不再一个进程）；
 * - **全局并发 2**：超出的任务排队，任何时刻运行中的 ffmpeg ≤ 2；
 * - **去重**：相同 (视频/范围/帧数/尺寸) 的请求复用同一在途 Promise 与磁盘缓存；
 * - **取消即终止**：同项目新的可视请求入队时，取消该项目的排队任务并 abort（SIGTERM→SIGKILL）
 *   正在运行的旧 ffmpeg，避免缩放/平移后进程叠加；
 * - **批量清理**：仅在队列空闲时清理一次，不在每帧后扫描目录；
 * - **项目级取消**：离开项目时取消该项目全部任务并释放资源。
 *
 * 抽帧时间轴：输出帧按等间隔近似（fps=count/duration），第 i 帧取 start + (i+0.5)*dur/n。
 * 帧带槽位本就是等宽时间点，该近似与渲染一一对应；切片命名含缓存键，命中即复用。
 */

/** 全局并发上限（验收：ffmpeg 进程始终 ≤ 2）。 */
export const FRAME_QUEUE_CONCURRENCY = 2;

/** 单次批处理帧数上限。 */
export const MAX_BATCH_FRAMES = 240;

/** 空闲清理保留的批文件数上限。 */
export const FRAME_QUEUE_KEEP_FILES = 900;

export const FRAME_BATCH_VERSION = 'fsq-v1';

export interface FilmstripBatchParams {
  projectId: string;
  projectFolder: string;
  sourceAbsPath: string;
  media: ProjectMedia;
  startMs: number;
  endMs: number;
  count: number;
  width: number;
  height: number;
}

export interface FilmstripFrameEntry {
  index: number;
  timeMs: number;
  mediaUrl: string;
}

/** 缓存键：视频 + 范围 + 帧数 + 尺寸（去重与磁盘复用都据此）。 */
export function frameBatchKey(params: {
  sha256: string;
  startMs: number;
  endMs: number;
  count: number;
  width: number;
  height: number;
}): string {
  return createHash('sha256')
    .update(
      `${params.sha256}|${Math.round(params.startMs)}|${Math.round(params.endMs)}|${params.count}|${params.width}x${params.height}|${FRAME_BATCH_VERSION}`,
    )
    .digest('hex')
    .slice(0, 16);
}

export function batchFilePrefix(key: string): string {
  return `fs-${key}-`;
}

/** 第 i 帧（0 基）对应时间：等间隔近似的槽位中心。 */
export function frameTimeMsAt(startMs: number, endMs: number, index: number, total: number): number {
  const duration = Math.max(1, endMs - startMs);
  return Math.round(startMs + (duration * (index + 0.5)) / Math.max(1, total));
}

/** 批处理 ffmpeg 参数（fps 滤镜一次抽一批；尺寸按比例不放大不变形）。 */
export function frameBatchArgs(
  sourceAbsPath: string,
  startMs: number,
  endMs: number,
  count: number,
  width: number,
  height: number,
  outputPattern: string,
): string[] {
  const durationSec = Math.max(0.001, (endMs - startMs) / 1000);
  const fps = Math.max(0.0001, count / durationSec);
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    (Math.max(0, startMs) / 1000).toFixed(3),
    '-i',
    sourceAbsPath,
    '-t',
    durationSec.toFixed(3),
    '-vf',
    `fps=${fps.toFixed(6)},scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    '-q:v',
    '4',
    '-frames:v',
    String(count),
    outputPattern,
  ];
}

async function listBatchFiles(dir: string, prefix: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => name.startsWith(prefix) && name.endsWith('.jpg'))
      .sort();
  } catch {
    return [];
  }
}

/** 空闲清理：只保留最近 FRAME_QUEUE_KEEP_FILES 个批文件（按文件名顺序滚动删除最旧批次）。 */
async function pruneBatchesBatch(dir: string, keep: number): Promise<void> {
  const names = await listBatchFiles(dir, 'fs-');
  if (names.length <= keep) {
    return;
  }
  // fs-<key>-<index>.jpg：按批键分组，逐个删除最旧批次（文件名近似时序，配合持久化排序）。
  const byKey = new Map<string, string[]>();
  for (const name of names) {
    const key = name.slice(3, name.lastIndexOf('-'));
    const bucket = byKey.get(key) ?? [];
    bucket.push(name);
    byKey.set(key, bucket);
  }
  let remaining = names.length;
  for (const bucket of byKey.values()) {
    if (remaining <= keep) break;
    for (const name of bucket) {
      await rm(path.join(dir, name), { force: true }).catch(() => undefined);
    }
    remaining -= bucket.length;
  }
}

interface QueueTask {
  params: FilmstripBatchParams;
  key: string;
  controller: AbortController;
  resolve: (value: Result<FilmstripFrameEntry[]>) => void;
  /** 组内取消（同项目新请求到来）时不报告错误，直接静默丢弃。 */
  superseded: boolean;
}

/**
 * 应用级抽帧队列（单例）。所有 API 都在同一实例上排队与去重。
 */
class FrameQueue {
  private readonly pending: QueueTask[] = [];
  private readonly inflight = new Map<string, Promise<Result<FilmstripFrameEntry[]>>>();
  private readonly activeByProject = new Map<string, QueueTask>();
  private running = 0;
  private pruneTimer: NodeJS.Timeout | null = null;

  request(params: FilmstripBatchParams): Promise<Result<FilmstripFrameEntry[]>> {
    const normalized = normalize(params);
    const key = frameBatchKey({
      sha256: normalized.media.sha256,
      startMs: normalized.startMs,
      endMs: normalized.endMs,
      count: normalized.count,
      width: normalized.width,
      height: normalized.height,
    });
    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      return existing; // 相同请求去重（含在途与刚完成）。
    }

    // 同项目的新可视请求 → 该项目的旧任务作废（排队任务直接丢弃，运行中的 abort）。
    this.supersedeProject(normalized.projectId);

    let resolveFn!: (value: Result<FilmstripFrameEntry[]>) => void;
    const controller = new AbortController();
    const promise = new Promise<Result<FilmstripFrameEntry[]>>((resolve) => {
      resolveFn = resolve;
    });
    this.inflight.set(key, promise);
    this.pending.push({
      params: normalized,
      key,
      controller,
      resolve: (value) => {
        this.inflight.delete(key);
        resolveFn(value);
      },
      superseded: false,
    });
    this.pump();
    return promise;
  }

  private supersedeProject(projectId: string): void {
    for (const task of this.pending) {
      if (task.params.projectId === projectId) {
        task.superseded = true;
      }
    }
    // 移除排队中（尚未启动）的作废任务。
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const task = this.pending[i];
      if (task !== undefined && task.superseded) {
        this.pending.splice(i, 1);
        task.resolve(ok([]));
      }
    }
    // 运行中的旧任务：abort → runFfmpeg 收到信号 kill 子进程。
    const active = this.activeByProject.get(projectId);
    if (active !== undefined) {
      active.controller.abort();
    }
  }

  private pump(): void {
    while (this.running < FRAME_QUEUE_CONCURRENCY && this.pending.length > 0) {
      const task = this.pending.shift();
      if (task === undefined) break;
      if (task.superseded) {
        task.resolve(ok([]));
        continue;
      }
      this.running += 1;
      this.activeByProject.set(task.params.projectId, task);
      void this.execute(task).finally(() => {
        this.running -= 1;
        if (this.activeByProject.get(task.params.projectId) === task) {
          this.activeByProject.delete(task.params.projectId);
        }
        this.pump();
        this.schedulePrune();
      });
    }
  }

  private async execute(task: QueueTask): Promise<void> {
    const result = await runBatch(task);
    // abort 的旧任务结果静默丢弃（避免把过期范围写回渲染层）。
    if (task.controller.signal.aborted) {
      task.resolve(err('CANCELLED', '抽帧已取消。'));
      return;
    }
    task.resolve(result);
  }

  /** 空闲后统一清理（不在每帧后扫描目录）。 */
  private schedulePrune(): void {
    if (this.running > 0 || this.pending.length > 0) {
      return;
    }
    if (this.pruneTimer !== null) {
      return;
    }
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = null;
      void this.pruneAll();
    }, 4000);
    this.pruneTimer.unref?.();
  }

  private async pruneAll(): Promise<void> {
    const folders = new Set<string>();
    for (const task of this.pending) folders.add(task.params.projectFolder);
    for (const task of this.activeByProject.values()) folders.add(task.params.projectFolder);
    for (const folder of folders) {
      await pruneBatchesBatch(framesDir(folder), FRAME_QUEUE_KEEP_FILES).catch(() => undefined);
    }
  }

  /** 项目关闭：取消该项目所有任务（排队丢弃、运行中 kill）。 */
  cancelProject(projectId: string): void {
    this.supersedeProject(projectId);
  }

  /** 诊断用：当前运行中 / 排队中的任务数（供探针确认并发上限）。 */
  stats(): { running: number; queued: number; inflight: number } {
    return { running: this.running, queued: this.pending.length, inflight: this.inflight.size };
  }
}

function normalize(params: FilmstripBatchParams): FilmstripBatchParams {
  const startMs = Math.max(0, Math.round(params.startMs));
  const endMs = Math.max(startMs + 1, Math.round(params.endMs));
  const count = Math.max(1, Math.min(MAX_BATCH_FRAMES, Math.round(params.count)));
  return { ...params, startMs, endMs, count };
}

async function runBatch(task: QueueTask): Promise<Result<FilmstripFrameEntry[]>> {
  const { params, key } = task;
  const dir = framesDir(params.projectFolder);
  await mkdir(dir, { recursive: true });
  const prefix = batchFilePrefix(key);

  const cached = await listBatchFiles(dir, prefix);
  if (cached.length >= params.count) {
    return ok(toEntries(params, cached));
  }
  // 残留的半成品先清掉，避免与本次输出混淆。
  await Promise.all(cached.map((name) => rm(path.join(dir, name), { force: true }).catch(() => undefined)));

  const outputPattern = path.join(dir, `${prefix}%04d.jpg`);
  const result = await runFfmpeg(
    frameBatchArgs(
      params.sourceAbsPath,
      params.startMs,
      params.endMs,
      params.count,
      params.width,
      params.height,
      outputPattern,
    ),
    { cancelSignal: task.controller.signal, noProgressTimeoutMs: 30_000 },
  );
  if (!result.ok) {
    return result;
  }
  const files = await listBatchFiles(dir, prefix);
  if (files.length === 0) {
    return err('FRAME_FAILED', '未能生成时间线画面帧（素材可能不可解码）。');
  }
  return ok(toEntries(params, files));
}

function toEntries(
  params: FilmstripBatchParams,
  files: readonly string[],
): FilmstripFrameEntry[] {
  const total = files.length;
  return files.map((name, i) => ({
    index: i,
    timeMs: frameTimeMsAt(params.startMs, params.endMs, i, total),
    mediaUrl: buildMediaUrl(params.projectId, params.media.id, 'frame', params.media.sha256, name),
  }));
}

/** 模块级单例：所有时间线共用（不随组件渲染重建）。 */
export const frameQueue = new FrameQueue();

/** 便捷入口：一次批处理抽取可视范围的等间隔帧。 */
export function requestFilmstripBatch(
  params: FilmstripBatchParams,
): Promise<Result<FilmstripFrameEntry[]>> {
  return frameQueue.request(params);
}

/** 项目关闭时取消该项目全部抽帧任务。 */
export function cancelProjectFrames(projectId: string): void {
  frameQueue.cancelProject(projectId);
}

export function frameQueueStats(): { running: number; queued: number; inflight: number } {
  return frameQueue.stats();
}