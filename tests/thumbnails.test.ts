import { existsSync } from 'node:fs';
import { readFile, readdir, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveFfmpegPaths } from '../src/main/services/ffmpeg';
import {
  MAX_THUMBS,
  THUMB_HEIGHT,
  THUMB_WIDTH,
  coverPath,
  generateThumbnails,
  listThumbnailEntries,
  sampleTimes,
  thumbsDir,
} from '../src/main/services/thumbnail-service';

/**
 * 缩略图/封面生成测试（规格 10.3）。
 * - sampleTimes 纯函数断言；
 * - 注入失败运行器 → THUMBNAIL_FAILED（确定性，不依赖 FFmpeg）；
 * - 真实 ffmpeg 抽帧（有 ffmpeg 时）：生成 ≥1 张缩略图与封面，缓存命中。
 */

const hasFfmpeg = resolveFfmpegPaths().ffmpeg !== null;
const DEV_VIDEO = fileURLToPath(new URL('../dev-assets/dev-test.mp4', import.meta.url));
/** 素材存在才可跑真实素材测试（dev-assets 被 .gitignore 排除，CI / 新机器可能没有）。 */
const hasDevVideo = existsSync(DEV_VIDEO);

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'laipian-thumb-'));
  cleanups.push(dir);
  return dir;
}

describe('sampleTimes（规格 10.3）', () => {
  it('短视频至少含首帧；间隔 ≥ 1000ms；不超过 120 张', () => {
    expect(sampleTimes(500)).toEqual([0]);
    const t10 = sampleTimes(10_000);
    expect(t10[0]).toBe(0);
    const gaps = t10.slice(1).map((t, i) => t - (t10[i] ?? 0));
    expect(gaps.every((g) => g >= 1000)).toBe(true);

    const long = sampleTimes(2 * 60 * 60 * 1000); // 2 小时
    expect(long.length).toBeLessThanOrEqual(MAX_THUMBS);
  });
});

describe('generateThumbnails（规格 10.3 / 10.4）', () => {
  it('运行器全部失败 → THUMBNAIL_FAILED（不伪造成功）', async () => {
    const folder = await tempDir();
    const result = await generateThumbnails({
      sourceAbsPath: path.join(folder, 'nope.mp4'),
      projectFolder: folder,
      durationMs: 10_000,
      sha256: 'a'.repeat(64),
      run: async () => ({ ok: false, error: { code: 'FFMPEG_FAILED', message: '失败', retryable: false } }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('THUMBNAIL_FAILED');
  });

  it.skipIf(!hasFfmpeg || !hasDevVideo)('真实 ffmpeg：生成缩略图与封面，二次调用命中缓存', async () => {
    const folder = await tempDir();
    await mkdir(thumbsDir(folder), { recursive: true });
    const sha = 'b'.repeat(64);

    const first = await generateThumbnails({
      sourceAbsPath: DEV_VIDEO,
      projectFolder: folder,
      durationMs: 10_000,
      sha256: sha,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.generated).toBeGreaterThanOrEqual(1);
    expect(first.data.cached).toBe(false);

    // 封面存在且非空。
    const coverBytes = await readFile(coverPath(folder));
    expect(coverBytes.length).toBeGreaterThan(0);
    // 缩略图目录含至少一张 jpg，尺寸符合 320×180（时间线放大后仍清晰，避免低分辨率拉伸）。
    const names = await readdir(thumbsDir(folder));
    const jpgs = names.filter((n) => n.startsWith('thumb-') && n.endsWith('.jpg'));
    expect(jpgs.length).toBeGreaterThanOrEqual(1);
    expect(THUMB_WIDTH).toBe(320);
    expect(THUMB_HEIGHT).toBe(180);

    // 第二次：缓存命中，不重复生成。
    const second = await generateThumbnails({
      sourceAbsPath: DEV_VIDEO,
      projectFolder: folder,
      durationMs: 10_000,
      sha256: sha,
    });
    expect(second.ok && second.data.cached).toBe(true);

    // 换 SHA（素材变化）→ 重建。
    const third = await generateThumbnails({
      sourceAbsPath: DEV_VIDEO,
      projectFolder: folder,
      durationMs: 10_000,
      sha256: 'c'.repeat(64),
    });
    expect(third.ok && third.data.cached === false).toBe(true);
  });
});
describe('listThumbnailEntries（规格 4.4 时间线帧带）', () => {
  it('文件名序号映射到采样时间；越界序号跳过；按时间升序返回', async () => {
    const folder = await tempDir();
    const dir = thumbsDir(folder);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'thumb-000.jpg'), Buffer.from([0xff]));
    await writeFile(path.join(dir, 'thumb-002.jpg'), Buffer.from([0xff]));
    await writeFile(path.join(dir, 'thumb-999.jpg'), Buffer.from([0xff])); // 越界序号 → 跳过
    await writeFile(path.join(dir, 'cover.jpg'), Buffer.from([0xff])); // 非缩略图 → 忽略

    const times = sampleTimes(10_000);
    const entries = await listThumbnailEntries(folder, 10_000);
    expect(entries.map((e) => e.name)).toEqual(['thumb-000.jpg', 'thumb-002.jpg']);
    expect(entries[0]?.timeMs).toBe(times[0]);
    expect(entries[1]?.timeMs).toBe(times[2]);
  });

  it('无缓存目录返回空数组（不抛错）', async () => {
    const folder = await tempDir();
    expect(await listThumbnailEntries(folder, 10_000)).toEqual([]);
  });
});