import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { err, ok } from '../shared/api-types';
import type {
  AppSettings,
  ExportRequest,
  FileSelectionKind,
  FileSelectionToken,
  Result,
  TimelineThumbnail,
  VideoPickResult,
} from '../shared/api-types';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { IpcInvokeChannel } from '../shared/ipc-channels';
import { buildMediaUrl } from '../shared/media-url';
import { projectSnapshotSchema } from '../shared/schema';
import { consumeSelection, registerSelection } from './file-selection';
import { isTrustedFrameUrl } from './ipc-trust';
import { createCompatibleCopy } from './services/compatible-copy-service';
import { probeFile } from './services/ffmpeg';
import { getFramePreview } from './services/frame-service';
import { cancelProjectFrames, requestFilmstripBatch } from './services/frame-queue';
import { detectShots, detectShotsRange, readCachedCuts, readCachedRangeCuts } from './services/shot-detect-service';
import { generateThumbnails, listThumbnailEntries, THUMB_HEIGHT, THUMB_WIDTH } from './services/thumbnail-service';
import type { ExportService } from './services/export-service';
import { runExport } from './services/export-runner';
import type { ProjectService } from './services/project-service';
import type { SettingsService } from './services/settings-service';
import type { TaskManager } from './services/tasks';
import type { UpdateService } from './update/service';

/**
 * IPC handler 注册（规格 12.4 / 12.5）。
 *
 * - 所有 invoke 通道用 zod 校验参数。
 * - 打包态只信任 file:// 渲染层；开发态才额外信任 Vite。
 * - 文件选择入口返回一次性 opaque 令牌；业务 handler 用令牌兑换真实路径
 *   （renderer 永远拿不到绝对路径）。
 * - 导出的 reveal / open 只接受本会话产物 id，绝对路径留在主进程白名单。
 * - handler 一律返回 Result<T>，异常兜底为 INTERNAL，不让渲染层收到裸 reject。
 */

export interface IpcDeps {
  projects: ProjectService;
  tasks: TaskManager;
  exports: ExportService;
  settings: SettingsService;
  updates: UpdateService;
  allowWindowClose(event: IpcMainInvokeEvent): void;
}

/* ------------------------------------------------------------------ */
/* 注册框架                                                              */
/* ------------------------------------------------------------------ */

/** 视频选择器允许的扩展名（规格 10.1：扩展名仅用于筛选，实际由 ffprobe 检查）。 */
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const;

/** 只信任本应用渲染层。打包态不信任 Vite 默认地址。 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame) {
    return false;
  }
  return isTrustedFrameUrl(frame.url ?? '', {
    isPackaged: app.isPackaged,
    devServerUrl: process.env.LAIPIAN_DEV_SERVER_URL,
  });
}

/**
 * 通用注册：来源校验 → zod 参数校验 → 业务 handler → 异常兜底。
 * handler 返回值即为渲染层收到的 Result（或数据）。
 */
function registerHandler<S>(
  channel: IpcInvokeChannel,
  schema: z.ZodType<S>,
  handler: (params: S, event: IpcMainInvokeEvent) => Promise<unknown>,
): void {
  ipcMain.handle(channel, async (event, rawParams) => {
    if (!isTrustedSender(event)) {
      return err('INVALID_PARAMS', '不允许的调用来源。');
    }
    const parsed = schema.safeParse(rawParams);
    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message ?? '参数结构不符合契约';
      return err('INVALID_PARAMS', `参数校验失败：${detail}`);
    }
    try {
      return await handler(parsed.data, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err('INTERNAL', `内部错误：${message}`);
    }
  });
}

/** 兑换令牌；无效时返回统一错误，避免把 undefined 传给服务层。 */
function resolveToken(
  token: string,
  kind: FileSelectionKind,
): { ok: true; paths: string[] } | { ok: false } {
  const paths = consumeSelection(token, kind);
  return paths ? { ok: true, paths } : { ok: false };
}

/* ------------------------------------------------------------------ */
/* 文件选择入口（真实实现）                                                */
/* ------------------------------------------------------------------ */

