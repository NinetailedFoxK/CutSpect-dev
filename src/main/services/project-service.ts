import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok } from '../../shared/api-types';
import type {
  BackupSummary,
  ProjectCardStatus,
  ProjectMedia,
  ProjectSnapshot,
  ProjectSummary,
  RecoveryInfo,
  Result,
} from '../../shared/api-types';
import { buildMediaUrl, playbackMediaUrl } from '../../shared/media-url';
import { currentAdapter } from '../../platform/common';
import {
  createInitialSnapshot,
  isSafeProjectRelativePath,
  migrateProjectSnapshot,
  needsStructureMigration,
  validateProjectSnapshot,
  PROJECT_NAME_MAX,
  SCHEMA_VERSION,
} from '../../shared/schema';
import { registerMediaResource, unregisterProject } from '../protocol';
import { writeFileAtomic } from './atomic-write';
import { acquireProjectLock, releaseProjectLock } from './project-lock';
import { checkMediaPolicy, copyWithHash, estimateSpaceFor } from './media-service';
import { generateCover } from './thumbnail-service';
import { probeFile } from './ffmpeg';
import type { ProbeResult } from './ffmpeg';
import { RecentStore } from './recent-store';
import type { TaskManager } from './tasks';

/**
 * 项目服务（规格 8 / 9 / 11，阶段 A 闭环核心）。
 *
 * 覆盖“导入真实视频 → 保存 → 重开”闭环，并落地区分如下职责：
 * - createProject：校验 →（后台）流式复制+哈希 → ffprobe → 原子写 project.json
 *   → 登记最近列表与 laipian-media: 资源。长任务跑在 TaskManager 上，
 *   渲染层经 tasks.subscribe/ snapshot 观察真实进度（规格 2.4 / 10.4）。
 * - openProjectFolder / openRecent：读取并整体校验 project.json，
 *   校验失败不覆盖原文件；素材缺失仍允许查看分析（规格 9.3 / F04）。
 * - saveProject：schema 校验 → revision 乐观锁 → 原子替换 → 保留最近 5 份备份
 *   （规格 8.2 / 8.3 / 12.4）。
 * - 项目级锁：单实例锁之外再加一层跨进程 .lock（规格 8.5）。
 *
 * 依赖（probe / reveal / userDataDir / now）全部注入，便于在 vitest 下
 * 用临时目录与桩探测做真实文件操作的单元测试，不依赖 Electron 与 ffprobe。
 */

export interface ProjectServiceOptions {
  userDataDir: string;
  tasks: TaskManager;
  /** 探测实现；默认 ffprobe（probeFile）。测试可注入桩。 */
  probe?: (absPath: string) => Promise<Result<ProbeResult>>;
  /** 在系统文件管理器中显示；由 main 注入 shell.showItemInFolder。 */
  revealInFolder?: (absPath: string) => void;
  now?: () => Date;
  /** 自动备份最小间隔（规格 8.3，默认 60s）；测试可调小以验证保留策略。 */
  backupMinIntervalMs?: number;
}

export interface OpenedProject {
  projectId: string;
  snapshot: ProjectSnapshot;
  /** laipian-media: 播放 URL；素材缺失时为 null。 */
  mediaUrl: string | null;
  status: ProjectCardStatus;
  /** 检测到比主文件更新的有效恢复快照时非空（规格 8.4）。 */
  recovery: RecoveryInfo | null;
}

/** 项目媒体上下文（供缩略图/兼容副本等后台任务使用）。 */
export interface MediaContext {
  projectId: string;
  folder: string;
  sourceAbsPath: string;
  media: ProjectMedia;
  durationMs: number;
  sha256: string;
}

export interface CreateProjectParams {
  sourcePath: string;
  destinationDir: string;
  name: string;
  /** 用户已确认"重复导入同一个视频仍要新建"时，由 renderer 传入以跳过重复检测。 */
  allowDuplicate?: boolean;
}

/** 项目 JSON 主文件名（规格 2.3：固定 project.json，不随显示名重命名）。 */
export const PROJECT_FILE_NAME = 'project.json';
export const BACKUP_DIR_NAME = 'backups';
export const MEDIA_DIR_NAME = 'media';
export const CACHE_DIR_NAME = 'cache';
export const RECOVERY_DIR_NAME = 'recovery';
export const RECENT_FILE_NAME = 'recent-projects.json';

/** 备份保留份数与最小间隔（规格 8.3）。 */
const BACKUP_KEEP = 5;
const BACKUP_MIN_INTERVAL_MS = 60_000;

interface OpenProjectRuntime {
  projectId: string;
  folder: string;
  snapshot: ProjectSnapshot;
  revision: number;
  sourceAbsPath: string;
  playbackAbsPath: string | null;
  lockPath: string;
  lastBackupAt: number;
}

/* ------------------------------------------------------------------ */
/* 纯函数：目录名过滤（规格 2.3）                                         */
/* ------------------------------------------------------------------ */

// Windows 保留名（不区分大小写）。
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** 过滤 Windows 禁用字符、控制字符与多余空白（规格 2.3）。 */
export function sanitizeFolderName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  safe = safe.replace(/\s+/g, ' ').trim();
  // Windows 禁止结尾点与空格。
  safe = safe.replace(/[. ]+$/g, '');
  if (safe.length === 0) {
    safe = '项目';
  }
  if (WINDOWS_RESERVED.has(safe.toUpperCase())) {
    safe = `_${safe}`;
  }
  // 过长的目录名截断（避免超 Windows 260 路径与 macOS 255 字节限制）。
  const maxBase = 60;
  if (safe.length > maxBase) {
    safe = safe.slice(0, maxBase);
  }
  return safe;
}

