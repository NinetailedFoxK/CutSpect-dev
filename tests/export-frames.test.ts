import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { err, ok } from '../src/shared/api-types';
import type { ProjectMedia } from '../src/shared/api-types';
import { extractFrames } from '../src/main/services/export-frames';

/**
 * 导出代表帧抽取测试（规格 13 画面要求：单帧失败降级、缓存、取消）。
 * 全部用注入 ffmpeg 运行器，不依赖真实 FFmpeg。
 */

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'laipian-frames-'));
  cleanups.push(dir);
  return dir;
}

const MEDIA: ProjectMedia = {
  id: 'm',
  originalName: 'a.mp4',
  sourcePath: 'media/a.mp4',
  playbackPath: null,
  sha256: 'abc',
  sizeBytes: 1,
  durationMs: 10000,
  width: 1920,
  height: 1080,
  videoCodec: 'h264',
  audioCodec: 'aac',
  avgFrameRate: { num: 30, den: 1 },
  isVfr: false,
  isHdr: false,
};

/** 注入运行器：把最后一参数（输出路径）写出一段假 JPEG 字节。 */
function writingRunner(): { run: (args: readonly string[]) => Promise<ReturnType<typeof ok>>; calls: number } {
  const state = {
    calls: 0,
    async run(args: readonly string[]): Promise<ReturnType<typeof ok>> {
      state.calls++;
      const out = args[args.length - 1];
      if (out === undefined) throw new Error('missing out');
      await writeFile(out, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
      return ok(undefined);
    },
  };
  return state;
}

describe('extractFrames', () => {
  it('按请求抽取并返回 key → 路径', async () => {
    const dir = await tempDir();
    const runner = writingRunner();
    const result = await extractFrames({
      projectFolder: dir,
      sourceAbsPath: '/tmp/source.mp4',
      media: MEDIA,
      requests: [
        { key: 'shot:A1a', timeMs: 1000 },
        { key: 'shot:A1b', timeMs: 4000 },
      ],
      width: 960,
      run: runner.run,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.frames.get('shot:A1a')).toBeDefined();
      expect(result.data.frames.get('shot:A1b')).toBeDefined();
      expect(result.data.failures).toEqual([]);
    }
  });

  it('单帧失败不致命，其余继续并记录 failures', async () => {
    const dir = await tempDir();
    let calls = 0;
    const run = async (args: readonly string[]): Promise<ReturnType<typeof err>> => {
      calls++;
      if (args.includes('2.000')) {
        return err('FRAME_FAILED', 'decode failed');
      }
      const out = args[args.length - 1];
      if (out !== undefined) await writeFile(out, Buffer.from([0xff, 0xd8, 0xff]));
      return ok(undefined) as unknown as ReturnType<typeof err>;
    };
    const result = await extractFrames({
      projectFolder: dir,
      sourceAbsPath: '/tmp/s.mp4',
      media: MEDIA,
      requests: [
        { key: 'shot:a', timeMs: 1000 },
        { key: 'shot:b', timeMs: 2000 },
        { key: 'shot:c', timeMs: 3000 },
      ],
      width: 960,
      run,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.failures).toEqual(['shot:b']);
      expect(result.data.frames.size).toBe(2);
    }
    expect(calls).toBe(3);
  });

  it('缓存命中：相同 key 不重复调用 ffmpeg', async () => {
    const dir = await tempDir();
    const runner = writingRunner();
    const options = {
      projectFolder: dir,
      sourceAbsPath: '/tmp/s.mp4',
      media: MEDIA,
      requests: [{ key: 'shot:x', timeMs: 1000 }],
      width: 960,
      run: runner.run,
    };
    await extractFrames(options);
    const before = runner.calls;
    await extractFrames(options);
    expect(runner.calls).toBe(before);
  });

  it('取消返回 CANCELLED', async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    controller.abort();
    const runner = writingRunner();
    const result = await extractFrames({
      projectFolder: dir,
      sourceAbsPath: '/tmp/s.mp4',
      media: MEDIA,
      requests: [{ key: 'shot:x', timeMs: 1000 }],
      width: 960,
      run: runner.run,
      cancelSignal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CANCELLED');
  });

  it('写入的缓存文件可读（确认真实写盘）', async () => {
    const dir = await tempDir();
    const runner = writingRunner();
    const result = await extractFrames({
      projectFolder: dir,
      sourceAbsPath: '/tmp/s.mp4',
      media: MEDIA,
      requests: [{ key: 'shot:x', timeMs: 1000 }],
      width: 960,
      run: runner.run,
    });
    if (!result.ok) throw new Error('expected ok');
    const abs = result.data.frames.get('shot:x');
    expect(abs).toBeDefined();
    const bytes = await readFile(abs as string);
    expect(bytes[0]).toBe(0xff);
  });
});