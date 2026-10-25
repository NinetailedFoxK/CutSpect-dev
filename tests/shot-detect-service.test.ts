import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { err, ok } from '../src/shared/api-types';
import type { ProjectMedia, Result } from '../src/shared/api-types';
import { resolveFfmpegPaths } from '../src/main/services/ffmpeg';
import type { FfmpegRunOutcome, FfmpegRunOptions } from '../src/main/services/ffmpeg';
import {
  detectShots,
  filterDetectedCuts,
  parseScdetLine,
  readCachedCuts,
  shotCacheName,
  shotDetectArgs,
  shotsDir,
} from '../src/main/services/shot-detect-service';

/** 智能镜头识别服务测试：scdet 日志解析、候选过滤、缓存与取消。使用注入运行器，不依赖 FFmpeg。 */

function makeMedia(overrides: Partial<ProjectMedia> = {}): ProjectMedia {
  return {
    id: 'media-1',
    originalName: 'a.mp4',
    sourcePath: 'media/source.mp4',
    playbackPath: null,
    sha256: 'f'.repeat(64),
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
  const dir = await mkdtemp(path.join(tmpdir(), 'laipian-shots-'));
  cleanups.push(dir);
  return dir;
}

describe('parseScdetLine', () => {
  it('解析标准 scdet 行（含逗号、顺序无关）', () => {
    expect(parseScdetLine('[Parsed_scdet_0 @ 0x1] lavfi.scd.score: 12.5, lavfi.scd.time: 1.234')).toEqual({
      timeMs: 1234,
      score: 12.5,
    });
    expect(parseScdetLine('lavfi.scd.time: 2.5 lavfi.scd.score: -1.5')).toEqual({
      timeMs: 2500,
      score: -1.5,
    });
  });

  it('非 scdet 行 / 缺字段 / 非数值返回 null', () => {
    expect(parseScdetLine('Input #0, mov, from ...')).toBeNull();
    expect(parseScdetLine('lavfi.scd.score: 2.0')).toBeNull();
    expect(parseScdetLine('lavfi.scd.time: abc lavfi.scd.score: 1')).toBeNull();
  });
});

describe('filterDetectedCuts', () => {
  it('去掉起点/终点与超时长，转整数毫秒并排序', () => {
    const cuts = filterDetectedCuts(
      [
        { timeMs: 0, score: 99 },
        { timeMs: 10_000, score: 99 },
        { timeMs: 20_000, score: 99 },
        { timeMs: 2_000.4, score: 5 },
        { timeMs: 1_000.6, score: 6 },
      ],
      10_000,
      500,
    );
    expect(cuts).toEqual([
      { timeMs: 1001, score: 6 },
      { timeMs: 2000, score: 5 },
    ]);
  });

  it('同时间点去重保留高分', () => {
    const cuts = filterDetectedCuts(
      [
        { timeMs: 3000, score: 4 },
        { timeMs: 3000, score: 9 },
      ],
      10_000,
      500,
    );
    expect(cuts).toEqual([{ timeMs: 3000, score: 9 }]);
  });

  it('最短镜头过滤：距离过近只保留分数更高者', () => {
    const cuts = filterDetectedCuts(
      [
        { timeMs: 2000, score: 9 },
        { timeMs: 2200, score: 3 },
        { timeMs: 5000, score: 6 },
      ],
      10_000,
      500,
    );
    expect(cuts).toEqual([
      { timeMs: 2000, score: 9 },
      { timeMs: 5000, score: 6 },
    ]);
  });

  it('非有限值忽略', () => {
    expect(filterDetectedCuts([{ timeMs: Number.NaN, score: 1 }], 10_000, 500)).toEqual([]);
  });
});

describe('shotDetectArgs', () => {
  it('包含 scale + scdet 阈值与 null 输出（不写文件、不带音字幕）', () => {
    const args = shotDetectArgs('/abs/source.mp4', 10);
    expect(args).toContain('scale=480:-2,scdet=t=10');
    expect(args).toEqual(expect.arrayContaining(['-an', '-sn', '-dn', '-f', 'null', '-']));
  });
});

describe('detectShots', () => {
  it('解析日志 → 过滤 → 写缓存；二次调用命中缓存不重复运行', async () => {
    const folder = await tempDir();
    let runs = 0;
    const run = async (
      _args: readonly string[],
      options?: FfmpegRunOptions,
    ): Promise<Result<FfmpegRunOutcome>> => {
      runs += 1;
      options?.onStderrLine?.('lavfi.scd.score: 5.0, lavfi.scd.time: 0.000'); // 起点 → 剔除
      options?.onStderrLine?.('lavfi.scd.score: 9.0, lavfi.scd.time: 2.000');
      options?.onStderrLine?.('lavfi.scd.score: 3.0, lavfi.scd.time: 2.100'); // 与 2.0s 过近 → 保高分
      options?.onStderrLine?.('lavfi.scd.score: 6.0, lavfi.scd.time: 5.000');
      options?.onStderrLine?.('lavfi.scd.score: 9.0, lavfi.scd.time: 10.000'); // 终点 → 剔除
      return ok({ lastProgress: null });
    };

    const media = makeMedia();
    const options = {
      projectFolder: folder,
      sourceAbsPath: path.join(folder, 'source.mp4'),
      media,
      threshold: 10,
      minShotMs: 500,
      run,
    };

    const first = await detectShots(options);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data).toEqual([
      { timeMs: 2000, score: 9 },
      { timeMs: 5000, score: 6 },
    ]);
    expect(runs).toBe(1);

    const cached = await readCachedCuts(folder, media.sha256, 10, 500);
    expect(cached).toEqual(first.data);

    const second = await detectShots(options);
    expect(second.ok && second.data.length === 2).toBe(true);
    expect(runs).toBe(1); // 命中缓存
  });

  it('不同阈值/最短镜头长度使用不同缓存，不命中', async () => {
    const folder = await tempDir();
    const run = async (
      _args: readonly string[],
      options?: FfmpegRunOptions,
    ): Promise<Result<FfmpegRunOutcome>> => {
      options?.onStderrLine?.('lavfi.scd.score: 9.0, lavfi.scd.time: 2.000');
      return ok({ lastProgress: null });
    };
    const media = makeMedia();
    await detectShots({ projectFolder: folder, sourceAbsPath: 'x', media, threshold: 10, minShotMs: 500, run });
    expect(await readCachedCuts(folder, media.sha256, 14, 500)).toBeNull();
    expect(await readCachedCuts(folder, media.sha256, 10, 1000)).toBeNull();
    expect(shotCacheName(media.sha256, 10, 500)).not.toBe(shotCacheName(media.sha256, 14, 500));
    expect(shotsDir(folder).endsWith(path.join('cache', 'shots'))).toBe(true);
  });

  it('运行失败返回错误且不写缓存', async () => {
    const folder = await tempDir();
    const run = async (): Promise<Result<FfmpegRunOutcome>> => err('FFMPEG_FAILED', '识别失败');
    const media = makeMedia();
    const result = await detectShots({
      projectFolder: folder,
      sourceAbsPath: 'x',
      media,
      threshold: 10,
      minShotMs: 500,
      run,
    });
    expect(result.ok).toBe(false);
    expect(await readCachedCuts(folder, media.sha256, 10, 500)).toBeNull();
  });

  it('取消返回 CANCELLED', async () => {
    const folder = await tempDir();
    const run = async (): Promise<Result<FfmpegRunOutcome>> => err('CANCELLED', '已取消');
    const result = await detectShots({
      projectFolder: folder,
      sourceAbsPath: 'x',
      media: makeMedia(),
      threshold: 10,
      minShotMs: 500,
      run,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CANCELLED');
    }
  });
});
const hasFfmpeg = resolveFfmpegPaths().ffmpeg !== null;
const execFileAsync = promisify(execFile);

describe('detectShots（真实 ffmpeg + scdet）', () => {
  it.skipIf(!hasFfmpeg)('识别合成视频（黑→白）的硬切并命中缓存', async () => {
    const folder = await tempDir();
    const ffmpeg = resolveFfmpegPaths().ffmpeg;
    if (ffmpeg === null) {
      return;
    }
    const source = path.join(folder, 'cut.mp4');
    await execFileAsync(ffmpeg.path, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x180:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'color=c=white:s=320x180:r=30:d=2',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[out]',
      '-map',
      '[out]',
      source,
    ]);

    const media = makeMedia({ durationMs: 4000, sha256: 'c'.repeat(64) });
    const result = await detectShots({
      projectFolder: folder,
      sourceAbsPath: source,
      media,
      threshold: 10,
      minShotMs: 500,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.length).toBeGreaterThanOrEqual(1);
    const first = result.data[0];
    expect(first?.timeMs).toBeGreaterThan(1500);
    expect(first?.timeMs).toBeLessThan(2500);
    expect(await readCachedCuts(folder, media.sha256, 10, 500)).toEqual(result.data);
  });
});