async function showOpen(event: IpcMainInvokeEvent, options: OpenDialogOptions): Promise<string[]> {
  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}

async function pickVideoFile(
  _params: void,
  event: IpcMainInvokeEvent,
): Promise<Result<VideoPickResult | null>> {
  const paths = await showOpen(event, {
    title: '选择要分析的视频',
    filters: [{ name: '视频文件', extensions: [...VIDEO_EXTENSIONS] }],
    properties: ['openFile'],
  });
  if (paths.length === 0) {
    return ok(null); // 用户取消不算错误
  }
  const sourcePath = paths[0];
  if (sourcePath === undefined) {
    return ok(null);
  }
  const token = registerSelection('video-file', paths);
  // 附带元信息供新建弹窗预览：大小来自 stat（必然可读），时长/画面比例
  // 来自 ffprobe（best-effort，失败置 null，不阻断选择——导入时再完整探测）。
  let sizeBytes: number | null = null;
  try {
    sizeBytes = (await stat(sourcePath)).size;
  } catch {
    sizeBytes = null;
  }
  let durationMs: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  const probed = await probeFile(sourcePath);
  if (probed.ok) {
    durationMs = probed.data.durationMs;
    width = probed.data.width;
    height = probed.data.height;
  }
  return ok({
    token,
    fileName: path.basename(sourcePath),
    sizeBytes,
    durationMs,
    width,
    height,
  });
}

