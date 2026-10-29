import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baselineVideoPath } from './baseline-media';
import { err, ok } from '../src/shared/api-types';
import type { ProjectMedia, Result } from '../src/shared/api-types';
import { resolveFfmpegPaths } from '../src/main/services/ffmpeg';
import {
  FRAME_MAX_FILES,
  frameCacheName,
  frameNumberFor,
  framesDir,
  getFramePreview,
  pruneFrames,
} from '../src/main/services/frame-service';

/** 精确画面帧服务测试（规格 5.4 / 5.5）：缓存键、帧号、抽帧与 LRU 清理。使用注入运行器，不依赖 FFmpeg。 */

function makeMedia(overrides: Partial<ProjectMedia> = {}): ProjectMedia {
  return {
    id: 'media-1',
    originalName: 'a.mp4',
    sourcePath: 'media/source.mp4',
    playbackPath: null,
    sha256: 'a'.repeat(64),
    sizeBytes: 100,
    durationMs: 10_000,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    audioCodec: 'aac',
    avgFrameRate: { num: 30, den: 1 },
    isVfr: false,
    isHdr: false,
    ...overrides,
  };
}

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'laipian-frame-'));
  cleanups.push(dir);
  return dir;
}

describe('frameCacheName', () => {
  it('稳定且随任一参数变化', () => {
    const a = frameCacheName('a'.repeat(64), 1000, 176, 99);
    expect(a).toBe(frameCacheName('a'.repeat(64), 1000, 176, 99));
    expect(a).toMatch(/^frame-[0-9a-f]{24}\.jpg$/);
    expect(a).not.toBe(frameCacheName('b'.repeat(64), 1000, 176, 99));
    expect(a).not.toBe(frameCacheName('a'.repeat(64), 1001, 176, 99));
    expect(a).not.toBe(frameCacheName('a'.repeat(64), 1000, 320, 180));
  });
});

describe('frameNumberFor', () => {
  it('CFR：按帧率换算整数帧号', () => {
    expect(frameNumberFor(makeMedia(), 1000)).toBe(30);
    expect(frameNumberFor(makeMedia(), 500)).toBe(15);
  });

  it('VFR：恒为 null，不伪造精确帧号', () => {
    expect(frameNumberFor(makeMedia({ isVfr: true }), 1000)).toBeNull();
  });

  it('帧率非法（分母为 0）返回 null', () => {
    expect(frameNumberFor(makeMedia({ avgFrameRate: { num: 30, den: 0 } }), 1000)).toBeNull();
    expect(frameNumberFor(makeMedia({ avgFrameRate: { num: 0, den: 1 } }), 1000)).toBeNull();
  });
});

