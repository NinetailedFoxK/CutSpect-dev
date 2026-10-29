import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveFfmpegPaths } from '../src/main/services/ffmpeg';
import { GENERATED_BASELINE_NAME } from './baseline-media';

/**
 * 没有 dev-assets 时，用随包 ffmpeg 的 lavfi 生成一小段 H.264/AAC 测试片。
 * 文件写在系统临时目录，不入库。生成失败或没有 ffmpeg 时不抛错，对应用例会 skip。
 */
const execFileAsync = promisify(execFile);

export default async function setup(): Promise<void> {
  if (existsSync(path.resolve('dev-assets', 'dev-test.mp4'))) {
    return;
  }
  const ffmpeg = resolveFfmpegPaths().ffmpeg;
  if (ffmpeg === null) {
    return;
  }
  const dir = path.join(tmpdir(), 'laipian-test-fixtures');
  const out = path.join(dir, GENERATED_BASELINE_NAME);
  if (existsSync(out)) {
    return;
  }
  await mkdir(dir, { recursive: true });
  try {
    await execFileAsync(
      ffmpeg.path,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=30:duration=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=10',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-shortest',
        out,
      ],
      { timeout: 60_000 },
    );
  } catch (error) {
    console.warn(`[baseline] 跳过 lavfi 夹具：${error instanceof Error ? error.message : String(error)}`);
  }
}
