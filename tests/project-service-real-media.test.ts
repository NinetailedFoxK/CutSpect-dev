import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveFfmpegPaths } from '../src/main/services/ffmpeg';
import { createProjectService } from '../src/main/services/project-service';
import { createTaskManager } from '../src/main/services/tasks';
import type { ProjectSnapshot } from '../src/shared/api-types';

/**
 * 真实媒体贯通测试（规格第 18 节“用真实媒体贯通功能”）。
 *
 * 与 project-service.test.ts 不同：本用例不注入桩探测，使用真实 ffprobe +
 * 真实流式复制 + 真实快照校验，验证 dev-assets/dev-test.mp4（10s H.264/AAC
 * 基线素材）能跑通“导入 → 落盘 → 重开”。
 *
 * 若本机没有 ffprobe（精简 CI 环境），整组跳过并如实标注未验证，
 * 不以桩数据冒充真实媒体验证。
 */

const hasFfprobe = resolveFfmpegPaths().ffprobe !== null;

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('等待超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function findFolder(destDir: string): Promise<string> {
  const names = await readdir(destDir);
  const folder = names.find((name) => !name.startsWith('.'));
  if (!folder) {
    throw new Error('未找到项目文件夹');
  }
  return path.join(destDir, folder);
}

describe.skipIf(!hasFfprobe)('真实媒体导入闭环（真实 ffprobe，规格 10.1 / 阶段 A）', () => {
  it('导入基线视频 → 真实探测信息 → 复制校验 → 重开可播放', async () => {
    const sourcePath = fileURLToPath(new URL('../dev-assets/dev-test.mp4', import.meta.url));
    const root = await mkdtemp(path.join(tmpdir(), 'laipian-real-'));
    cleanups.push(root);
    const destDir = path.join(root, 'projects');
    const userDataDir = path.join(root, 'userData');
    await mkdir(destDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });

    const services = createProjectService({
      userDataDir,
      tasks: createTaskManager(),
      // 不注入 probe：使用真实 ffprobe（probeFile）。
    });

    const created = await services.createProject({
      sourcePath,
      destinationDir: destDir,
      name: '真实素材测试',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    await waitForAsync(async () => (await services.openRecent(created.data.projectId)).ok);
    const opened = await services.openRecent(created.data.projectId);
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    // 真实 ffprobe 的元数据。
    const media = opened.data.snapshot.media;
    expect(Math.abs(media.durationMs - 10_000)).toBeLessThanOrEqual(100);
    expect(media.videoCodec).toBe('h264');
    expect(media.audioCodec).toBe('aac');
    expect(media.width).toBe(320);
    expect(media.height).toBe(180);
    expect(media.isHdr).toBe(false);
    expect(media.isVfr).toBe(false);

    // 复制副本的 SHA-256 与独立计算一致（真实流式复制）。
    const original = await readFile(sourcePath);
    const expectedSha = createHash('sha256').update(original).digest('hex');
    expect(media.sha256).toBe(expectedSha);

    // 重开：播放地址是协议 URL，快照整体通过校验（open 内部已校验）。
    expect(opened.data.status).toBe('ready');
    expect(opened.data.mediaUrl).toMatch(/^laipian-media:\/\//);

    // 磁盘落盘形态。
    const folder = await findFolder(destDir);
    const reparsed = JSON.parse(
      await readFile(path.join(folder, 'project.json'), 'utf8'),
    ) as ProjectSnapshot;
    expect(reparsed.id).toBe(created.data.projectId);
    expect(reparsed.media.durationMs).toBe(media.durationMs);
  });
});