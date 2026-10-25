import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectService, sanitizeFolderName } from '../src/main/services/project-service';
import type { ProjectService } from '../src/main/services/project-service';
import { createTaskManager } from '../src/main/services/tasks';
import { createInitialSnapshot } from '../src/shared/schema';
import { ok } from '../src/shared/api-types';
import type { ProbeResult } from '../src/main/services/ffmpeg';
import type { ProjectSnapshot, Result } from '../src/shared/api-types';

/**
 * 项目服务闭环测试（规格 8 / 9 / 11）。
 *
 * 用真实临时目录做真实文件操作（复制、原子写、锁、备份），只把 ffprobe
 * 替换为桩探测，从而在无 FFmpeg 环境下验证：
 * 创建→复制→探测→落盘→重开、revision 乐观锁、schema 拒绝坏数据、
 * 路径穿越拒绝、项目锁、备份保留、最近索引移除。
 */

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

const SIXTY_SECONDS = 60_000;

function stubProbe(): (absPath: string) => Promise<Result<ProbeResult>> {
  const value: ProbeResult = {
    durationMs: SIXTY_SECONDS,
    width: 1920,
    height: 1080,
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

async function setup(sourceFile?: string): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'laipian-svc-'));
  cleanups.push(root);
  const destDir = path.join(root, 'projects');
  const userDataDir = path.join(root, 'userData');
  await mkdir(destDir, { recursive: true });
  await mkdir(userDataDir, { recursive: true });
  const sourcePath = sourceFile ?? path.join(root, 'clip.mp4');
  if (sourceFile === undefined) {
    await writeFile(sourcePath, Buffer.alloc(2048, 7));
  }

  const services = createProjectService({
    userDataDir,
    tasks: createTaskManager(),
    probe: stubProbe(),
    backupMinIntervalMs: 0,
    now: () => new Date(),
  });
  return { root, destDir, sourcePath, services };
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('等待超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function findProjectFolder(destDir: string): Promise<string> {
  const names = await readdir(destDir);
  const folder = names.find((name) => !name.startsWith('.'));
  if (!folder) {
    throw new Error('未找到项目文件夹');
  }
  return path.join(destDir, folder);
}

async function createAndReady(harness: Harness, name = '测试项目'): Promise<string> {
  const created = await harness.services.createProject({
    sourcePath: harness.sourcePath,
    destinationDir: harness.destDir,
    name,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) {
    throw new Error('created 失败');
  }
  const projectId = created.data.projectId;
  await waitForAsync(async () => {
    const opened = await harness.services.openRecent(projectId);
    return opened.ok;
  });
  return projectId;
}

describe('createProject（规格 2.3 / 2.4 / 9.2）', () => {
  it('复制源视频、写入 project.json、登记最近列表；源文件不变', async () => {
    const harness = await setup();
    const projectId = await createAndReady(harness, '测试 项目:名/非法');
    const folder = await findProjectFolder(harness.destDir);

    // 磁盘结构（规格 11.1）
    const snapshotRaw = await readFile(path.join(folder, 'project.json'), 'utf8');
    const snapshot = JSON.parse(snapshotRaw) as ProjectSnapshot;
    expect(snapshot.id).toBe(projectId);
    expect(snapshot.media.sourcePath).toBe('media/source.mp4');

    // 副本字节与源文件一致，SHA-256 与独立计算一致。
    const copied = await readFile(path.join(folder, 'media', 'source.mp4'));
    const original = await readFile(harness.sourcePath);
    expect(copied.equals(original)).toBe(true);
    const expectedSha = createHash('sha256').update(original).digest('hex');
    expect(snapshot.media.sha256).toBe(expectedSha);

    // 源文件保持不变。
    expect((await readFile(harness.sourcePath)).length).toBe(2048);

    // 最近列表可打开，播放地址为协议 URL。
    const opened = await harness.services.openRecent(projectId);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.data.status).toBe('ready');
      expect(opened.data.mediaUrl).toMatch(/^laipian-media:\/\//);
      expect(opened.data.snapshot.media.durationMs).toBe(SIXTY_SECONDS);
    }

    // 目录名过滤非法字符且附加短 ID。
    expect(path.basename(folder)).not.toContain(':');
    expect(path.basename(folder)).not.toContain('/');
  });

  it('超出容量基线的素材被拒绝（不留下可打开项目）', async () => {
    const harness = await setup();
    const tasks = createTaskManager();
    const failures: string[] = [];
    tasks.subscribe((event) => {
      if (event.status === 'failed') {
        failures.push(event.message ?? '');
      }
    });
    const services = createProjectService({
      userDataDir: path.join(harness.root, 'userData2'),
      tasks,
      probe: async () =>
        ok({
          durationMs: 3 * 60 * 60 * 1000, // 3 小时 > 2 小时基线
          width: 1920,
          height: 1080,
          videoCodec: 'h264',
          audioCodec: 'aac',
          avgFrameRate: { num: 30, den: 1 },
          isVfr: false,
          isHdr: false,
          sizeBytes: 1000,
        }),
      backupMinIntervalMs: 0,
    });
    const created = await services.createProject({
      sourcePath: harness.sourcePath,
      destinationDir: harness.destDir,
      name: '超长视频',
    });
    expect(created.ok).toBe(true); // 快速返回 projectId，失败经任务事件上报
    if (!created.ok) {
      return;
    }
    // 等待探测任务失败（容量基线拒绝），再确认临时目录已清理。
    await waitForAsync(async () => failures.length > 0);
    await waitForAsync(async () => (await readdir(harness.destDir)).length === 0);
    const opened = await services.openRecent(created.data.projectId);
    expect(opened.ok).toBe(false);
    expect((await readdir(harness.destDir)).length).toBe(0);
  });
});

