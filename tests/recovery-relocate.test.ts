import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectService } from '../src/main/services/project-service';
import type { ProjectService } from '../src/main/services/project-service';
import { createTaskManager } from '../src/main/services/tasks';
import { ok } from '../src/shared/api-types';
import type { ProbeResult } from '../src/main/services/ffmpeg';
import type { ProjectSnapshot } from '../src/shared/api-types';

/**
 * 恢复快照（F02）与素材重定位（G01）测试（规格 8.4 / 9.3）。
 * 使用真实临时目录 + 桩探测；真实文件哈希校验。
 */

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

function stubProbe(): (absPath: string) => Promise<ReturnType<typeof ok<ProbeResult>>> {
  const value: ProbeResult = {
    durationMs: 60_000,
    width: 320,
    height: 180,
    videoCodec: 'h264',
    audioCodec: 'aac',
    avgFrameRate: { num: 30, den: 1 },
    isVfr: false,
    isHdr: false,
    sizeBytes: 2048,
  };
  return async () => ok(value);
}

interface Harness {
  root: string;
  destDir: string;
  sourcePath: string;
  services: ProjectService;
}

async function setup(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'laipian-f02-'));
  cleanups.push(root);
  const destDir = path.join(root, 'projects');
  const userDataDir = path.join(root, 'userData');
  await mkdir(destDir, { recursive: true });
  await mkdir(userDataDir, { recursive: true });
  const sourcePath = path.join(root, 'clip.mp4');
  await writeFile(sourcePath, Buffer.alloc(2048, 7));
  const services = createProjectService({
    userDataDir,
    tasks: createTaskManager(),
    probe: stubProbe(),
    backupMinIntervalMs: 0,
  });
  return { root, destDir, sourcePath, services };
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function findProjectFolder(destDir: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(destDir);
  const folder = names.find((name) => !name.startsWith('.'));
  if (!folder) throw new Error('未找到项目文件夹');
  return path.join(destDir, folder);
}

async function createReady(harness: Harness): Promise<string> {
  const created = await harness.services.createProject({
    sourcePath: harness.sourcePath,
    destinationDir: harness.destDir,
    name: '恢复测试',
  });
  if (!created.ok) throw new Error('createProject 失败');
  const projectId = created.data.projectId;
  await waitForAsync(async () => (await harness.services.openRecent(projectId)).ok);
  return projectId;
}

describe('恢复快照（规格 8.4）', () => {
  it('保存过程中留下的更新 pending 会被检测；可恢复到该版本并保留原版本为备份', async () => {
    const harness = await setup();
    const projectId = await createReady(harness);
    const folder = await findProjectFolder(harness.destDir);

    // 读取当前主文件快照，构造一个“更新的未提交快照”写入 recovery/。
    const mainSnapshot = JSON.parse(
      await readFile(path.join(folder, 'project.json'), 'utf8'),
    ) as ProjectSnapshot;
    const pending: ProjectSnapshot = {
      ...mainSnapshot,
      revision: mainSnapshot.revision + 5,
      name: '未提交的修改',
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    };
    const recoveryDir = path.join(folder, 'recovery');
    await mkdir(recoveryDir, { recursive: true });
    const pendingId = `pending-r${pending.revision}-test.json`;
    await writeFile(path.join(recoveryDir, pendingId), JSON.stringify(pending));

    // 重新打开：应检测到恢复快照。
    const opened = await harness.services.openRecent(projectId);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.data.recovery?.pendingId).toBe(pendingId);
    expect(opened.data.recovery?.revision).toBe(pending.revision);

    // 恢复：主文件更新为 pending，原版本保留为备份，pending 被删除。
    const restored = await harness.services.restoreRecovery({ projectId, pendingId });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.data.name).toBe('未提交的修改');
      expect(restored.data.revision).toBe(pending.revision);
    }
    const mainAfter = JSON.parse(
      await readFile(path.join(folder, 'project.json'), 'utf8'),
    ) as ProjectSnapshot;
    expect(mainAfter.name).toBe('未提交的修改');
    await expect(readFile(path.join(recoveryDir, pendingId), 'utf8')).rejects.toThrow();
    const backups = await harness.services.listBackups({ projectId });
    expect(backups.ok && backups.data.length > 0).toBe(true);
  });

  it('pending 不新于主文件时不再提示', async () => {
    const harness = await setup();
    const projectId = await createReady(harness);
    const folder = await findProjectFolder(harness.destDir);
    const mainSnapshot = JSON.parse(
      await readFile(path.join(folder, 'project.json'), 'utf8'),
    ) as ProjectSnapshot;
    const recoveryDir = path.join(folder, 'recovery');
    await mkdir(recoveryDir, { recursive: true });
    await writeFile(
      path.join(recoveryDir, `pending-r${mainSnapshot.revision}-old.json`),
      JSON.stringify(mainSnapshot),
    );
    const opened = await harness.services.openRecent(projectId);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.data.recovery).toBeNull();
    }
  });

  it('discardRecovery 删除未提交快照', async () => {
    const harness = await setup();
    const projectId = await createReady(harness);
    const folder = await findProjectFolder(harness.destDir);
    const mainSnapshot = JSON.parse(
      await readFile(path.join(folder, 'project.json'), 'utf8'),
    ) as ProjectSnapshot;
    const recoveryDir = path.join(folder, 'recovery');
    await mkdir(recoveryDir, { recursive: true });
    const pendingId = `pending-r${mainSnapshot.revision + 1}-x.json`;
    await writeFile(path.join(recoveryDir, pendingId), JSON.stringify({ ...mainSnapshot, revision: mainSnapshot.revision + 1 }));
    const discarded = await harness.services.discardRecovery({ projectId, pendingId });
    expect(discarded.ok).toBe(true);
    await expect(readFile(path.join(recoveryDir, pendingId), 'utf8')).rejects.toThrow();
  });
});

describe('素材重新定位（规格 9.3）', () => {
  it('拒绝 SHA-256 不一致的文件；接受同一素材并恢复播放', async () => {
    const harness = await setup();
    const projectId = await createReady(harness);
    const folder = await findProjectFolder(harness.destDir);
    const mediaPath = path.join(folder, 'media', 'source.mp4');

    // 模拟素材丢失。
    await rm(mediaPath, { force: true });
    const missing = await harness.services.openRecent(projectId);
    expect(missing.ok && missing.data.status).toBe('missing');

    // 不同内容 → 拒绝。
    const wrongPath = path.join(harness.root, 'wrong.mp4');
    await writeFile(wrongPath, Buffer.alloc(2048, 9));
    const mismatch = await harness.services.relocateSource({ projectId, candidatePath: wrongPath });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe('MEDIA_MISMATCH');

    // 同一内容（源文件仍是原字节）→ 接受。
    const relocated = await harness.services.relocateSource({ projectId, candidatePath: harness.sourcePath });
    expect(relocated.ok).toBe(true);
    const restoredBytes = await readFile(mediaPath);
    const expectedSha = createHash('sha256').update(await readFile(harness.sourcePath)).digest('hex');
    expect(createHash('sha256').update(restoredBytes).digest('hex')).toBe(expectedSha);

    const reopened = await harness.services.openRecent(projectId);
    expect(reopened.ok).toBe(true);
    if (reopened.ok) {
      expect(reopened.data.status).toBe('ready');
      expect(reopened.data.mediaUrl).toMatch(/^laipian-media:\/\//);
    }
  });
});