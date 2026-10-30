/**
 * 把一条本地视频登记成新建项目用的选择令牌，并附带弹窗预览需要的元信息。
 * 应用内选择器与系统「打开方式」共用，避免两套探测逻辑。
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { VideoPickResult } from '../shared/api-types';
import { registerSelection } from './file-selection';
import { probeFile } from './services/ffmpeg';

export async function describeVideoSelection(absPath: string): Promise<VideoPickResult> {
  const token = registerSelection('video-file', [absPath]);
  let sizeBytes: number | null = null;
  try {
    sizeBytes = (await stat(absPath)).size;
  } catch {
    sizeBytes = null;
  }
  let durationMs: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  const probed = await probeFile(absPath);
  if (probed.ok) {
    durationMs = probed.data.durationMs;
    width = probed.data.width;
    height = probed.data.height;
  }
  return {
    token,
    fileName: path.basename(absPath),
    sizeBytes,
    durationMs,
    width,
    height,
  };
}