async function pickProjectDir(
  _params: void,
  event: IpcMainInvokeEvent,
): Promise<Result<FileSelectionToken | null>> {
  const paths = await showOpen(event, {
    title: '选择项目保存位置',
    message: '新的项目文件夹将创建在所选位置。',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (paths.length === 0) {
    return ok(null);
  }
  return ok(registerSelection('project-dir', paths));
}

async function pickOpenProjectFolder(
  _params: void,
  event: IpcMainInvokeEvent,
): Promise<Result<FileSelectionToken | null>> {
  const paths = await showOpen(event, {
    title: '打开项目文件夹',
    message: '选择包含 project.json 的项目文件夹。',
    properties: ['openDirectory'],
  });
  if (paths.length === 0) {
    return ok(null);
  }
  return ok(registerSelection('open-project-folder', paths));
}

/* ------------------------------------------------------------------ */
/* 通道 schema                                                          */
/* ------------------------------------------------------------------ */

const tokenSchema = z.string().min(1);
const projectIdSchema = z.object({ projectId: z.string().min(1) });


const createSchema = z.object({
  sourceSelectionToken: tokenSchema,
  name: z.string().min(1).max(200),
  destinationSelectionToken: tokenSchema,
  allowDuplicate: z.boolean().optional(),
});

const checkDuplicateSchema = z.object({
  fileName: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

const openSchema = z.object({ projectSelectionToken: tokenSchema });

const renameSchema = z.object({ projectId: z.string().min(1), name: z.string().min(1).max(200) });

const saveSchema = z.object({
  projectId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  snapshot: projectSnapshotSchema,
});

const restoreBackupSchema = z.object({
  projectId: z.string().min(1),
  backupId: z.string().min(1),
});

const cancelTaskSchema = z.object({ taskId: z.string().min(1) });

const restoreRecoverySchema = z.object({
  projectId: z.string().min(1),
  pendingId: z.string().min(1),
});

const relocateSchema = z.object({
  projectId: z.string().min(1),
  sourceSelectionToken: tokenSchema,
});

const framePreviewSchema = z.object({
  projectId: z.string().min(1),
  timeMs: z.number().finite(),
  width: z.number().finite().positive().optional(),
  height: z.number().finite().positive().optional(),
});

/** 时间线画面帧带批处理：范围 + 帧数 + 尺寸。 */
const filmstripSchema = z.object({
  projectId: z.string().min(1),
  startMs: z.number().finite().nonnegative(),
  endMs: z.number().finite().nonnegative(),
  count: z.number().int().min(1).max(240),
  width: z.number().int().min(16).max(1280),
  height: z.number().int().min(16).max(1280),
});

const exportSaveSchema = z.object({
  suggestedName: z.string().min(1).max(200),
  type: z.enum(['png', 'markdown']),
  // PNG payload 为 data URL，Markdown 为文本；上限 30MB 足够（规格 12.4 不做大文件 Base64 往返）。
  payload: z.string().min(1).max(30_000_000),
});

/* 导出中心（规格 13 重设计）：标准导出与专业自定义共用同一请求结构。 */
const exportKindSchema = z.enum(['pdf', 'xlsx', 'png', 'json', 'markdown']);
const exportScopeSchema = z.object({
  kind: z.enum(['project', 'chapter', 'section', 'shots', 'timeRange']),
  nodeIds: z.array(z.string().min(1)).max(5000).optional(),
  startMs: z.number().finite().nonnegative().optional(),
  endMs: z.number().finite().nonnegative().optional(),
});
const exportModuleSchema = z.enum([
  'projectInfo',
  'rhythmCurve',
  'outline',
  'shotTable',
  'curveNodes',
  'annotations',
  'notes',
  'statistics',
]);
const exportFieldSchema = z.enum([
  'index',
  'frame',
  'chapterName',
  'sectionName',
  'shotName',
  'startTime',
  'endTime',
  'duration',
  'curveStart',
  'curvePeak',
  'curveEnd',
  'annotationSummary',
  'note',
]);
const exportFrameSchema = z.object({
  includeShotFrame: z.boolean(),
  framePosition: z.enum(['cover', 'first', 'middle', 'last']),
  includeAnnotationFrames: z.boolean(),
  includeCurveNodeFrames: z.boolean(),
  quality: z.enum(['standard', 'high', 'max']),
  maxWidth: z.number().finite().nonnegative(),
});
const exportTableSchema = z.object({ fields: z.array(exportFieldSchema).min(1).max(20) });
const exportLayoutSchema = z.object({
  template: z.enum(['table', 'gallery', 'compact']),
  orientation: z.enum(['portrait', 'landscape']),
  showHeader: z.boolean(),
  showPageNumber: z.boolean(),
  showProjectName: z.boolean(),
});
const exportRequestSchema = z.object({
  projectId: z.string().min(1),
  snapshot: projectSnapshotSchema,
  kinds: z.array(exportKindSchema).min(1).max(5),
  scope: exportScopeSchema,
  modules: z.array(exportModuleSchema).min(1).max(8),
  frames: exportFrameSchema,
  table: exportTableSchema,
  layout: exportLayoutSchema,
  zip: z.boolean(),
  suggestedName: z.string().min(1).max(200),
});

const exportProductsSchema = z.object({ taskId: z.string().min(1) });
const exportIdSchema = z.object({ id: z.string().uuid() });

const settingsSetSchema = z.object({
  settings: z.object({
    keymap: z.record(z.string(), z.string()),
    // 导出模板结构由 settings-service 再次清洗（不信任渲染层输入）。
    exportTemplates: z.array(z.unknown()).max(50).optional(),
  }),
});

const detectShotsSchema = z.object({
  projectId: z.string().min(1),
  threshold: z.number().finite().positive(),
  minShotMs: z.number().finite().nonnegative(),
});

const shotRangeSchema = z.object({
  projectId: z.string().min(1),
  threshold: z.number().finite().positive(),
  minShotMs: z.number().finite().nonnegative(),
  inMs: z.number().finite().nonnegative(),
  outMs: z.number().finite().positive(),
});

/* ------------------------------------------------------------------ */
/* 入口                                                                  */
/* ------------------------------------------------------------------ */

export function registerIpcHandlers(deps: IpcDeps): void {
  const { projects, tasks, exports, settings, updates } = deps;

  registerHandler(IPC_CHANNELS.appConfirmClose, z.void(), async (_params, event) => {
    deps.allowWindowClose(event);
    return ok(null);
  });

  /* 自动更新（公开更新源）：只暴露状态、手动检查与用户确认后的重启安装。 */
  registerHandler(IPC_CHANNELS.updateGetState, z.void(), async () => ok(updates.getState()));

  registerHandler(IPC_CHANNELS.updateCheck, z.void(), async () => {
    updates.check(true);
    return ok(null);
  });

  registerHandler(IPC_CHANNELS.updateInstall, z.void(), async () => {
    updates.install();
    return ok(null);
  });

  /* 文件选择 */
  registerHandler(IPC_CHANNELS.dialogPickVideoFile, z.void(), pickVideoFile);
  registerHandler(IPC_CHANNELS.dialogPickProjectDir, z.void(), pickProjectDir);
  registerHandler(IPC_CHANNELS.dialogPickOpenProjectFolder, z.void(), pickOpenProjectFolder);

  /* 项目 */
  registerHandler(IPC_CHANNELS.projectsListRecent, z.void(), async () => projects.listRecent());

  registerHandler(IPC_CHANNELS.projectsCreate, createSchema, async (params) => {
    const source = resolveToken(params.sourceSelectionToken, 'video-file');
    if (!source.ok) {
      return err('INVALID_TOKEN', '视频选择令牌无效或已过期，请重新选择视频。');
    }
    const dest = resolveToken(params.destinationSelectionToken, 'project-dir');
    if (!dest.ok) {
      return err('INVALID_TOKEN', '保存位置令牌无效或已过期，请重新选择位置。');
    }
    const sourcePath = source.paths[0];
    const destinationDir = dest.paths[0];
    if (sourcePath === undefined || destinationDir === undefined) {
      return err('INVALID_TOKEN', '令牌未包含有效路径。');
    }
    return projects.createProject({
      sourcePath,
      destinationDir,
      name: params.name,
      ...(params.allowDuplicate === true ? { allowDuplicate: true } : {}),
    });
  });

  registerHandler(IPC_CHANNELS.projectsCheckDuplicate, checkDuplicateSchema, async (params) =>
    projects.findDuplicate({ originalName: params.fileName, sizeBytes: params.sizeBytes }),
  );

  registerHandler(IPC_CHANNELS.projectsOpen, openSchema, async (params) => {
    const folder = resolveToken(params.projectSelectionToken, 'open-project-folder');
    if (!folder.ok) {
      return err('INVALID_TOKEN', '项目文件夹令牌无效或已过期，请重新选择。');
    }
    const target = folder.paths[0];
    if (target === undefined) {
      return err('INVALID_TOKEN', '令牌未包含有效路径。');
    }
    return projects.openProjectFolder(target);
  });

  registerHandler(IPC_CHANNELS.projectsOpenRecent, projectIdSchema, async (params) =>
    projects.openRecent(params.projectId),
  );

  registerHandler(IPC_CHANNELS.projectsRename, renameSchema, async (params) =>
    projects.renameProject({ projectId: params.projectId, name: params.name }),
  );

  registerHandler(IPC_CHANNELS.projectsSave, saveSchema, async (params) =>
    projects.saveProject({
      projectId: params.projectId,
      expectedRevision: params.expectedRevision,
      snapshot: params.snapshot,
    }),
  );

  registerHandler(IPC_CHANNELS.projectsListBackups, projectIdSchema, async (params) =>
    projects.listBackups({ projectId: params.projectId }),
  );

  registerHandler(IPC_CHANNELS.projectsRestoreBackup, restoreBackupSchema, async (params) =>
    projects.restoreBackup({ projectId: params.projectId, backupId: params.backupId }),
  );

  registerHandler(IPC_CHANNELS.projectsRestoreRecovery, restoreRecoverySchema, async (params) =>
    projects.restoreRecovery({ projectId: params.projectId, pendingId: params.pendingId }),
  );

  registerHandler(IPC_CHANNELS.projectsDiscardRecovery, restoreRecoverySchema, async (params) =>
    projects.discardRecovery({ projectId: params.projectId, pendingId: params.pendingId }),
  );

  registerHandler(IPC_CHANNELS.projectsRemoveRecent, projectIdSchema, async (params) =>
    projects.removeRecent(params.projectId),
  );

  registerHandler(IPC_CHANNELS.projectsReveal, projectIdSchema, async (params) =>
    projects.revealProject(params.projectId),
  );

  registerHandler(IPC_CHANNELS.projectsClose, projectIdSchema, async (params) => {
    // 离开项目：取消该项目所有时间线抽帧任务并释放（本轮性能要求）。
    cancelProjectFrames(params.projectId);
    await projects.closeProject(params.projectId);
    return ok(null);
  });

  /* 任务 */
  registerHandler(IPC_CHANNELS.tasksSnapshot, projectIdSchema, async (params) =>
    ok(tasks.snapshotForProject(params.projectId)),
  );

  registerHandler(IPC_CHANNELS.tasksCancel, cancelTaskSchema, async (params) => {
    tasks.cancel(params.taskId);
    // 幂等：任务已结束或不存在同样视为“已不再运行”，返回成功。
    return ok(null);
  });

  /* 素材（阶段 D：真实兼容副本 / 探测 / 缩略图 / 重新定位） */
  registerHandler(IPC_CHANNELS.mediaCreateCompatibleCopy, projectIdSchema, async (params) => {
    const context = projects.mediaContext(params.projectId);
    if (context === null) {
      return err('PROJECT_NOT_OPEN', '项目未打开，无法生成兼容副本。');
    }
    const targetPath = path.join(context.folder, 'media', 'playback.webm');
    const { taskId } = tasks.startTask({ kind: 'convert', projectId: params.projectId }, async (ctx) => {
      const converted = await createCompatibleCopy({
        sourceAbsPath: context.sourceAbsPath,
        targetPath,
        media: context.media,
        cancelSignal: ctx.signal,
        onProgress: (step) => ctx.reportStep(step),
      });
      if (!converted.ok) {
        return converted;
      }
      // 转换成功后登记为播放来源（写回 playbackPath，升 revision）。
      const registered = await projects.setPlaybackSource({
        projectId: params.projectId,
        relativePath: 'media/playback.webm',
      });
      if (!registered.ok) {
        return registered;
      }
      return ok({ path: converted.data.path });
    });
    return ok({ taskId });
  });

  // 缩略图不再在打开项目时自动全量生成（本轮性能要求）：时间线走按需抽帧队列；
// 需要时由用户显式触发 media.rebuildThumbnails 手动入口。

  registerHandler(IPC_CHANNELS.mediaRebuildThumbnails, projectIdSchema, async (params) => {
    const context = projects.mediaContext(params.projectId);
    if (context === null) {
      return err('PROJECT_NOT_OPEN', '项目未打开，无法生成缩略图。');
    }
    // 后台任务：立即返回 taskId，进度经 tasks 事件推送（规格 10.4 / 10.3）。
    const { taskId } = tasks.startTask({ kind: 'thumbnails', projectId: params.projectId }, (ctx) =>
      generateThumbnails({
        sourceAbsPath: context.sourceAbsPath,
        projectFolder: context.folder,
        durationMs: context.durationMs,
        sha256: context.sha256,
        cancelSignal: ctx.signal,
        onProgress: (completed, total) => ctx.report({ kind: 'step', step: `生成缩略图 ${completed}/${total}` }),
      }),
    );
    return ok({ taskId });
  });

  registerHandler(IPC_CHANNELS.mediaListThumbnails, projectIdSchema, async (params) => {
    const context = projects.mediaContext(params.projectId);
    if (context === null) {
      return err('PROJECT_NOT_OPEN', '项目未打开，无法读取时间线缩略图。');
    }
    // 本轮性能要求：打开项目不再自动全量生成整条视频的缩略图。
    // 时间线画面由"应用级抽帧队列"按可视范围按需抽取；缩略图仅在用户显式
    // 触发 media.rebuildThumbnails 时生成。此处只读已有缓存（可为空）。
    const entries = await listThumbnailEntries(context.folder, context.durationMs);
    const thumbnails: TimelineThumbnail[] = entries.map((entry) => ({
      timeMs: entry.timeMs,
      mediaUrl: buildMediaUrl(
        params.projectId,
        context.media.id,
        'thumb',
        context.sha256,
        entry.name,
      ),
      width: THUMB_WIDTH,
      height: THUMB_HEIGHT,
    }));
    return ok(thumbnails);
  });

  registerHandler(IPC_CHANNELS.mediaGetFramePreview, framePreviewSchema, async (params) => {
    const context = projects.mediaContext(params.projectId);
    if (context === null) {
      return err('PROJECT_NOT_OPEN', '项目未打开，无法读取画面帧。');
    }
    return getFramePreview({
      projectId: params.projectId,
      projectFolder: context.folder,
      sourceAbsPath: context.sourceAbsPath,
      media: context.media,
      timeMs: params.timeMs,
      width: params.width,
      height: params.height,
    });
  });

  // 时间线画面帧带：应用级队列批处理（全局并发 2、去重、取消即终止）。
  registerHandler(IPC_CHANNELS.mediaFilmstrip, filmstripSchema, async (params) => {
    const context = projects.mediaContext(params.projectId);
    if (context === null) {
      return err('PROJECT_NOT_OPEN', '项目未打开，无法抽取时间线画面。');
    }
    return requestFilmstripBatch({
      projectId: params.projectId,
      projectFolder: context.folder,
      sourceAbsPath: context.sourceAbsPath,
      media: context.media,
      startMs: params.startMs,
      endMs: params.endMs,
      count: params.count,
      width: params.width,
      height: params.height,
    });
  });

  registerHandler(IPC_CHANNELS.mediaCancelFilmstrip, projectIdSchema, async (params) => {
    cancelProjectFrames(params.projectId);
    return ok(null);
  });

  registerHandler(IPC_CHANNELS.mediaDetectShots, detectShotsSchema, async (params) => {
    const context = projects.mediaContext(params.projectId);
    if (context === null) {
      return err('PROJECT_NOT_OPEN', '项目未打开，无法识别镜头。');
    }
    // 后台任务：立即返回 taskId，进度与终态经任务事件推送（可取消）。
    const { taskId } = tasks.startTask(
      { kind: 'shot-detect', projectId: params.projectId, initialStep: '正在识别镜头' },
      (ctx) =>
        detectShots({
          projectFolder: context.folder,
          sourceAbsPath: context.sourceAbsPath,
          media: context.media,
          threshold: params.threshold,
          minShotMs: params.minShotMs,
          cancelSignal: ctx.signal,
          onProgress: (timeMs) =>
            ctx.report({
              kind: 'step',
              step: `识别中 ${(timeMs / 1000).toFixed(0)}s / ${(context.durationMs / 1000).toFixed(0)}s`,
            }),
        }),
    );
    return ok({ taskId });
  });

  registerHandler(IPC_CHANNELS.mediaReadDetectedCuts, detectShotsSchema, async (params) => {
    const context = projects.mediaContext(params.projectId);
    if (context === null) {
      return err('PROJECT_NOT_OPEN', '项目未打开，无法读取镜头识别结果。');
    }
    const cuts = await readCachedCuts(
      context.folder,
      context.sha256,
      params.threshold,
      params.minShotMs,
    );
    return ok(cuts);
  });

  registerHandler(IPC_CHANNELS.mediaDetectShotsRange, shotRangeSchema, async (params) => {
    const context = projects.mediaContext(params.projectId);
    if (context === null) {
      return err('PROJECT_NOT_OPEN', '项目未打开，无法识别镜头。');
    }
    const inMs = Math.min(params.inMs, context.durationMs);
    const outMs = Math.min(Math.max(params.outMs, inMs + 1), context.durationMs);
    const { taskId } = tasks.startTask(
      { kind: 'shot-detect', projectId: params.projectId, initialStep: '正在分析选中区域' },
      (ctx) =>
        detectShotsRange({
          sourceAbsPath: context.sourceAbsPath,
          threshold: params.threshold,
          minShotMs: params.minShotMs,
          inMs,
          outMs,
          projectFolder: context.folder,
          sha256: context.sha256,
          cancelSignal: ctx.signal,
          onProgress: (timeMs) =>
            ctx.report({
              kind: 'step',
              step: `分析中 ${(timeMs / 1000).toFixed(0)}s / ${(outMs / 1000).toFixed(0)}s`,
            }),
        }),
    );
    return ok({ taskId });
  });

  registerHandler(IPC_CHANNELS.mediaReadDetectedCutsRange, shotRangeSchema, async (params) => {
    const context = projects.mediaContext(params.projectId);
    if (context === null) {
      return err('PROJECT_NOT_OPEN', '项目未打开，无法读取镜头识别结果。');
    }
    const cuts = await readCachedRangeCuts(
      context.folder,
      context.sha256,
      params.threshold,
      params.minShotMs,
      params.inMs,
      params.outMs,
    );
    return ok(cuts);
  });

  registerHandler(IPC_CHANNELS.mediaProbe, projectIdSchema, async (params) => {
    const context = projects.mediaContext(params.projectId);
    if (context === null) {
      return err('PROJECT_NOT_OPEN', '项目未打开，无法重新探测素材。');
    }
    const probe = await probeFile(context.sourceAbsPath);
    if (!probe.ok) {
      return probe;
    }
    return ok({
      ...context.media,
      durationMs: probe.data.durationMs,
      width: probe.data.width,
      height: probe.data.height,
      videoCodec: probe.data.videoCodec,
      audioCodec: probe.data.audioCodec,
      avgFrameRate: probe.data.avgFrameRate,
      isVfr: probe.data.isVfr,
      isHdr: probe.data.isHdr,
      sizeBytes: probe.data.sizeBytes > 0 ? probe.data.sizeBytes : context.media.sizeBytes,
    });
  });

  registerHandler(IPC_CHANNELS.mediaRelocateSource, relocateSchema, async (params) => {
    const token = resolveToken(params.sourceSelectionToken, 'video-file');
    if (!token.ok) {
      return err('INVALID_TOKEN', '素材选择令牌无效或已过期，请重新选择。');
    }
    const candidate = token.paths[0];
    if (candidate === undefined) {
      return err('INVALID_TOKEN', '令牌未包含有效路径。');
    }
    return projects.relocateSource({ projectId: params.projectId, candidatePath: candidate });
  });

  /* 导出（规格 13：原生保存对话框 + 原子写入，取消返回 null） */
  registerHandler(IPC_CHANNELS.exportsSave, exportSaveSchema, async (params) => exports.save(params));

  /* 导出中心：标准导出 / 专业自定义共用的后台导出任务 */
  registerHandler(IPC_CHANNELS.exportsStart, exportRequestSchema, async (params) => {
    const context = projects.mediaContext(params.projectId);
    if (context === null) {
      return err('PROJECT_NOT_OPEN', '项目未打开，无法导出。');
    }
    const chosen = await exports.chooseTarget({
      suggestedName: params.suggestedName,
      kinds: params.kinds,
      zip: params.zip,
    });
    if (!chosen.ok) {
      return chosen;
    }
    if (chosen.data === null) {
      return ok(null); // 用户在保存对话框取消。
    }
    const target = chosen.data;
    const request = params as ExportRequest;
    const { taskId, done } = tasks.startTask(
      { kind: 'export', projectId: params.projectId, initialStep: '准备导出' },
      (ctx) => runExport({ request, target, media: context, ctx }),
    );
    void done.then((result) => {
      if (result.ok) {
        exports.remember(taskId, result.data);
      }
    });
    return ok({ taskId });
  });

  registerHandler(IPC_CHANNELS.exportsProducts, exportProductsSchema, async (params) =>
    ok(exports.products(params.taskId)),
  );

  registerHandler(IPC_CHANNELS.exportsReveal, exportIdSchema, async (params) =>
    exports.reveal(params.id),
  );

  registerHandler(IPC_CHANNELS.exportsOpen, exportIdSchema, async (params) =>
    exports.open(params.id),
  );

  /* 应用设置（v1.1 快捷键自定义，全局） */
  registerHandler(IPC_CHANNELS.settingsGet, z.void(), async () => ok(await settings.read()));
  registerHandler(IPC_CHANNELS.settingsSet, settingsSetSchema, async (params) =>
    ok(await settings.write(params.settings as AppSettings)),
  );
}
