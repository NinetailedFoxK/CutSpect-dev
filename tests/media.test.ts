import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  checkMediaPolicy,
  copyWithHash,
  estimateSpaceFor,
} from '../src/main/services/media-service';
import type { ProbeResult } from '../src/main/services/ffmpeg';
import {
  detectHdr,
  detectVfr,
  parseFfprobeJson,
  parseRational,
} from '../src/main/services/ffmpeg';
import { MEDIA_ERROR_CODES, MediaServiceError } from '../src/main/services/errors';

/**
 * 媒体服务纯函数单测：
 * - parseFfprobeJson：真实 ffprobe JSON fixture（由 ffmpeg 实际生成导出）。
 * - checkMediaPolicy：基线 / 超规格 / 容量边界（规格 10.1）。
 * - copyWithHash：流式复制 + SHA-256 一致性、取消清理（规格 9.2 / 10.2）。
 * - estimateSpaceFor：磁盘空间估算（规格 10.4）。
 */

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8') as string,
  );
}

function baseProbe(overrides: Partial<ProbeResult>): ProbeResult {
  return {
    durationMs: 180_000,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    audioCodec: 'aac',
    avgFrameRate: { num: 30, den: 1 },
    isVfr: false,
    isHdr: false,
    sizeBytes: 12_345_678,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */

describe('parseFfprobeJson（真实 ffprobe fixture）', () => {
  it('横屏 H.264/AAC：全部字段正确', () => {
    const result = parseFfprobeJson(loadFixture('fixture-h264-aac.json'));
    // fixture 由 `ffmpeg testsrc2 640x360@30 + sine` 生成，时长 3s。
    expect(result.durationMs).toBe(3000);
    expect(result.width).toBe(640);
    expect(result.height).toBe(360);
    expect(result.videoCodec).toBe('h264');
    expect(result.audioCodec).toBe('aac');
    expect(result.avgFrameRate).toEqual({ num: 30, den: 1 });
    expect(result.isVfr).toBe(false); // nb_frames 90 == 3s × 30fps
    expect(result.isHdr).toBe(false); // yuv420p 8bit，无 bt2020/HLG/PQ 标记
    expect(result.sizeBytes).toBe(329_517);
  });

  it('无音频轨：audioCodec 为 null，不做假音轨', () => {
    const result = parseFfprobeJson(loadFixture('fixture-no-audio.json'));
    expect(result.audioCodec).toBeNull();
    expect(result.videoCodec).toBe('h264');
    expect(result.durationMs).toBe(2000);
    expect(result.width).toBe(640);
  });

  it('竖屏 360x640：宽高按视频流原样返回', () => {
    const result = parseFfprobeJson(loadFixture('fixture-portrait.json'));
    expect(result.width).toBe(360);
    expect(result.height).toBe(640);
    expect(result.audioCodec).toBe('aac');
  });

  it('无视频轨：抛 NO_VIDEO_TRACK（规格 15"未找到可用视频轨"）', () => {
    expect(() => parseFfprobeJson(loadFixture('fixture-no-video.json'))).toThrowError(
      expect.objectContaining({ code: MEDIA_ERROR_CODES.NO_VIDEO_TRACK }),
    );
    try {
      parseFfprobeJson(loadFixture('fixture-no-video.json'));
    } catch (error) {
      expect(error).toBeInstanceOf(MediaServiceError);
      expect((error as MediaServiceError).message).toContain('未找到可用视频轨');
    }
  });

  it('空 streams / 非法 JSON：同样判定无视频轨', () => {
    expect(() => parseFfprobeJson({ streams: [] })).toThrowError(
      expect.objectContaining({ code: 'NO_VIDEO_TRACK' }),
    );
    expect(() => parseFfprobeJson({})).toThrowError(
      expect.objectContaining({ code: 'NO_VIDEO_TRACK' }),
    );
  });

  it('时长回退链：format.duration 缺失时用视频流 duration', () => {
    const json = loadFixture('fixture-h264-aac.json') as { streams: unknown[]; format: Record<string, string> };
    delete json.format.duration;
    const result = parseFfprobeJson(json);
    expect(result.durationMs).toBe(3000);
  });

  it('时长最后回退：nb_frames ÷ avgFrameRate 估算', () => {
    const json = loadFixture('fixture-no-audio.json') as { streams: Array<Record<string, unknown>>; format: Record<string, string> };
    delete json.format.duration;
    for (const stream of json.streams) {
      delete stream.duration;
    }
    const result = parseFfprobeJson(json);
    expect(result.durationMs).toBe(2000); // 60 帧 ÷ 30fps
  });

  it('avg_frame_rate 为 0/0 时回退 r_frame_rate', () => {
    const json = loadFixture('fixture-h264-aac.json') as { streams: Array<Record<string, unknown>> };
    const video = json.streams.find((s) => s.codec_type === 'video');
    if (video) {
      video.avg_frame_rate = '0/0';
    }
    const result = parseFfprobeJson(json);
    expect(result.avgFrameRate).toEqual({ num: 30, den: 1 });
  });

  it('帧率完全不可解析时抛 PROBE_INCOMPLETE', () => {
    const json = loadFixture('fixture-h264-aac.json') as { streams: Array<Record<string, unknown>> };
    const video = json.streams.find((s) => s.codec_type === 'video');
    if (video) {
      video.avg_frame_rate = '0/0';
      video.r_frame_rate = '0/0';
    }
    expect(() => parseFfprobeJson(json)).toThrowError(
      expect.objectContaining({ code: 'PROBE_INCOMPLETE' }),
    );
  });
});

describe('parseRational', () => {
  it('标准分数、纯整数与 NTSC 帧率', () => {
    expect(parseRational('30/1')).toEqual({ num: 30, den: 1 });
    expect(parseRational('30000/1001')).toEqual({ num: 30000, den: 1001 });
    expect(parseRational('25')).toEqual({ num: 25000, den: 1000 });
  });

  it('0/0、负数、垃圾格式返回 null', () => {
    expect(parseRational('0/0')).toBeNull();
    expect(parseRational('-30/1')).toBeNull();
    expect(parseRational('abc')).toBeNull();
    expect(parseRational(30)).toBeNull();
    expect(parseRational('30/0')).toBeNull();
  });
});

describe('detectHdr（规格 10.1：HDR 检测）', () => {
  it('10bit 像素格式 / PQ / HLG / BT.2020 判 HDR', () => {
    expect(detectHdr({ pix_fmt: 'yuv420p10le' })).toBe(true);
    expect(detectHdr({ pix_fmt: 'p010le' })).toBe(true);
    expect(detectHdr({ color_transfer: 'smpte2084' })).toBe(true);
    expect(detectHdr({ color_transfer: 'arib-std-b67' })).toBe(true);
    expect(detectHdr({ color_primaries: 'bt2020nc' })).toBe(true);
    expect(detectHdr({ color_space: 'bt2020nc' })).toBe(true);
  });

  it('8bit SDR 常见组合不误判', () => {
    expect(detectHdr({ pix_fmt: 'yuv420p', color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709' })).toBe(false);
    expect(detectHdr({ pix_fmt: 'yuvj420p' })).toBe(false);
    expect(detectHdr({})).toBe(false);
  });
});

describe('detectVfr（规格 10.2：VFR 估算）', () => {
  it('nb_frames 与 duration×fps 偏差 ≤5% 判 CFR', () => {
    expect(detectVfr({ nb_frames: '90', r_frame_rate: '30/1' }, 3, { num: 30, den: 1 })).toBe(false);
    expect(detectVfr({ nb_frames: '91', r_frame_rate: '30/1' }, 3, { num: 30, den: 1 })).toBe(false);
  });

  it('nb_frames 明显多于推算值判 VFR', () => {
    expect(detectVfr({ nb_frames: '120', r_frame_rate: '30/1' }, 3, { num: 30, den: 1 })).toBe(true);
  });

  it('r_frame_rate 与 avg 差异大判 VFR；信息不足时保守 false', () => {
    expect(detectVfr({ r_frame_rate: '60/1' }, 3, { num: 30, den: 1 })).toBe(true);
    expect(detectVfr({}, 3, { num: 30, den: 1 })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('checkMediaPolicy（规格 10.1）', () => {
  it('1080p30 H.264/AAC SDR → ok', () => {
    expect(checkMediaPolicy(baseProbe({}))).toBe('ok');
  });

  it('1080p29.97（30000/1001）不算超帧率', () => {
    expect(checkMediaPolicy(baseProbe({ avgFrameRate: { num: 30000, den: 1001 } }))).toBe('ok');
  });

  it('无音频轨 → ok', () => {
    expect(checkMediaPolicy(baseProbe({ audioCodec: null }))).toBe('ok');
  });

  it('4K → needs-compatible-copy', () => {
    expect(checkMediaPolicy(baseProbe({ width: 3840, height: 2160 }))).toBe('needs-compatible-copy');
  });

  it('竖屏 1080x1920 按字面超基线 → needs-compatible-copy', () => {
    expect(checkMediaPolicy(baseProbe({ width: 1080, height: 1920 }))).toBe('needs-compatible-copy');
  });

  it('HDR → needs-compatible-copy', () => {
    expect(checkMediaPolicy(baseProbe({ isHdr: true }))).toBe('needs-compatible-copy');
  });

  it('>30fps → needs-compatible-copy', () => {
    expect(checkMediaPolicy(baseProbe({ avgFrameRate: { num: 60000, den: 1001 } }))).toBe('needs-compatible-copy');
    expect(checkMediaPolicy(baseProbe({ avgFrameRate: { num: 60, den: 1 } }))).toBe('needs-compatible-copy');
  });

  it('VFR → needs-compatible-copy', () => {
    expect(checkMediaPolicy(baseProbe({ isVfr: true }))).toBe('needs-compatible-copy');
  });

  it('非基线视频/音频编码 → needs-compatible-copy', () => {
    expect(checkMediaPolicy(baseProbe({ videoCodec: 'hevc' }))).toBe('needs-compatible-copy');
    expect(checkMediaPolicy(baseProbe({ audioCodec: 'ac3' }))).toBe('needs-compatible-copy');
  });

  it('VP8/Opus（兼容副本格式本身）可直接播放', () => {
    expect(checkMediaPolicy(baseProbe({ videoCodec: 'vp8', audioCodec: 'opus' }))).toBe('ok');
  });

  it('超出容量基线（>20GB 或 >2h）→ rejected（规格 10.1 产品边界）', () => {
    expect(checkMediaPolicy(baseProbe({ sizeBytes: 20 * 1024 ** 3 + 1 }))).toBe('rejected');
    expect(checkMediaPolicy(baseProbe({ durationMs: 2 * 60 * 60 * 1000 + 1 }))).toBe('rejected');
    expect(checkMediaPolicy(baseProbe({ sizeBytes: 20 * 1024 ** 3, durationMs: 2 * 60 * 60 * 1000 }))).toBe('ok');
  });
});

/* ------------------------------------------------------------------ */

describe('copyWithHash（规格 9.2：流式复制 + SHA-256）', () => {
  let workDir: string;

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = '';
    }
  });

  async function makeWorkDir(): Promise<string> {
    workDir = await mkdtemp(path.join(tmpdir(), 'laipian-media-test-'));
    return workDir;
  }

  function expectedSha256(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  it('跨多个 64KB 块：sha256 与独立计算一致，字节完全相同', async () => {
    const dir = await makeWorkDir();
    const src = path.join(dir, 'source.bin');
    const dest = path.join(dir, 'copy.bin');
    // 3×64KB + 非整块尾巴，覆盖块边界路径。
    const data = Buffer.concat([randomBytes(64 * 1024 * 3), randomBytes(12_345)]);
    await writeFile(src, data);

    const progressEvents: Array<{ completedBytes: number; totalBytes: number }> = [];
    const result = await copyWithHash(src, dest, {
      onProgress: (p) => progressEvents.push({ ...p }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.bytesCopied).toBe(data.length);
    expect(result.data.sha256).toBe(expectedSha256(data));
    expect(await readFile(dest)).toEqual(data);

    // 进度单调不减，且终态 completed == total。
    const completed = progressEvents.map((p) => p.completedBytes);
    expect(completed).toEqual([...completed].sort((a, b) => a - b));
    expect(progressEvents.at(-1)).toEqual({ completedBytes: data.length, totalBytes: data.length });
  });

  it('取消：返回 CANCELLED，删除半成品，源文件完好', async () => {
    const dir = await makeWorkDir();
    const src = path.join(dir, 'source.bin');
    const dest = path.join(dir, 'copy.bin');
    // 64MB：本地 SSD 复制耗时超过进度上报周期（200ms），确保取消命中中途。
    // 用 1MB 种子平铺生成，避免 CSPRNG 生成 64MB 的额外耗时。
    const seed = randomBytes(1024 * 1024);
    const data = Buffer.alloc(64 * 1024 * 1024);
    for (let i = 0; i < 64; i++) {
      seed.copy(data, i * seed.length);
    }
    const shaBefore = expectedSha256(data);
    await writeFile(src, data);

    const controller = new AbortController();
    let cancelledMidway = false;
    const result = await copyWithHash(src, dest, {
      cancelToken: controller.signal,
      onProgress: (p) => {
        if (p.completedBytes > 0 && p.completedBytes < p.totalBytes && !controller.signal.aborted) {
          cancelledMidway = true;
          controller.abort();
        }
      },
    });

    expect(cancelledMidway).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('CANCELLED');
    // 半成品已清理，不留下可被误当完整副本的文件（规格 10.2）。
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' });
    // 源文件未受影响：用独立 SHA-256 校验（避免大 Buffer 深比较的开销）。
    const srcAfter = await readFile(src);
    expect(createHash('sha256').update(srcAfter).digest('hex')).toBe(shaBefore);
  }, 30_000);

  it('源文件不存在：返回 IO 错误', async () => {
    const dir = await makeWorkDir();
    const result = await copyWithHash(path.join(dir, 'no-such.bin'), path.join(dir, 'dest.bin'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('IO');
    }
  });

  it('源是目录：拒绝复制', async () => {
    const dir = await makeWorkDir();
    const result = await copyWithHash(dir, path.join(dir, 'dest.bin'));
    expect(result.ok).toBe(false);
  });
});

describe('estimateSpaceFor（规格 10.4）', () => {
  it('临时目录：可用量、必需量（含 64MB 余量）与判定一致', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'laipian-space-'));
    try {
      const result = await estimateSpaceFor(1_000_000_000, dir);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.data.availableBytes).toBeGreaterThan(0);
      expect(result.data.requiredBytes).toBe(1_000_000_000 + 64 * 1024 * 1024);
      expect(result.data.sufficient).toBe(result.data.availableBytes >= result.data.requiredBytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('请求超大空间 → sufficient false（用于"磁盘空间不足"提示）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'laipian-space-'));
    try {
      const result = await estimateSpaceFor(2 ** 60, dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.sufficient).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('目标目录不存在 → IO 错误', async () => {
    const result = await estimateSpaceFor(1, '/nonexistent-laipian-dir/xxx');
    expect(result.ok).toBe(false);
  });
});