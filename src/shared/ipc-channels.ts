/**
 * IPC 通道名常量：preload（invoke/on 转发）与 main（ipcMain.handle/webContents.send）
 * 共用此表，避免字符串散落两边导致拼错后静默失败。
 *
 * 命名规则："<域>:<动作>"（kebab-case）。
 * taskEvent 是 main → renderer 的单向事件通道，不走 invoke。
 */
export const IPC_CHANNELS = {
  /* 文件选择（阶段 A 已真实实现） */
  dialogPickVideoFile: 'dialog:pick-video-file',
  dialogPickProjectDir: 'dialog:pick-project-dir',
  dialogPickOpenProjectFolder: 'dialog:pick-open-project-folder',

  /* 项目（阶段 A 已真实实现） */
  projectsListRecent: 'projects:list-recent',
  projectsCreate: 'projects:create',
  projectsCheckDuplicate: 'projects:check-duplicate',
  projectsOpen: 'projects:open',
  projectsOpenRecent: 'projects:open-recent',
  projectsRename: 'projects:rename',
  projectsSave: 'projects:save',
  projectsListBackups: 'projects:list-backups',
  projectsRestoreBackup: 'projects:restore-backup',
  projectsRestoreRecovery: 'projects:restore-recovery',
  projectsDiscardRecovery: 'projects:discard-recovery',
  projectsRemoveRecent: 'projects:remove-recent',
  projectsReveal: 'projects:reveal',
  projectsClose: 'projects:close',

  /* 素材（阶段 A 后半 / 阶段 D 实现） */
  mediaProbe: 'media:probe',
  mediaCreateCompatibleCopy: 'media:create-compatible-copy',
  mediaRebuildThumbnails: 'media:rebuild-thumbnails',
  mediaRelocateSource: 'media:relocate-source',
  mediaListThumbnails: 'media:list-thumbnails',
  mediaGetFramePreview: 'media:get-frame-preview',
  mediaFilmstrip: 'media:filmstrip',
  mediaCancelFilmstrip: 'media:cancel-filmstrip',
  mediaDetectShots: 'media:detect-shots',
  mediaReadDetectedCuts: 'media:read-detected-cuts',
  mediaDetectShotsRange: 'media:detect-shots-range',
  mediaReadDetectedCutsRange: 'media:read-detected-cuts-range',

  /* 任务 */
  tasksSnapshot: 'tasks:snapshot',
  tasksCancel: 'tasks:cancel',

  /* 导出（阶段 D 实现） */
  exportsSave: 'exports:save',
  exportsStart: 'exports:start',
  exportsProducts: 'exports:products',
  exportsReveal: 'exports:reveal',
  exportsOpen: 'exports:open',

  /* 应用设置（v1.1 快捷键自定义：全局键位） */
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  /* 应用窗口关闭：先让 renderer 刷新项目保存队列，再由 main 真正关闭。 */
  appConfirmClose: 'app:confirm-close',

  /* 自动更新（公开更新源；仅暴露状态，不含任何 Token / 私有地址） */
  updateGetState: 'update:get-state',
  updateCheck: 'update:check',
  updateInstall: 'update:install',

  /* main → renderer 单向事件：后台任务进度/状态/取消推送 */
  taskEvent: 'task:event',
  appCloseRequested: 'app:close-requested',
  updateEvent: 'update:event',
} as const;

/** 所有 invoke 型通道（可从通道名反查，用于注册表驱动）。 */
export type IpcInvokeChannel = Exclude<
  (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS],
  | typeof IPC_CHANNELS.taskEvent
  | typeof IPC_CHANNELS.appCloseRequested
  | typeof IPC_CHANNELS.updateEvent
>;

/** main → renderer 的事件通道。 */
export type IpcEventChannel =
  | typeof IPC_CHANNELS.taskEvent
  | typeof IPC_CHANNELS.appCloseRequested
  | typeof IPC_CHANNELS.updateEvent;
