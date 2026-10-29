import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** global-setup 生成的小测试片文件名（位于系统临时目录，不入库）。 */
export const GENERATED_BASELINE_NAME = 'baseline-h264-aac-10s.mp4';

/**
 * 真实媒体用例使用的视频：
 * 优先本机 dev-assets/dev-test.mp4；没有则用 lavfi 生成的 10 秒 H.264/AAC。
 * 两者都不存在时返回 null，调用方应 skip，而不是失败。
 */
export function baselineVideoPath(): string | null {
  const dev = path.resolve('dev-assets', 'dev-test.mp4');
  if (existsSync(dev)) {
    return dev;
  }
  const generated = path.join(tmpdir(), 'laipian-test-fixtures', GENERATED_BASELINE_NAME);
  return existsSync(generated) ? generated : null;
}