function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** 解析后的路径是否严格位于 root 之内（不是 root 本身，也不是 `..` 逃逸）。 */
function isResolvedInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel.length === 0 || path.isAbsolute(rel)) {
    return false;
  }
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * 把项目内相对路径解析成绝对路径，并确认它仍在项目根目录内。
 * 与打开项目时对 sourcePath 的夹紧同一标准：拒绝绝对路径、`..` 和解析后越界。
 */
export function resolveInsideProject(folder: string, relativePath: string): string | null {
  if (!isSafeProjectRelativePath(relativePath)) {
    return null;
  }
  const root = path.resolve(folder);
  const abs = path.resolve(root, relativePath);
  if (!isResolvedInside(root, abs)) {
    return null;
  }
  return abs;
}

/**
 * 播放副本在 registerMedia 之前的路径夹紧。
 * 词法路径必须留在项目内；文件若已存在，再按 realpath 确认符号链接没有指向项目外。
 * 越界时返回 null，调用方不得登记该路径。
 */
async function resolvePlaybackForRegister(folder: string, relativePath: string): Promise<string | null> {
  const lexical = resolveInsideProject(folder, relativePath);
  if (lexical === null) {
    return null;
  }
  try {
    const real = await realpath(lexical);
    const realRoot = await realpath(path.resolve(folder));
    if (!isResolvedInside(realRoot, real)) {
      return null;
    }
    return real;
  } catch {
    return lexical;
  }
}

/* ------------------------------------------------------------------ */
/* 服务实现                                                             */
/* ------------------------------------------------------------------ */

export interface ProjectService {
  listRecent(): Promise<Result<ProjectSummary[]>>;
  createProject(params: CreateProjectParams): Promise<Result<{ projectId: string }>>;
  /** 重复导入预检（规格 2）：按源文件名 + 大小查询已有项目，不消费令牌。 */
  findDuplicate(params: { originalName: string; sizeBytes: number }): Promise<
    Result<{ duplicate: { projectId: string; name: string } | null }>
  >;
  openProjectFolder(folder: string): Promise<Result<OpenedProject>>;
  openRecent(projectId: string): Promise<Result<OpenedProject>>;
  saveProject(params: {
    projectId: string;
    expectedRevision: number;
    snapshot: ProjectSnapshot;
  }): Promise<Result<{ revision: number }>>;
  renameProject(params: { projectId: string; name: string }): Promise<Result<null>>;
  revealProject(projectId: string): Promise<Result<null>>;
  removeRecent(projectId: string): Promise<Result<null>>;
  listBackups(params: { projectId: string }): Promise<Result<BackupSummary[]>>;
  restoreBackup(params: { projectId: string; backupId: string }): Promise<Result<ProjectSnapshot>>;
  restoreRecovery(params: { projectId: string; pendingId: string }): Promise<Result<ProjectSnapshot>>;
  discardRecovery(params: { projectId: string; pendingId: string }): Promise<Result<null>>;
  /** 重新定位素材：只接受与记录 SHA-256 一致的文件（规格 9.3）。 */
  relocateSource(params: { projectId: string; candidatePath: string }): Promise<Result<null>>;
  /** 登记兼容副本为播放来源（规格 10.2），写回 playbackPath 并升 revision。 */
  setPlaybackSource(params: { projectId: string; relativePath: string }): Promise<Result<{ revision: number }>>;
  /** 已打开项目的媒体上下文；未打开返回 null。 */
  mediaContext(projectId: string): MediaContext | null;
  /** 返回项目库前关闭：注销媒体注册、释放项目锁（规格 8.4 / 8.5）。 */
  closeProject(projectId: string): Promise<void>;
  /** 应用退出时释放全部锁。 */
  releaseAllLocks(): Promise<void>;
}

const SCHEMA_INVALID_CODE = 'SCHEMA_INVALID';

