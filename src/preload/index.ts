import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { LaipianApi, TaskEvent } from '../shared/api-types';
import type { UpdateState } from '../shared/update';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { IpcInvokeChannel } from '../shared/ipc-channels';

/**
 * 预加载桥（规格 12.2 / 12.5）。
 *
 * 只暴露 shared/api-types.ts 定义的最小类型化接口（window.laipian）：
 * - invoke 通道经 ipcRenderer.invoke 转发，返回值原样透传（Result 形状保真）。
 * - tasks.subscribe 经 ipcRenderer.on 转发事件，返回退订函数。
 * - 不暴露 fs / shell / ipcRenderer 本体（contextIsolation + sandbox 下）。
 */

function invoke<T>(channel: IpcInvokeChannel, ...args: unknown[]): Promise<T> {
  // channel 常量来自 shared，参数形状由 LaipianApi 的方法签名在编译期约束。
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const api: LaipianApi = {
  app: {
    onCloseRequested(listener: () => void): () => void {
      const wrapped = (): void => listener();
      ipcRenderer.on(IPC_CHANNELS.appCloseRequested, wrapped);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.appCloseRequested, wrapped);
    },
    confirmClose: () => invoke(IPC_CHANNELS.appConfirmClose),
  },
  dialog: {
    pickVideoFile: () => invoke(IPC_CHANNELS.dialogPickVideoFile),
    pickProjectDir: () => invoke(IPC_CHANNELS.dialogPickProjectDir),
    pickOpenProjectFolder: () => invoke(IPC_CHANNELS.dialogPickOpenProjectFolder),
  },
  projects: {
    listRecent: () => invoke(IPC_CHANNELS.projectsListRecent),
    create: (params) => invoke(IPC_CHANNELS.projectsCreate, params),
    checkDuplicate: (params) => invoke(IPC_CHANNELS.projectsCheckDuplicate, params),
    open: (params) => invoke(IPC_CHANNELS.projectsOpen, params),
    openRecent: (params) => invoke(IPC_CHANNELS.projectsOpenRecent, params),
    rename: (params) => invoke(IPC_CHANNELS.projectsRename, params),
    save: (params) => invoke(IPC_CHANNELS.projectsSave, params),
    listBackups: (params) => invoke(IPC_CHANNELS.projectsListBackups, params),
    restoreBackup: (params) => invoke(IPC_CHANNELS.projectsRestoreBackup, params),
    restoreRecovery: (params) => invoke(IPC_CHANNELS.projectsRestoreRecovery, params),
    discardRecovery: (params) => invoke(IPC_CHANNELS.projectsDiscardRecovery, params),
    removeRecent: (params) => invoke(IPC_CHANNELS.projectsRemoveRecent, params),
    reveal: (params) => invoke(IPC_CHANNELS.projectsReveal, params),
    close: (params) => invoke(IPC_CHANNELS.projectsClose, params),
  },
  media: {
    probe: (params) => invoke(IPC_CHANNELS.mediaProbe, params),
    createCompatibleCopy: (params) => invoke(IPC_CHANNELS.mediaCreateCompatibleCopy, params),
    rebuildThumbnails: (params) => invoke(IPC_CHANNELS.mediaRebuildThumbnails, params),
    relocateSource: (params) => invoke(IPC_CHANNELS.mediaRelocateSource, params),
    listThumbnails: (params) => invoke(IPC_CHANNELS.mediaListThumbnails, params),
    getFramePreview: (params) => invoke(IPC_CHANNELS.mediaGetFramePreview, params),
    filmstrip: (params) => invoke(IPC_CHANNELS.mediaFilmstrip, params),
    cancelFilmstrip: (params) => invoke(IPC_CHANNELS.mediaCancelFilmstrip, params),
    detectShots: (params) => invoke(IPC_CHANNELS.mediaDetectShots, params),
    readDetectedCuts: (params) => invoke(IPC_CHANNELS.mediaReadDetectedCuts, params),
    detectShotsRange: (params) => invoke(IPC_CHANNELS.mediaDetectShotsRange, params),
    readDetectedCutsRange: (params) => invoke(IPC_CHANNELS.mediaReadDetectedCutsRange, params),
  },
  tasks: {
    subscribe(listener: (event: TaskEvent) => void): () => void {
      const wrapped = (_event: IpcRendererEvent, taskEvent: TaskEvent): void => {
        listener(taskEvent);
      };
      ipcRenderer.on(IPC_CHANNELS.taskEvent, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.taskEvent, wrapped);
      };
    },
    snapshot: (params) => invoke(IPC_CHANNELS.tasksSnapshot, params),
    cancel: (params) => invoke(IPC_CHANNELS.tasksCancel, params),
  },
  exports: {
    save: (params) => invoke(IPC_CHANNELS.exportsSave, params),
    start: (params) => invoke(IPC_CHANNELS.exportsStart, params),
    products: (params) => invoke(IPC_CHANNELS.exportsProducts, params),
    reveal: (params) => invoke(IPC_CHANNELS.exportsReveal, params),
    open: (params) => invoke(IPC_CHANNELS.exportsOpen, params),
  },
settings: {
    get: () => invoke(IPC_CHANNELS.settingsGet),
    set: (params) => invoke(IPC_CHANNELS.settingsSet, params),
  },
  updates: {
    getState: () => invoke(IPC_CHANNELS.updateGetState),
    check: () => invoke(IPC_CHANNELS.updateCheck),
    install: () => invoke(IPC_CHANNELS.updateInstall),
    subscribe(listener: (state: UpdateState) => void): () => void {
      const wrapped = (_event: IpcRendererEvent, state: UpdateState): void => {
        listener(state);
      };
      ipcRenderer.on(IPC_CHANNELS.updateEvent, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.updateEvent, wrapped);
      };
    },
  },
};

contextBridge.exposeInMainWorld('laipian', api);
