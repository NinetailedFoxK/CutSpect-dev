import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFfmpegPaths } from '../src/main/services/ffmpeg';
import { detectShotsRange, shotDetectRangeArgs } from '../src/main/services/shot-detect-service';

/**
 * 局部（选中区域）硬切识别：使用合成真实视频验证“局部时间 → 全局时间”的偏移转换。
 *
 * 合成分段明暗视频（黑 0—1s、白 1—2s、黑 2—3s、白 3—4s → 硬切点在 1.0s、2.0s、3.0s）。
 * 关键断言：对 [1000, 3000) 范围检测，切点应回到全局 ~2000ms，而不是局部 ~1000ms，
 * 从而证明 -ss 输入定位后 scdet 报告的是相对选区的时间且转换正确。
 */

const execFileAsync = promisify(execFile);
const paths = resolveFfmpegPaths();
const ffmpegPath = paths.ffmpeg?.path ?? null;

let workDir = '';
let videoPath = '';

async function buildCutVideo(dir: string): Promise<string> {
  const out = path.join(dir, 'cuts.mp4');
  const color = (c: string): string[] => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x240:d=1:r=30`];
  await execFileAsync(ffmpegPath!, [
    '-y',
    ...color('black'),
    ...color('white'),
    ...color('black'),
    ...color('white'),
    '-filter_complex',
    '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0',
    '-pix_fmt',
    'yuv420p',
    out,
  ]);
  return out;
}

const describeReal = ffmpegPath === null ? describe.skip : describe;

describe('shotDetectRangeArgs（纯参数，不依赖 ffmpeg）', () => {
  it('使用输入定位 -ss（置于 -i 前）+ -t 限制时长，且保留 scdet', () => {
    const args = shotDetectRangeArgs('/tmp/x.mp4', 10, 1500, 4000);
    expect(args).toEqual([
      '-hide_banner',
      '-nostats',
      '-ss',
      '1.500',
      '-i',
      '/tmp/x.mp4',
      '-t',
      '2.500',
      '-map',
      '0:v:0',
      '-vf',
      'scale=480:-2,scdet=t=10',
      '-an',
      '-sn',
      '-dn',
      '-f',
      'null',
      '-',
    ]);
    // -ss 必须在 -i 之前（输入定位，快速但准确），而不是输出定位。
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
  });
});

describeReal('detectShotsRange（真实 ffmpeg 偏移验证）', () => {
  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'laipian-range-'));
    videoPath = await buildCutVideo(workDir);
  }, 60_000);

  afterAll(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('只分析选中区域：[1000,3000) 内的切点回到全局 ~2000ms', async () => {
    const result = await detectShotsRange({
      sourceAbsPath: videoPath,
      threshold: 10,
      minShotMs: 300,
      inMs: 1000,
      outMs: 3000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const times = result.data.map((c) => c.timeMs);
    // 若偏移处理错误（把局部时间当全局），这里会得到 ~1000ms，从而断言失败。
    expect(times.some((t) => Math.abs(t - 2000) < 200)).toBe(true);
    expect(times.every((t) => t > 1000 && t < 3000)).toBe(true);
  }, 30_000);

  it('选区外的切点不会出现：范围 [2100,3000) 无内部硬切', async () => {
    const result = await detectShotsRange({
      sourceAbsPath: videoPath,
      threshold: 10,
      minShotMs: 300,
      inMs: 2100,
      outMs: 3000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const internal = result.data.filter((c) => c.timeMs > 2100 && c.timeMs < 3000);
    expect(internal).toHaveLength(0);
  }, 30_000);

  it('跨选区时长：范围 [0,3000) 检出两处硬切（≈1000、≈2000）', async () => {
    const result = await detectShotsRange({
      sourceAbsPath: videoPath,
      threshold: 10,
      minShotMs: 300,
      inMs: 0,
      outMs: 3000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const times = result.data.map((c) => c.timeMs);
    expect(times.some((t) => Math.abs(t - 1000) < 200)).toBe(true);
    expect(times.some((t) => Math.abs(t - 2000) < 200)).toBe(true);
    // 选区终点 3000 处的硬切不算内部切点。
    expect(times.every((t) => t > 0 && t < 3000)).toBe(true);
  }, 30_000);
});