describe('openProjectFolder / 校验（规格 9.3 / F04）', () => {
  it('路径穿越的 project.json 被拒绝，原文件不被覆盖', async () => {
    const harness = await setup();
    const folder = path.join(harness.destDir, 'evil');
    await mkdir(path.join(folder, 'media'), { recursive: true });
    const snapshot = createInitialSnapshot({
      projectId: 'evil-1',
      name: '坏项目',
      media: {
        id: 'm',
        originalName: 'x.mp4',
        sourcePath: '../../etc/passwd',
        playbackPath: null,
        sha256: 'a'.repeat(64),
        sizeBytes: 10,
        durationMs: SIXTY_SECONDS,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: null,
        avgFrameRate: { num: 30, den: 1 },
        isVfr: false,
        isHdr: false,
      },
    });
    await writeFile(path.join(folder, 'project.json'), JSON.stringify(snapshot));

    const opened = await harness.services.openProjectFolder(folder);
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe('SCHEMA_INVALID');
    }
    // 原文件未被覆盖。
    const raw = await readFile(path.join(folder, 'project.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual(snapshot);
  });

  it('存活的跨进程锁 → PROJECT_LOCKED（规格 8.5）', async () => {
    const harness = await setup();
    const folder = path.join(harness.destDir, 'locked');
    await mkdir(path.join(folder, 'media'), { recursive: true });
    const snapshot = createInitialSnapshot({
      projectId: 'locked-1',
      name: '被占用',
      media: {
        id: 'm',
        originalName: 'x.mp4',
        sourcePath: 'media/source.mp4',
        playbackPath: null,
        sha256: 'a'.repeat(64),
        sizeBytes: 10,
        durationMs: SIXTY_SECONDS,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: null,
        avgFrameRate: { num: 30, den: 1 },
        isVfr: false,
        isHdr: false,
      },
    });
    await writeFile(path.join(folder, 'project.json'), JSON.stringify(snapshot));
    // pid 1 始终存活（macOS 非 root 下 kill(1,0) 抛 EPERM → 视为存活）。
    await writeFile(path.join(folder, '.lock'), JSON.stringify({ pid: 1, at: new Date().toISOString() }));

    const opened = await harness.services.openProjectFolder(folder);
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe('PROJECT_LOCKED');
    }
  });
});

describe('saveProject（规格 8.2 / 8.3 / 12.4）', () => {
  it('revision 乐观锁：递增成功，过期 revision 冲突', async () => {
    const harness = await setup();
    const projectId = await createAndReady(harness);
    const opened = await harness.services.openRecent(projectId);
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }
    const base = opened.data.snapshot;

    const first = await harness.services.saveProject({
      projectId,
      expectedRevision: base.revision,
      snapshot: { ...base, view: { ...base.view, playheadMs: 1234 } },
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.data.revision).toBe(base.revision + 1);
    }

    // 用过期 revision 再存 → 冲突（停止覆盖）。
    const stale = await harness.services.saveProject({
      projectId,
      expectedRevision: base.revision,
      snapshot: base,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('REVISION_CONFLICT');
    }
  });

  it('坏数据被 schema 拒绝，磁盘内容不变', async () => {
    const harness = await setup();
    const projectId = await createAndReady(harness);
    const folder = await findProjectFolder(harness.destDir);
    const before = await readFile(path.join(folder, 'project.json'), 'utf8');

    const opened = await harness.services.openRecent(projectId);
    if (!opened.ok) {
      throw new Error('无法打开');
    }
    const bad: ProjectSnapshot = JSON.parse(JSON.stringify(opened.data.snapshot)) as ProjectSnapshot;
    const node = bad.curve.nodes[0];
    if (node) {
      node.value = 200; // 越界
    }
    const result = await harness.services.saveProject({
      projectId,
      expectedRevision: opened.data.snapshot.revision,
      snapshot: bad,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SCHEMA_INVALID');
    }
    expect(await readFile(path.join(folder, 'project.json'), 'utf8')).toBe(before);
  });

  it('多次保存触发备份且仅保留最近 5 份', async () => {
    const harness = await setup();
    const projectId = await createAndReady(harness);
    const opened = await harness.services.openRecent(projectId);
    if (!opened.ok) {
      throw new Error('无法打开');
    }
    let revision = opened.data.snapshot.revision;
    for (let i = 0; i < 7; i++) {
      const saved = await harness.services.saveProject({
        projectId,
        expectedRevision: revision,
        snapshot: { ...opened.data.snapshot, view: { ...opened.data.snapshot.view, playheadMs: i * 100 } },
      });
      expect(saved.ok).toBe(true);
      if (saved.ok) {
        revision = saved.data.revision;
      }
    }
    const backups = await harness.services.listBackups({ projectId });
    expect(backups.ok).toBe(true);
    if (backups.ok) {
      expect(backups.data.length).toBeLessThanOrEqual(5);
      expect(backups.data.length).toBeGreaterThan(0);
    }
  });
});

describe('编辑曲线 → 保存 → 重开（阶段 B 内容持久化闭环）', () => {
  it('新增节点并保存后，重开仍是同一曲线内容', async () => {
    const harness = await setup();
    const projectId = await createAndReady(harness);
    const opened = await harness.services.openRecent(projectId);
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }
    const base = opened.data.snapshot;
    const midNode = {
      id: 'mid-1',
      timeMs: 30_000,
      value: 80,
      outMode: 'auto' as const,
      inHandle: null,
      outHandle: null,
    };
    const edited = {
      ...base,
      curve: { ...base.curve, nodes: [...base.curve.nodes, midNode].sort((a, b) => a.timeMs - b.timeMs) },
    };
    const saved = await harness.services.saveProject({
      projectId,
      expectedRevision: base.revision,
      snapshot: edited,
    });
    expect(saved.ok).toBe(true);

    // 关闭再重开（模拟重启）。
    await harness.services.closeProject(projectId);
    const reopened = await harness.services.openRecent(projectId);
    expect(reopened.ok).toBe(true);
    if (reopened.ok) {
      expect(reopened.data.snapshot.curve.nodes).toHaveLength(3);
      expect(reopened.data.snapshot.curve.nodes.some((n) => n.timeMs === 30_000 && n.value === 80)).toBe(true);
    }
  });
});