describe('getFramePreview', () => {
  it('抽帧成功返回受控 mediaUrl；相同请求命中缓存不重复抽帧', async () => {
    const folder = await tempDir();
    let runs = 0;
    const run = async (args: readonly string[]): Promise<Result<unknown>> => {
      const out = args[args.length - 1];
      if (out !== undefined) {
        await writeFile(out, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      }
      runs += 1;
      return ok(undefined);
    };
    const media = makeMedia();
    const options = {
      projectId: 'proj-1',
      projectFolder: folder,
      sourceAbsPath: path.join(folder, 'source.mp4'),
      media,
      timeMs: 2000,
      width: 176,
      height: 99,
      run,
    };

    const first = await getFramePreview(options);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.requestedTimeMs).toBe(2000);
    expect(first.data.resolvedTimeMs).toBe(2000);
    expect(first.data.frameNumber).toBe(60);
    expect(first.data.mediaUrl).toContain('laipian-media://proj-1/media-1/frame/frame-');
    expect(runs).toBe(1);

    const second = await getFramePreview(options);
    expect(second.ok && second.data.mediaUrl === first.data.mediaUrl).toBe(true);
    expect(runs).toBe(1); // 缓存命中：不再抽帧。
  });

  it('请求时间被 clamp 到 [0, durationMs]', async () => {
    const folder = await tempDir();
    const run = async (args: readonly string[]): Promise<Result<unknown>> => {
      const out = args[args.length - 1];
      if (out !== undefined) await writeFile(out, Buffer.from([0xff]));
      return ok(undefined);
    };
    const media = makeMedia({ durationMs: 5000 });
    const over = await getFramePreview({
      projectId: 'p',
      projectFolder: folder,
      sourceAbsPath: 'x.mp4',
      media,
      timeMs: 99_999,
      run,
    });
    expect(over.ok && over.data.requestedTimeMs).toBe(5000);

    const under = await getFramePreview({
      projectId: 'p',
      projectFolder: folder,
      sourceAbsPath: 'x.mp4',
      media,
      timeMs: -50,
      run,
    });
    expect(under.ok && under.data.requestedTimeMs).toBe(0);
  });

  it('抽帧失败返回错误且不残留半成品', async () => {
    const folder = await tempDir();
    const run = async (): Promise<Result<unknown>> =>
      err('FFMPEG_FAILED', '抽帧失败');
    const media = makeMedia();
    const result = await getFramePreview({
      projectId: 'p',
      projectFolder: folder,
      sourceAbsPath: 'x.mp4',
      media,
      timeMs: 1000,
      run,
    });
    expect(result.ok).toBe(false);
    const names = await readdir(framesDir(folder)).catch(() => [] as string[]);
    expect(names.filter((n) => n.endsWith('.jpg')).length).toBe(0);
  });

  it('运行器未真正写出文件 → FRAME_FAILED（不伪造成功）', async () => {
    const folder = await tempDir();
    const run = async (): Promise<Result<unknown>> => ok(undefined);
    const result = await getFramePreview({
      projectId: 'p',
      projectFolder: folder,
      sourceAbsPath: 'x.mp4',
      media: makeMedia(),
      timeMs: 1000,
      run,
    });
    expect(result.ok).toBe(false);
  });
});

describe('pruneFrames（LRU 上限）', () => {
  it('超过上限时按 mtime 删除最旧文件', async () => {
    const folder = await tempDir();
    const dir = framesDir(folder);
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, `frame-${i}.jpg`);
      await writeFile(p, Buffer.from([0xff]));
      const stamp = new Date(1000 + i * 1000);
      await utimes(p, stamp, stamp);
    }
    // minIntervalMs=0 关闭节流（生产默认节流为批量清理策略，测试需即时生效）。
    await pruneFrames(dir, 3, 0);
    const left = (await readdir(dir)).filter((n) => n.endsWith('.jpg')).sort();
    expect(left).toEqual(['frame-2.jpg', 'frame-3.jpg', 'frame-4.jpg']);
    expect(FRAME_MAX_FILES).toBeGreaterThan(0);
  });

  it('未超上限不删除', async () => {
    const folder = await tempDir();
    const dir = framesDir(folder);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'frame-0.jpg'), Buffer.from([0xff]));
    await pruneFrames(dir, 3, 0);
    expect((await readdir(dir)).filter((n) => n.endsWith('.jpg')).length).toBe(1);
  });
});
const hasFfmpeg = resolveFfmpegPaths().ffmpeg !== null;
/** dev-assets 或 lavfi 小测试片。都没有时跳过，不失败。 */
const BASELINE_VIDEO = baselineVideoPath();

describe('getFramePreview（真实 ffmpeg）', () => {
  it.skipIf(!hasFfmpeg || BASELINE_VIDEO === null)('抽取真实 JPEG，二次请求命中缓存', async () => {
    const source = BASELINE_VIDEO;
    if (source === null) return;
    const folder = await tempDir();
    const media = makeMedia({ durationMs: 10_000, sha256: 'e'.repeat(64) });
    const options = {
      projectId: 'proj-real',
      projectFolder: folder,
      sourceAbsPath: source,
      media,
      timeMs: 2000,
      width: 176,
      height: 99,
    };
    const first = await getFramePreview(options);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.requestedTimeMs).toBe(2000);
    expect(first.data.frameNumber).toBe(60);
    expect(first.data.mediaUrl).toContain('/frame/');

    const abs = path.join(framesDir(folder), frameCacheName(media.sha256, 2000, 176, 99));
    const bytes = await readFile(abs);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8); // JPEG 魔数

    const second = await getFramePreview(options);
    expect(second.ok && second.data.mediaUrl === first.data.mediaUrl).toBe(true);
  });
});