export function createProjectService(options: ProjectServiceOptions): ProjectService {
  const probe = options.probe ?? probeFile;
  const now = options.now ?? (() => new Date());
  const backupMinIntervalMs = options.backupMinIntervalMs ?? BACKUP_MIN_INTERVAL_MS;
  const recent = new RecentStore(path.join(options.userDataDir, RECENT_FILE_NAME));
  const openProjects = new Map<string, OpenProjectRuntime>();

  /* ---------------- 内部工具 ---------------- */

  const iso = (): string => now().toISOString();

  const projectFilePath = (folder: string): string => path.join(folder, PROJECT_FILE_NAME);
  const backupDirPath = (folder: string): string => path.join(folder, BACKUP_DIR_NAME);
  const recoveryDirPath = (folder: string): string => path.join(folder, RECOVERY_DIR_NAME);

  /** 保存前写入未提交快照（规格 8.4/11.1 recovery/）；返回 pendingId。 */
  async function writePending(folder: string, snapshot: ProjectSnapshot): Promise<string> {
    const dir = recoveryDirPath(folder);
    await mkdir(dir, { recursive: true });
    const stamp = iso().replace(/[:.]/g, '-');
    const pendingId = `pending-r${snapshot.revision}-${stamp}.json`;
    await writeFileAtomic(path.join(dir, pendingId), `${JSON.stringify(snapshot, null, 2)}\n`);
    return pendingId;
  }

  /** 检测比主文件更新的有效恢复快照（规格 8.4）。 */
  async function readRecovery(folder: string, mainRevision: number): Promise<RecoveryInfo | null> {
    const dir = recoveryDirPath(folder);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return null;
    }
    let best: RecoveryInfo | null = null;
    for (const name of names) {
      const match = /^pending-r(\d+)-(.*)\.json$/.exec(name);
      if (!match) {
        continue;
      }
      const revision = Number(match[1]);
      if (!Number.isFinite(revision) || revision <= mainRevision) {
        continue;
      }
      try {
        const text = await readFile(path.join(dir, name), 'utf8');
        const validated = validateProjectSnapshot(JSON.parse(text));
        if (!validated.ok) {
          continue;
        }
        if (best === null || validated.snapshot.revision > best.revision) {
          best = { pendingId: name, revision: validated.snapshot.revision, updatedAt: validated.snapshot.updatedAt };
        }
      } catch {
        continue;
      }
    }
    return best;
  }

  async function acquireLock(folder: string): Promise<Result<string>> {
    return acquireProjectLock(path.join(folder, '.lock'), iso());
  }

  async function releaseLock(lockPath: string): Promise<void> {
    await releaseProjectLock(lockPath);
  }

  /** 记录运行时（保存分析所需；素材缺失时也要保留，规格 9.3）。 */
  function storeRuntime(runtime: OpenProjectRuntime): void {
    openProjects.set(runtime.projectId, runtime);
  }

  /** 登记协议媒体资源；仅在素材真实存在时调用（未登记 → 协议 403）。 */
  function registerMedia(runtime: OpenProjectRuntime): void {
    registerMediaResource(runtime.projectId, runtime.snapshot.media.id, 'source', runtime.sourceAbsPath);
    if (runtime.playbackAbsPath) {
      registerMediaResource(runtime.projectId, runtime.snapshot.media.id, 'playback', runtime.playbackAbsPath);
    }
    // 命名资源：登记缓存目录（URL 再带受控文件名访问目录内文件，规格 4.4 / 5.5）。
    registerMediaResource(
      runtime.projectId,
      runtime.snapshot.media.id,
      'thumb',
      path.join(runtime.folder, CACHE_DIR_NAME, 'thumbs'),
    );
    registerMediaResource(
      runtime.projectId,
      runtime.snapshot.media.id,
      'frame',
      path.join(runtime.folder, CACHE_DIR_NAME, 'frames'),
    );
  }

  async function upsertRecent(runtime: OpenProjectRuntime): Promise<void> {
    await recent.upsert({
      projectId: runtime.projectId,
      folder: runtime.folder,
      name: runtime.snapshot.name,
      sourceOriginalName: runtime.snapshot.media.originalName,
      durationMs: runtime.snapshot.media.durationMs,
      mediaId: runtime.snapshot.media.id,
      lastEditedAt: runtime.snapshot.updatedAt,
    });
  }

  /** 生成唯一项目文件夹名：<过滤名>-<短ID>，冲突时重新取短 ID。 */
  async function uniqueFolder(destDir: string, name: string): Promise<string> {
    const base = sanitizeFolderName(name);
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = path.join(destDir, `${base}-${shortId()}`);
      if (!(await pathExists(candidate))) {
        return candidate;
      }
    }
    // 极端兜底：附加完整 UUID。
    return path.join(destDir, `${base}-${randomUUID()}`);
  }

  /** 读取并校验项目文件；失败返回结构化错误，绝不覆盖原文件。 */
  async function readSnapshot(
    folder: string,
  ): Promise<Result<ProjectSnapshot>> {
    const file = projectFilePath(folder);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') {
        return err('PROJECT_NOT_FOUND', '该文件夹中没有 project.json，可能不是 CutSpect 项目。');
      }
      return err('IO', `读取项目文件失败：${(error as Error).message}`, true);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return err('SCHEMA_INVALID', '项目文件已损坏（JSON 无法解析），未覆盖原文件；请选择有效备份。');
    }
    const schemaVersion = (parsed as { schemaVersion?: unknown })?.schemaVersion;
    if (typeof schemaVersion === 'number' && schemaVersion > SCHEMA_VERSION) {
      return err(
        'SCHEMA_TOO_NEW',
        `项目使用了更高版本格式（schemaVersion ${schemaVersion}），当前程序无法写入，请使用新版 CutSpect。`,
      );
    }
    const validated = validateProjectSnapshot(parsed);
    if (!validated.ok) {
      return err(
        SCHEMA_INVALID_CODE,
        `项目数据校验未通过，未覆盖原文件：${validated.issues.slice(0, 3).join('；')}`,
      );
    }
    let snapshot = validated.snapshot;
    // 旧项目（缺三级结构或版本落后）就地迁移到当前 schema；迁移失败保留原文件，
    // 仅在内存中使用迁移结果，本次会话仍可正常打开（规格 3.3）。
    if (needsStructureMigration(snapshot)) {
      const migrated = migrateProjectSnapshot(snapshot);
      const revalidated = validateProjectSnapshot(migrated);
      if (revalidated.ok) {
        snapshot = revalidated.snapshot;
        await writeFileAtomic(projectFilePath(folder), `${JSON.stringify(snapshot, null, 2)}\n`).catch(
          () => undefined,
        );
      }
    }
    return ok(snapshot);
  }

  async function openFolder(folder: string): Promise<Result<OpenedProject>> {
    const read = await readSnapshot(folder);
    if (!read.ok) {
      return read;
    }
    const snapshot = read.data;
    if (!isSafeProjectRelativePath(snapshot.media.sourcePath)) {
      return err('SCHEMA_INVALID', '项目内素材路径不安全，已拒绝打开。');
    }
    const lock = await acquireLock(folder);
    if (!lock.ok) {
      return lock;
    }
    const sourceAbsPath = resolveInsideProject(folder, snapshot.media.sourcePath);
    // 防穿越：解析后必须仍在项目文件夹内（规格 9.2）。
    if (sourceAbsPath === null) {
      await releaseLock(lock.data);
      return err('SCHEMA_INVALID', '项目内素材路径越出项目文件夹，已拒绝打开。');
    }
    const playbackAbsPath =
      snapshot.media.playbackPath !== null
        ? await resolvePlaybackForRegister(folder, snapshot.media.playbackPath)
        : null;

    const sourceExists = await pathExists(sourceAbsPath);
    const status: ProjectCardStatus = sourceExists ? 'ready' : 'missing';

    const runtime: OpenProjectRuntime = {
      projectId: snapshot.id,
      folder,
      snapshot,
      revision: snapshot.revision,
      sourceAbsPath,
      playbackAbsPath: sourceExists && playbackAbsPath !== null ? playbackAbsPath : null,
      lockPath: lock.data,
      lastBackupAt: 0,
    };
    // 已有同项目打开时先释放旧的锁与注册，避免泄漏。
    const existing = openProjects.get(snapshot.id);
    if (existing) {
      unregisterProject(existing.projectId);
      await releaseLock(existing.lockPath);
    }
    storeRuntime(runtime);
    if (sourceExists) {
      registerMedia(runtime);
    }
    await upsertRecent(runtime);

    return ok({
      projectId: snapshot.id,
      snapshot,
      mediaUrl: sourceExists
        ? playbackMediaUrl({
            projectId: snapshot.id,
            mediaId: snapshot.media.id,
            playbackPath: runtime.playbackAbsPath !== null ? snapshot.media.playbackPath : null,
            revision: snapshot.revision,
          })
        : null,
      status,
      recovery: await readRecovery(folder, snapshot.revision),
    });
  }

  /**
   * 重复导入检测（规格 2 异常交互）：在最近项目中查找"同名 + 同字节大小"的源视频。
   * 只读取已完整导入项目的 project.json 比对（不重跑 ffprobe）；命中返回已有项目名。
   */
  async function findDuplicateSource(
    originalName: string,
    sizeBytes: number,
  ): Promise<{ projectId: string; name: string } | null> {
    const entries = await recent.list();
    for (const entry of entries) {
      if (entry.sourceOriginalName !== originalName) {
        continue;
      }
      const read = await readSnapshot(entry.folder).catch(() => null);
      if (read === null || !read.ok) {
        continue;
      }
      if (read.data.media.sizeBytes === sizeBytes) {
        return { projectId: entry.projectId, name: entry.name };
      }
    }
    return null;
  }

  /* ---------------- 对外 API ---------------- */

  /**
   * 封面后台补建去重表：早期版本导入、或封面生成阶段失败的旧项目可能从未写入
   * cache/cover.jpg，导致卡片只显示占位块（规格 2.2 卡片封面）。列表读取时对
   * 这类项目只触发一次后台补建，避免每次加载反复拉起 ffmpeg。
   */
  const coverBackfillAttempts = new Set<string>();

  return {
    async listRecent() {
      const entries = await recent.list();
      const summaries: ProjectSummary[] = [];
      for (const entry of entries) {
        const folderExists = await pathExists(projectFilePath(entry.folder));
        let status: ProjectCardStatus = 'missing';
        let coverUrl: string | null = null;
        if (folderExists) {
          // 素材存在性由是否存在 sourcePath 推导；策略层不重跑 ffprobe。
          const read = await readSnapshot(entry.folder).catch(() => null);
          let sourceAbsPath: string | null = null;
          if (read !== null && read.ok) {
            sourceAbsPath = path.resolve(entry.folder, read.data.media.sourcePath);
            status = (await pathExists(sourceAbsPath)) ? 'ready' : 'missing';
          } else {
            status = 'missing';
          }
          const coverAbs = path.join(entry.folder, CACHE_DIR_NAME, 'cover.jpg');
          if (await pathExists(coverAbs)) {
            registerMediaResource(entry.projectId, entry.mediaId, 'cover', coverAbs);
            coverUrl = buildMediaUrl(entry.projectId, entry.mediaId, 'cover', entry.lastEditedAt);
          } else if (
            status === 'ready' &&
            sourceAbsPath !== null &&
            !coverBackfillAttempts.has(entry.projectId)
          ) {
            // 素材存在但无封面：后台补建（不阻塞本次列表读取，也不阻断首页渲染）。
            // 生成成功后，渲染层下次刷新即可拿到 coverMediaUrl 显示真实预览。
            coverBackfillAttempts.add(entry.projectId);
            void generateCover({
              sourceAbsPath,
              projectFolder: entry.folder,
            }).catch(() => undefined);
          }
        }
        summaries.push({
          projectId: entry.projectId,
          name: entry.name,
          sourceOriginalName: entry.sourceOriginalName,
          durationMs: entry.durationMs,
          lastEditedAt: entry.lastEditedAt,
          status,
          coverMediaUrl: coverUrl,
        });
      }
      return ok(summaries);
    },

    /** 重复导入预检（规格 2）：按源文件名 + 大小查询已有项目，不消费令牌。 */
    async findDuplicate(params) {
      return ok({
        duplicate: await findDuplicateSource(params.originalName, params.sizeBytes),
      });
    },

    async createProject(params) {
      const trimmedName = params.name.trim();
      if (trimmedName.length === 0 || trimmedName.length > PROJECT_NAME_MAX) {
        return err('INVALID_PARAMS', `项目名称需为 1—${PROJECT_NAME_MAX} 个字符。`);
      }
      // 源文件校验。
      let sourceStat;
      try {
        sourceStat = await stat(params.sourcePath);
      } catch {
        return err('SOURCE_NOT_FOUND', '找不到所选视频文件，请重新选择。');
      }
      if (!sourceStat.isFile()) {
        return err('INVALID_PARAMS', '所选路径不是视频文件。');
      }
      // 目标目录必须存在且可写（先建目录探测）。
      try {
        await mkdir(params.destinationDir, { recursive: true });
      } catch (error) {
        return err('IO', `无法使用所选保存位置：${(error as Error).message}`);
      }
      // 磁盘空间检查（规格 10.4：按源文件大小加余量；估算非保证）。
      const space = await estimateSpaceFor(sourceStat.size, params.destinationDir);
      if (!space.ok) {
        return space;
      }
      if (!space.data.sufficient) {
        return err(
          'DISK_FULL',
          `保存位置可用空间不足：约需 ${Math.ceil(space.data.requiredBytes / 1024 / 1024)} MB，当前可用 ${Math.floor(space.data.availableBytes / 1024 / 1024)} MB。`,
        );
      }
      if (sourceStat.size === 0) {
        return err('SOURCE_NOT_FOUND', '所选视频文件为空，无法创建项目。');
      }

      // 重复导入检测（规格 2）：同名同大小视为疑似重复；用户确认后由
      // allowDuplicate 放行。message 携带已有项目名，供确认对话框展示。
      if (params.allowDuplicate !== true) {
        const duplicate = await findDuplicateSource(
          path.basename(params.sourcePath),
          sourceStat.size,
        );
        if (duplicate !== null) {
          return err('DUPLICATE_SOURCE', `该视频已导入为项目「${duplicate.name}」。`);
        }
      }

      const projectId = randomUUID();
      const finalFolder = await uniqueFolder(params.destinationDir, trimmedName);
      const tempFolder = path.join(params.destinationDir, `.laipian-import-${projectId}.part`);
      const tempMediaDir = path.join(tempFolder, MEDIA_DIR_NAME);
      const ext = path.extname(params.sourcePath).toLowerCase() || '.mp4';
      const mediaFileName = `source${ext}`;
      const tempMediaPath = path.join(tempMediaDir, mediaFileName);

      try {
        await mkdir(tempMediaDir, { recursive: true });
      } catch (error) {
        return err('IO', `无法创建项目文件夹：${(error as Error).message}`);
      }

      const cleanupTemp = async (): Promise<void> => {
        await rm(tempFolder, { recursive: true, force: true }).catch(() => undefined);
      };

      // 后台执行复制 → 探测 → 落盘 → 登记；进度经 TaskManager 广播。
      // 不 await：createProject 需尽快返回 projectId 让导入页接管。
      void (async () => {
        try {
          const copyResult = await options.tasks.run(
            { kind: 'copy', projectId, initialStep: '复制视频' },
            async (ctx) =>
              copyWithHash(params.sourcePath, tempMediaPath, {
                onProgress: (p) =>
                  ctx.report({
                    kind: 'bytes',
                    completedBytes: p.completedBytes,
                    totalBytes: p.totalBytes,
                  }),
                cancelToken: ctx.signal,
              }),
          );
          if (!copyResult.ok) {
            await cleanupTemp();
            return;
          }
          const sha256 = copyResult.data.sha256;
          const sizeBytes = copyResult.data.bytesCopied;

          const finalize = await options.tasks.run(
            { kind: 'probe', projectId, initialStep: '读取视频信息' },
            async (ctx) => {
              ctx.reportStep('读取视频信息');
              const probeResult = await probe(tempMediaPath);
              if (!probeResult.ok) {
                return probeResult;
              }
              const policy = checkMediaPolicy(probeResult.data);
              if (policy === 'rejected') {
                return err(
                  'MEDIA_REJECTED',
                  '素材超出本版容量基线（单文件 ≤ 20GB、时长 ≤ 2 小时），本版无法导入。',
                );
              }
              if (ctx.signal.aborted) {
                return err('CANCELLED', '导入已取消。');
              }
              const media: ProjectMedia = {
                id: randomUUID(),
                originalName: path.basename(params.sourcePath),
                sourcePath: `${MEDIA_DIR_NAME}/${mediaFileName}`,
                playbackPath: null,
                sha256,
                sizeBytes,
                durationMs: probeResult.data.durationMs,
                width: probeResult.data.width,
                height: probeResult.data.height,
                videoCodec: probeResult.data.videoCodec,
                audioCodec: probeResult.data.audioCodec,
                avgFrameRate: probeResult.data.avgFrameRate,
                isVfr: probeResult.data.isVfr,
                isHdr: probeResult.data.isHdr,
              };
              const snapshot = createInitialSnapshot({
                projectId,
                name: trimmedName,
                media,
                now: iso(),
              });
              const validated = validateProjectSnapshot(snapshot);
              if (!validated.ok) {
                return err('SCHEMA_INVALID', `生成的初始数据未通过校验：${validated.issues.join('；')}`);
              }
              // 就位：临时目录改名到正式路径（同一父目录，rename 原子）。
              await rename(tempFolder, finalFolder);
              await mkdir(backupDirPath(finalFolder), { recursive: true }).catch(() => undefined);
              await writeFileAtomic(
                projectFilePath(finalFolder),
                `${JSON.stringify(snapshot, null, 2)}\n`,
              );
              // 生成封面（规格 2.4 "生成封面"阶段）：非关键步骤，失败只记录、
              // 不阻断导入（规格 15：缩略图失败仍允许进入编辑器）。
              ctx.reportStep('生成封面');
              await generateCover({
                sourceAbsPath: path.join(finalFolder, MEDIA_DIR_NAME, mediaFileName),
                projectFolder: finalFolder,
              }).catch(() => undefined);
              if (ctx.signal.aborted) {
                return err('CANCELLED', '导入已取消。');
              }
              const lock = await acquireLock(finalFolder);
              if (!lock.ok) {
                return lock;
              }
              const runtime: OpenProjectRuntime = {
                projectId,
                folder: finalFolder,
                snapshot,
                revision: snapshot.revision,
                sourceAbsPath: path.join(finalFolder, MEDIA_DIR_NAME, mediaFileName),
                playbackAbsPath: null,
                lockPath: lock.data,
                lastBackupAt: Date.now(),
              };
              registerMedia(runtime);
              await upsertRecent(runtime);
              return ok({ projectId });
            },
          );
          if (!finalize.ok) {
            await cleanupTemp();
            // 若已 rename 到正式目录，失败时也要清理，避免留下“假项目”。
            await rm(finalFolder, { recursive: true, force: true }).catch(() => undefined);
            const failed = openProjects.get(projectId);
            if (failed) {
              unregisterProject(projectId);
              await releaseLock(failed.lockPath);
              openProjects.delete(projectId);
            }
            await recent.remove(projectId).catch(() => undefined);
          }
        } catch {
          // 后台任务本身已把异常折叠为任务失败事件；这里仅保证临时目录清理。
          await cleanupTemp();
          await rm(finalFolder, { recursive: true, force: true }).catch(() => undefined);
        }
      })();

      return ok({ projectId });
    },

    async openProjectFolder(folder) {
      return openFolder(folder);
    },

    async openRecent(projectId) {
      const entry = await recent.get(projectId);
      if (!entry) {
        return err('PROJECT_NOT_FOUND', '该项目不在最近列表中，请用“打开项目文件夹”重新定位。');
      }
      return openFolder(entry.folder);
    },

    async saveProject(params) {
      const runtime = openProjects.get(params.projectId);
      if (!runtime) {
        return err('PROJECT_NOT_OPEN', '项目未打开，无法保存。');
      }
      const validated = validateProjectSnapshot(params.snapshot);
      if (!validated.ok) {
        return err(
          SCHEMA_INVALID_CODE,
          `数据校验未通过，已拒绝写入：${validated.issues.slice(0, 3).join('；')}`,
        );
      }
      if (params.expectedRevision !== runtime.revision) {
        return err(
          'REVISION_CONFLICT',
          `项目已在别处更新（当前 revision ${runtime.revision}，期望 ${params.expectedRevision}），已停止覆盖。`,
          true,
        );
      }

      const nextRevision = runtime.revision + 1;
      const next: ProjectSnapshot = {
        ...validated.snapshot,
        id: runtime.projectId,
        revision: nextRevision,
        updatedAt: iso(),
        createdAt: runtime.snapshot.createdAt,
      };
      let pendingId: string | null = null;
      try {
        // 备份当前有效版本（满足最小间隔时），再写未提交快照（异常退出可恢复），
        // 最后原子替换主文件；成功后删除未提交快照（规格 8.3 / 8.4）。
        await backupIfDue(runtime);
        pendingId = await writePending(runtime.folder, next);
        await writeFileAtomic(projectFilePath(runtime.folder), `${JSON.stringify(next, null, 2)}\n`);
      } catch (error) {
        // 区分磁盘不足 / 权限丢失，给出面向创作者的下一步（规格 13）。
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOSPC') {
          return err(
            'DISK_FULL',
            '磁盘空间不足，无法保存。请清理磁盘空间或把项目移动到其他位置后重试。',
            true,
          );
        }
        if (code === 'EACCES' || code === 'EPERM') {
          return err(
            'IO_PERMISSION',
            `没有写入权限，无法保存。请在${currentAdapter().fileManagerName}中检查项目文件夹的访问权限后重试。`,
            true,
          );
        }
        const hint = pendingId !== null ? '（已保留未提交快照，重新打开时可恢复）' : '';
        return err('IO', `保存失败：${(error as Error).message}${hint}`, true);
      }
      if (pendingId !== null) {
        await rm(path.join(recoveryDirPath(runtime.folder), pendingId), { force: true }).catch(() => undefined);
      }
      runtime.snapshot = next;
      runtime.revision = nextRevision;
      await upsertRecent(runtime).catch(() => undefined);
      return ok({ revision: nextRevision });
    },

    async renameProject(params) {
      const name = params.name.trim();
      if (name.length === 0 || name.length > PROJECT_NAME_MAX) {
        return err('INVALID_PARAMS', `项目名称需为 1—${PROJECT_NAME_MAX} 个字符。`);
      }
      const runtime = openProjects.get(params.projectId);
      if (!runtime) {
        return err('PROJECT_NOT_OPEN', '项目未打开，无法重命名。');
      }
      const next: ProjectSnapshot = { ...runtime.snapshot, name, updatedAt: iso() };
      try {
        await writeFileAtomic(projectFilePath(runtime.folder), `${JSON.stringify(next, null, 2)}\n`);
      } catch (error) {
        return err('IO', `重命名失败：${(error as Error).message}`, true);
      }
      runtime.snapshot = next;
      await upsertRecent(runtime).catch(() => undefined);
      return ok(null);
    },

    async revealProject(projectId) {
      const runtime = openProjects.get(projectId);
      const entry = runtime
        ? { folder: runtime.folder }
        : await recent.get(projectId).then((e) => (e ? { folder: e.folder } : null));
      if (!entry) {
        return err('PROJECT_NOT_FOUND', '找不到该项目的文件夹。');
      }
      if (!options.revealInFolder) {
        return err('NOT_IMPLEMENTED', '当前环境不支持在文件管理器中显示。');
      }
      options.revealInFolder(projectFilePath(entry.folder));
      return ok(null);
    },

    async removeRecent(projectId) {
      await recent.remove(projectId);
      return ok(null);
    },

    async listBackups(params) {
      const runtime = openProjects.get(params.projectId);
      const folder = runtime ? runtime.folder : (await recent.get(params.projectId))?.folder;
      if (!folder) {
        return err('PROJECT_NOT_FOUND', '找不到该项目。');
      }
      const dir = backupDirPath(folder);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return ok([]);
      }
      const backups: BackupSummary[] = [];
      for (const name of names) {
        const match = /^project-r(\d+)-(.*)\.json$/.exec(name);
        if (!match) {
          continue;
        }
        const abs = path.join(dir, name);
        const info = await stat(abs).catch(() => null);
        if (!info) {
          continue;
        }
        backups.push({
          backupId: name,
          revision: Number(match[1] ?? 0),
          createdAt: match[2] ?? '',
          sizeBytes: info.size,
        });
      }
      backups.sort((a, b) => b.revision - a.revision);
      return ok(backups);
    },

    async restoreBackup(params) {
      const runtime = openProjects.get(params.projectId);
      const folder = runtime ? runtime.folder : (await recent.get(params.projectId))?.folder;
      if (!folder) {
        return err('PROJECT_NOT_FOUND', '找不到该项目。');
      }
      if (!/^project-r\d+-(.*)\.json$/.test(params.backupId) || params.backupId.includes('/') || params.backupId.includes('\\')) {
        return err('INVALID_PARAMS', '备份标识不合法。');
      }
      const backupAbs = path.join(backupDirPath(folder), params.backupId);
      let text: string;
      try {
        text = await readFile(backupAbs, 'utf8');
      } catch {
        return err('PROJECT_NOT_FOUND', '找不到指定备份。');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return err('SCHEMA_INVALID', '该备份已损坏，无法恢复。');
      }
      const validated = validateProjectSnapshot(parsed);
      if (!validated.ok) {
        return err('SCHEMA_INVALID', `备份数据不合法：${validated.issues.slice(0, 3).join('；')}`);
      }
      // 恢复前先保留当前版本为备份，再写回。
      if (runtime) {
        await backupCurrent(runtime).catch(() => undefined);
      }
      await writeFileAtomic(projectFilePath(folder), `${JSON.stringify(validated.snapshot, null, 2)}\n`);
      if (runtime) {
        runtime.snapshot = validated.snapshot;
        runtime.revision = validated.snapshot.revision;
        await upsertRecent(runtime).catch(() => undefined);
      }
      return ok(validated.snapshot);
    },

    async closeProject(projectId) {
      const runtime = openProjects.get(projectId);
      if (!runtime) {
        return;
      }
      unregisterProject(projectId);
      await releaseLock(runtime.lockPath);
      openProjects.delete(projectId);
    },

    async restoreRecovery(params) {
      const runtime = openProjects.get(params.projectId);
      if (!runtime) {
        return err('PROJECT_NOT_OPEN', '项目未打开，无法恢复。');
      }
      if (!/^pending-r\d+-(.*)\.json$/.test(params.pendingId) || params.pendingId.includes('/') || params.pendingId.includes('\\')) {
        return err('INVALID_PARAMS', '恢复快照标识不合法。');
      }
      const abs = path.join(recoveryDirPath(runtime.folder), params.pendingId);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(abs, 'utf8'));
      } catch {
        return err('PROJECT_NOT_FOUND', '找不到该恢复快照。');
      }
      const validated = validateProjectSnapshot(parsed);
      if (!validated.ok) {
        return err(SCHEMA_INVALID_CODE, `恢复快照不合法：${validated.issues.slice(0, 3).join('；')}`);
      }
      try {
        // 恢复前先保留当前版本（规格 8.4）。
        await backupCurrent(runtime);
        await writeFileAtomic(projectFilePath(runtime.folder), `${JSON.stringify(validated.snapshot, null, 2)}\n`);
      } catch (error) {
        return err('IO', `恢复失败：${(error as Error).message}`, true);
      }
      runtime.snapshot = validated.snapshot;
      runtime.revision = validated.snapshot.revision;
      await rm(abs, { force: true }).catch(() => undefined);
      await upsertRecent(runtime).catch(() => undefined);
      return ok(validated.snapshot);
    },

    async discardRecovery(params) {
      const runtime = openProjects.get(params.projectId);
      const folder = runtime ? runtime.folder : (await recent.get(params.projectId))?.folder;
      if (!folder) {
        return err('PROJECT_NOT_FOUND', '找不到该项目。');
      }
      if (!/^pending-r\d+-(.*)\.json$/.test(params.pendingId) || params.pendingId.includes('/') || params.pendingId.includes('\\')) {
        return err('INVALID_PARAMS', '恢复快照标识不合法。');
      }
      await rm(path.join(recoveryDirPath(folder), params.pendingId), { force: true }).catch(() => undefined);
      return ok(null);
    },

    async relocateSource(params) {
      const runtime = openProjects.get(params.projectId);
      if (!runtime) {
        return err('PROJECT_NOT_OPEN', '项目未打开，无法重新定位素材。');
      }
      let info;
      try {
        info = await stat(params.candidatePath);
      } catch {
        return err('SOURCE_NOT_FOUND', '找不到所选文件。');
      }
      if (!info.isFile()) {
        return err('INVALID_PARAMS', '所选路径不是文件。');
      }
      const mediaDir = path.join(runtime.folder, MEDIA_DIR_NAME);
      await mkdir(mediaDir, { recursive: true });
      const ext = path.extname(params.candidatePath).toLowerCase() || '.mp4';
      const tempPath = path.join(mediaDir, `.relocate-${randomUUID()}${ext}`);
      // 复制并流式计算 SHA-256；不一致则拒绝（不能直接用不同素材替换，规格 9.3）。
      const copy = await copyWithHash(params.candidatePath, tempPath);
      if (!copy.ok) {
        return copy;
      }
      if (copy.data.sha256 !== runtime.snapshot.media.sha256) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        return err(
          'MEDIA_MISMATCH',
          '所选文件与项目记录的素材不一致（SHA-256 不匹配）。请选择同一原始素材，或为新素材新建项目。',
        );
      }
      const target = path.join(mediaDir, path.basename(runtime.snapshot.media.sourcePath));
      try {
        await rm(target, { force: true }).catch(() => undefined);
        await rename(tempPath, target);
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        return err('IO', `复制素材失败：${(error as Error).message}`, true);
      }
      runtime.sourceAbsPath = target;
      registerMedia(runtime);
      return ok(null);
    },

    async setPlaybackSource(params) {
      const runtime = openProjects.get(params.projectId);
      if (!runtime) {
        return err('PROJECT_NOT_OPEN', '项目未打开，无法登记兼容副本。');
      }
      if (
        !isSafeProjectRelativePath(params.relativePath) ||
        !params.relativePath.startsWith(`${MEDIA_DIR_NAME}/`)
      ) {
        return err('INVALID_PARAMS', '兼容副本路径必须位于项目 media/ 目录内。');
      }
      const resolved = await resolvePlaybackForRegister(runtime.folder, params.relativePath);
      if (resolved === null) {
        return err('INVALID_PARAMS', '兼容副本路径越出项目文件夹。');
      }
      if (!(await pathExists(resolved))) {
        return err('PROJECT_NOT_FOUND', '找不到兼容副本文件。');
      }
      const nextRevision = runtime.revision + 1;
      const next: ProjectSnapshot = {
        ...runtime.snapshot,
        media: { ...runtime.snapshot.media, playbackPath: params.relativePath },
        revision: nextRevision,
        updatedAt: iso(),
      };
      const validated = validateProjectSnapshot(next);
      if (!validated.ok) {
        return err(SCHEMA_INVALID_CODE, `登记兼容副本前校验失败：${validated.issues.slice(0, 3).join('；')}`);
      }
      let pendingId: string | null = null;
      try {
        pendingId = await writePending(runtime.folder, next);
        await writeFileAtomic(projectFilePath(runtime.folder), `${JSON.stringify(next, null, 2)}\n`);
      } catch (error) {
        return err('IO', `登记兼容副本失败：${(error as Error).message}`, true);
      }
      if (pendingId !== null) {
        await rm(path.join(recoveryDirPath(runtime.folder), pendingId), { force: true }).catch(() => undefined);
      }
      runtime.snapshot = next;
      runtime.revision = nextRevision;
      runtime.playbackAbsPath = resolved;
      registerMedia(runtime);
      await upsertRecent(runtime).catch(() => undefined);
      return ok({ revision: nextRevision });
    },

    mediaContext(projectId) {
      const runtime = openProjects.get(projectId);
      if (!runtime) {
        return null;
      }
      return {
        projectId: runtime.projectId,
        folder: runtime.folder,
        sourceAbsPath: runtime.sourceAbsPath,
        media: runtime.snapshot.media,
        durationMs: runtime.snapshot.media.durationMs,
        sha256: runtime.snapshot.media.sha256,
      };
    },


    async releaseAllLocks() {
      for (const runtime of openProjects.values()) {
        unregisterProject(runtime.projectId);
        await releaseLock(runtime.lockPath);
      }
      openProjects.clear();
    },
  };

  /* ---------------- 备份辅助（闭包内） ---------------- */

  async function backupCurrent(runtime: OpenProjectRuntime): Promise<void> {
    const dir = backupDirPath(runtime.folder);
    await mkdir(dir, { recursive: true });
    const stamp = iso().replace(/[:.]/g, '-');
    const name = `project-r${runtime.revision}-${stamp}.json`;
    await writeFileAtomic(path.join(dir, name), `${JSON.stringify(runtime.snapshot, null, 2)}\n`);
    await pruneBackups(dir);
    runtime.lastBackupAt = Date.now();
  }

  async function backupIfDue(runtime: OpenProjectRuntime): Promise<void> {
    if (Date.now() - runtime.lastBackupAt < backupMinIntervalMs) {
      return;
    }
    await backupCurrent(runtime);
  }

  async function pruneBackups(dir: string): Promise<void> {
    const names = await readdir(dir).catch(() => [] as string[]);
    const files = names
      .filter((name) => /^project-r\d+-(.*)\.json$/.test(name))
      .sort();
    const overflow = files.length - BACKUP_KEEP;
    for (let i = 0; i < overflow; i++) {
      const name = files[i];
      if (name !== undefined) {
        await rm(path.join(dir, name), { force: true }).catch(() => undefined);
      }
    }
  }
}