describe('removeRecent / 重命名 / 关闭（规格 2.2 / 8.4 / 8.5）', () => {
  it('从最近列表移除只改索引，磁盘项目仍在', async () => {
    const harness = await setup();
    const projectId = await createAndReady(harness);
    const folder = await findProjectFolder(harness.destDir);

    const removed = await harness.services.removeRecent(projectId);
    expect(removed.ok).toBe(true);
    const list = await harness.services.listRecent();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data.find((p) => p.projectId === projectId)).toBeUndefined();
    }
    // 磁盘仍在。
    await expect(readFile(path.join(folder, 'project.json'), 'utf8')).resolves.toContain('schemaVersion');
  });

  it('重命名更新项目名并落盘', async () => {
    const harness = await setup();
    const projectId = await createAndReady(harness);
    const renamed = await harness.services.renameProject({ projectId, name: '新的名字' });
    expect(renamed.ok).toBe(true);
    const folder = await findProjectFolder(harness.destDir);
    const snapshot = JSON.parse(
      await readFile(path.join(folder, 'project.json'), 'utf8'),
    ) as ProjectSnapshot;
    expect(snapshot.name).toBe('新的名字');
  });

  it('closeProject 释放锁文件', async () => {
    const harness = await setup();
    const projectId = await createAndReady(harness);
    const folder = await findProjectFolder(harness.destDir);
    await harness.services.closeProject(projectId);
    await expect(readFile(path.join(folder, '.lock'), 'utf8')).rejects.toThrow();
  });
});

describe('封面后台补建（规格 2.2 卡片封面占位）', () => {
  const devVideo = path.resolve('dev-assets', 'dev-test.mp4');

  it('缺少封面的旧项目在列表读取时自动补建封面', async () => {
    const harness = await setup(devVideo);
    const projectId = await createAndReady(harness, '缺封面项目');
    const folder = await findProjectFolder(harness.destDir);
    const coverFile = path.join(folder, 'cache', 'cover.jpg');
    // 模拟早期版本导入、从未生成封面的旧项目。
    await rm(coverFile, { force: true });

    const first = await harness.services.listRecent();
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.data.find((p) => p.projectId === projectId)?.coverMediaUrl).toBeNull();
    }

    // 后台补建（fire-and-forget）完成后，再次读取即拿到封面 URL。
    await waitForAsync(
      async () => access(coverFile).then(() => true).catch(() => false),
      15000,
    );
    const second = await harness.services.listRecent();
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.find((p) => p.projectId === projectId)?.coverMediaUrl).not.toBeNull();
    }
  }, 30000);
});

describe('sanitizeFolderName（规格 2.3）', () => {
  it('过滤 Windows 禁用字符与保留名', () => {
    expect(sanitizeFolderName('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFolderName('CON')).toBe('_CON');
    expect(sanitizeFolderName('   ')).toBe('项目');
    expect(sanitizeFolderName('name.   ')).toBe('name');
  });

  it('超长名称被截断', () => {
    expect(sanitizeFolderName('x'.repeat(120)).length).toBeLessThanOrEqual(60);
  });
});