import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeFile, resolveFfmpegPaths } from '../src/main/services/ffmpeg';
import { baselineVideoPath } from './baseline-media';
import {
  COMPAT_DURATION_TOLERANCE_MS,
  COMPAT_FPS,
  COMPAT_LONG_EDGE,
  buildCompatibleArgs,
  createCompatibleCopy,
  scaleFilterFor,
} from '../src/main/services/compatible-copy-service';
import type { ProjectMedia } from '../src/shared/api-types';
import { ok } from '../src/shared/api-types';

/**
 * 兼容副本测试（规格 10.2）。
 * - 参数组装（固定 WebM/VP8/Opus、缩放、CFR、无音频 -an）为纯函数断言；
 * - 注入运行器：失败/时长不符 → 明确错误，且 .partial 被清理；
 * - 真实 ffmpeg：10s H.264/AAC（dev-assets 或 lavfi 小测试片）→ playback.webm，探测为 vp8/opus。
 */

const hasFfmpeg = resolveFfmpegPaths().ffmpeg !== null && resolveFfmpegPaths().ffprobe !== null;
/** dev-assets 或 lavfi 小测试片。都没有时跳过，不失败。 */
const BASELINE_VIDEO = baselineVideoPath();

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'laipian-compat-'));
  cleanups.push(dir);
  return dir;
}

function media(overrides: Partial<ProjectMedia> = {}): ProjectMedia {
  return {
    id: 'm',
    originalName: 'src.mp4',
    sourcePath: 'media/source.mp4',
    playbackPath: null,
    sha256: 'a'.repeat(64),
    sizeBytes: 409_731,
    durationMs: 10_000,
    width: 320,
    height: 180,
    videoCodec: 'h264',
    audioCodec: 'aac',
    avgFrameRate: { num: 30, den: 1 },
    isVfr: false,
    isHdr: false,
    ...overrides,
  };
}

describe('buildCompatibleArgs / scaleFilterFor（规格 10.2）', () => {
  it('固定 VP8 + 30fps CFR + yuv420p；有音频用 Opus，无音频用 -an', () => {
    const withAudio = buildCompatibleArgs('a.mp4', 'out.webm.partial', media());
    expect(withAudio).toContain('libvpx');
    expect(withAudio).toContain('libopus');
    expect(withAudio[withAudio.indexOf('-r') + 1]).toBe(String(COMPAT_FPS));
    expect(withAudio[withAudio.indexOf('-pix_fmt') + 1]).toBe('yuv420p');

    const noAudio = buildCompatibleArgs('a.mp4', 'out.webm.partial', media({ audioCodec: null }));
    expect(noAudio).toContain('-an');
    expect(noAudio).not.toContain('libopus');
  });

  it('长边超过 1280 才缩放，且不放大', () => {
    expect(scaleFilterFor(media({ width: 1920 }))).toContain(String(COMPAT_LONG_EDGE));
    expect(scaleFilterFor(media({ width: 640 }))).toContain('trunc(iw/2)');
  });
});

describe('createCompatibleCopy（规格 10.2 失败与清理）', () => {
  it('转码失败：返回原错误且清理 .partial', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'playback.webm');
    const result = await createCompatibleCopy({
      sourceAbsPath: path.join(dir, 'x.mp4'),
      targetPath: target,
      media: media(),
      run: async () => ({ ok: false, error: { code: 'FFMPEG_FAILED', message: '失败', retryable: true } }),
    });
    expect(result.ok).toBe(false);
    await expect(stat(`${target}.partial`)).rejects.toThrow();
  });

  it('时长差异超过容差判为转换失败', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'playback.webm');
    const result = await createCompatibleCopy({
      sourceAbsPath: path.join(dir, 'x.mp4'),
      targetPath: target,
      media: media(),
      run: async (_args) => {
        // 伪造产物文件供后续 stat 通过。
        const { writeFile } = await import('node:fs/promises');
        await writeFile(`${target}.partial`, Buffer.from([1, 2, 3]));
        return { ok: true, data: null };
      },
      probe: async () =>
        ok({
          durationMs: 10_000 + COMPAT_DURATION_TOLERANCE_MS + 500,
          width: 320,
          height: 180,
          videoCodec: 'vp8',
          audioCodec: 'opus',
          avgFrameRate: { num: 30, den: 1 },
          isVfr: false,
          isHdr: false,
          sizeBytes: 10,
        }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('COMPAT_DURATION_MISMATCH');
    await expect(stat(`${target}.partial`)).rejects.toThrow();
  });

  it.skipIf(!hasFfmpeg || BASELINE_VIDEO === null)('真实 ffmpeg：生成可播 WebM（VP8/Opus，时长≈10s）', async () => {
    const source = BASELINE_VIDEO;
    if (source === null) return;
    const dir = await tempDir();
    const target = path.join(dir, 'playback.webm');
    const result = await createCompatibleCopy({
      sourceAbsPath: source,
      targetPath: target,
      media: media(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = await stat(target);
    expect(info.size).toBeGreaterThan(0);
    const probed = await probeFile(target);
    expect(probed.ok).toBe(true);
    if (probed.ok) {
      expect(probed.data.videoCodec).toBe('vp8');
      expect(probed.data.audioCodec).toBe('opus');
      expect(Math.abs(probed.data.durationMs - 10_000)).toBeLessThanOrEqual(COMPAT_DURATION_TOLERANCE_MS);
    }
    // 无 .partial 残留。
    await expect(stat(`${target}.partial`)).rejects.toThrow();
    expect((await readFile(target)).length).toBeGreaterThan(0);
  }, 120_000);
});