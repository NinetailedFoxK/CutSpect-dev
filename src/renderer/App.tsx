import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LaipianError,
  OpenedProject,
  ProjectSnapshot,
  ProjectSummary,
  ProjectView,
} from '@shared/api-types';
import { createHistory } from '@shared/history';
import type { History } from '@shared/history';
import { Home } from './pages/Home';
import { ImportPage } from './pages/ImportPage';
import { Editor } from './pages/Editor';
import type { ProjectContentPatch, SaveState } from './pages/Editor';
import { useRecentProjects } from './hooks/useRecentProjects';
import type { NewProjectCreatedInfo, ImportSourceMeta } from './components/NewProjectDialog';
import { FeedbackHost } from './components/FeedbackHost';
import { TooltipHost } from './components/TooltipHost';
import { TaskCenter } from './components/TaskCenter';
import { feedbackStore, taskCenterStore } from './feedback/instance';
import { createSaveCoordinator } from './editor/save-coordinator';
import type { SaveCoordinator } from './editor/save-coordinator';
import { currentAdapter } from '../platform/common';

const PLATFORM = currentAdapter();

/**
 * 应用外壳与页面状态机（阶段 A 闭环 + 阶段 B 曲线编辑）。
 *
 *   'home'      → 项目库（规格 2.2）
 *   'importing' → 新建项目后的导入状态页（规格 2.4）
 *   'opening'   → 正在打开项目（读取快照）的过渡态
 *   'editor'    → 分析工作台（规格 2.5），挂载 Editor 并驱动内容历史与保存
 *
 * 状态分层（规格 12.3）：
 * - 内容（曲线/标注/分段/曲线名）经 history 管理，进历史并保存；
 * - 视图（图层/缩放/播放位置）不进历史，但保存；
 * - 撤销/重做后以当前视图覆盖（视图不被撤销牵连）。
 */

type AppStage =
  | { page: 'home' }
  | {
      page: 'importing';
      project: { projectId: string; projectName: string };
      /** 源视频元信息，供导入页预览（规格 2 步骤 2）。 */
      source: ImportSourceMeta | null;
    }
  | { page: 'opening'; projectName: string }
  | { page: 'editor'; opened: OpenedProject };

/** 工作台宿主：持有快照、内容历史与 revision，驱动防抖保存（规格 8.1/8.2）。 */
function EditorHost({ opened, onExit }: { opened: OpenedProject; onExit: () => void }) {
  const [snapshot, setSnapshot] = useState(opened.snapshot);
  const [saveStatus, setSaveStatus] = useState<SaveState>('saved');
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const viewRef = useRef<ProjectView>(opened.snapshot.view);
  const revisionRef = useRef(opened.snapshot.revision);
  const timerRef = useRef<number | null>(null);
  const saveQueueRef = useRef<SaveCoordinator | null>(null);
  const historyRef = useRef<History<ProjectSnapshot> | null>(null);
  if (historyRef.current === null) {
    historyRef.current = createHistory(opened.snapshot, { limit: 100 });
  }
  // 撤销/重做会改变历史栈可用性，用一次强制重渲染刷新按钮可用态。
  const [, forceRender] = useState(0);

  // 恢复快照（规格 8.4）：打开时检测到的更新未提交版本。
  const [recovery, setRecovery] = useState(opened.recovery);
  // 保存信任（规格 10）：最近一次失败原因与最近成功保存时间。
  const [saveError, setSaveError] = useState<LaipianError | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const saveErrorRef = useRef<LaipianError | null>(null);
  const saveBannerRef = useRef<string | null>(null);

  const applySnapshot = useCallback((next: ProjectSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  if (saveQueueRef.current === null) {
    saveQueueRef.current = createSaveCoordinator<ProjectSnapshot>({
      initialRevision: opened.snapshot.revision,
      readLatest: () => ({ ...snapshotRef.current, view: viewRef.current }),
      write: async (payload, expectedRevision) => {
        const api = window.laipian;
        if (!api) return { ok: true, data: { revision: expectedRevision } };
        return api.projects.save({ projectId: payload.id, expectedRevision, snapshot: payload });
      },
      onState: setSaveStatus,
      onRevision: (revision) => {
        const next = { ...snapshotRef.current, revision };
        snapshotRef.current = next;
        setSnapshot(next);
        revisionRef.current = revision;
      },
      onError: (error) => {
        setSaveError(error);
        saveErrorRef.current = error;
        // 失败即提示（顶栏同时显示），并给出下一步：重试或在系统文件管理器中检查目录。
        if (saveBannerRef.current === null) {
          saveBannerRef.current = feedbackStore.showBanner({
            kind: 'error',
            title: '保存失败',
            message: error.message,
            diagnostics: `code=${error.code}`,
            actions: [
              { label: '重试保存', primary: true, run: () => void flushSave() },
              {
                label: `在${PLATFORM.fileManagerName}中检查目录`,
                run: () => void window.laipian?.projects.reveal({ projectId: opened.snapshot.id }),
              },
            ],
          });
        }
      },
      onSaved: (at) => {
        setLastSavedAt(at);
        if (saveErrorRef.current !== null) {
          saveErrorRef.current = null;
          setSaveError(null);
        }
        // 保存成功后收起失败横幅（避免显示"失败"却已恢复）。
        if (saveBannerRef.current !== null) {
          feedbackStore.clearBanner();
          saveBannerRef.current = null;
        }
      },
    });
  }

  const handleRestoreRecovery = useCallback(async () => {
    const api = window.laipian;
    if (!api || recovery === null) {
      return;
    }
    const result = await api.projects.restoreRecovery({
      projectId: opened.snapshot.id,
      pendingId: recovery.pendingId,
    });
    if (result.ok) {
      const next = { ...result.data, view: viewRef.current };
      revisionRef.current = result.data.revision;
      saveQueueRef.current?.reset(result.data.revision);
      historyRef.current?.reset(next);
      applySnapshot(next);
      setRecovery(null);
      setSaveStatus('saved');
      forceRender((tick) => tick + 1);
    } else {
      setSaveStatus('error');
    }
  }, [recovery, opened.snapshot.id, applySnapshot]);

  const handleDiscardRecovery = useCallback(async () => {
    const api = window.laipian;
    if (!api || recovery === null) {
      return;
    }
    await api.projects.discardRecovery({
      projectId: opened.snapshot.id,
      pendingId: recovery.pendingId,
    });
    setRecovery(null);
  }, [recovery, opened.snapshot.id]);

  const flushSave = useCallback(async (): Promise<boolean> => {
    return saveQueueRef.current?.flush() ?? true;
  }, []);

  const scheduleSave = useCallback(() => {
    saveQueueRef.current?.markDirty();
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void flushSave();
    }, 1000);
  }, [flushSave]);

  const handleViewChange = useCallback(
    (view: ProjectView) => {
      viewRef.current = view;
      applySnapshot({ ...snapshotRef.current, view });
      scheduleSave();
    },
    [applySnapshot, scheduleSave],
  );

  const handleContentChange = useCallback(
    (patch: ProjectContentPatch, coalesceKey?: string) => {
      const history = historyRef.current;
      if (history === null) {
        return;
      }
      const next: ProjectSnapshot = { ...snapshotRef.current, ...patch };
      history.commit(next, coalesceKey !== undefined ? { coalesceKey } : {});
      applySnapshot({ ...history.present(), view: viewRef.current });
      forceRender((tick) => tick + 1);
      scheduleSave();
    },
    [applySnapshot, scheduleSave],
  );

  const handleUndo = useCallback(() => {
    const history = historyRef.current;
    if (history === null) {
      return;
    }
    const prev = history.undo();
    if (prev !== null) {
      // 视图不被撤销牵连：以当前视图覆盖恢复出的内容。
      applySnapshot({ ...prev, view: viewRef.current });
      forceRender((tick) => tick + 1);
      scheduleSave();
    }
  }, [applySnapshot, scheduleSave]);

  const handleRedo = useCallback(() => {
    const history = historyRef.current;
    if (history === null) {
      return;
    }
    const next = history.redo();
    if (next !== null) {
      applySnapshot({ ...next, view: viewRef.current });
      forceRender((tick) => tick + 1);
      scheduleSave();
    }
  }, [applySnapshot, scheduleSave]);

  /** 保存失败导致退出被阻止：给出明确提示与下一步（规格 10）。 */
  const showSaveBlockedBanner = useCallback(() => {
    saveBannerRef.current = feedbackStore.showBanner({
      kind: 'error',
      title: '保存未完成，已阻止退出',
      message: saveErrorRef.current?.message ?? '保存失败，请重试后再退出，避免丢失修改。',
      ...(saveErrorRef.current !== null
        ? { diagnostics: `code=${saveErrorRef.current.code}` }
        : {}),
      actions: [
        { label: '重试保存', primary: true, run: () => void flushSave() },
        {
          label: '留在编辑器',
          run: () => {
            feedbackStore.clearBanner();
            saveBannerRef.current = null;
          },
        },
      ],
    });
  }, [flushSave]);

  const handleExit = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const saved = await flushSave();
    if (!saved) {
      showSaveBlockedBanner();
      return;
    }
    const api = window.laipian;
    // 释放项目锁与媒体注册（规格 8.4 / 8.5）。
    await api?.projects.close({ projectId: opened.snapshot.id });
    onExit();
  }, [flushSave, onExit, opened.snapshot.id, showSaveBlockedBanner]);

  useEffect(() => {
    const api = window.laipian;
    if (!api) return undefined;
    return api.app.onCloseRequested(() => {
      void (async () => {
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const saved = await flushSave();
        if (!saved) {
          showSaveBlockedBanner();
          return;
        }
        await api.projects.close({ projectId: opened.snapshot.id });
        await api.app.confirmClose();
      })();
    });
  }, [flushSave, opened.snapshot.id, showSaveBlockedBanner]);

  const history = historyRef.current;
  return (
    <Editor
      snapshot={snapshot}
      mediaSrc={opened.mediaUrl ?? ''}
      onClose={() => void handleExit()}
      onViewChange={handleViewChange}
      onContentChange={handleContentChange}
      canUndo={history.canUndo()}
      canRedo={history.canRedo()}
      onUndo={handleUndo}
      onRedo={handleRedo}
      onSaveRequested={async () => {
        await flushSave();
      }}
      saveStatus={saveStatus}
      saveError={saveError}
      lastSavedAt={lastSavedAt}
      onRetrySave={() => void flushSave()}
      recovery={recovery}
      onRestoreRecovery={() => void handleRestoreRecovery()}
      onDiscardRecovery={() => void handleDiscardRecovery()}
    />
  );
}

export function App() {
  const hasElectronApi = typeof window !== 'undefined' && window.laipian !== undefined;
  const [stage, setStage] = useState<AppStage>({ page: 'home' });
  /** 递增计数：Home 监听变化后打开新建弹窗（导入失败"重新导入"用）。 */
  const [createRequest, setCreateRequest] = useState(0);
  const recent = useRecentProjects();
  const stageRef = useRef(stage);
  stageRef.current = stage;

  useEffect(() => {
    const api = window.laipian;
    if (!api) return undefined;
    return api.app.onCloseRequested(() => {
      if (stageRef.current.page !== 'editor') {
        void api.app.confirmClose();
      }
    });
  }, []);

  // 全局后台任务订阅：任务中心跨页面展示所有项目的进度/结果（规格 11）。
  useEffect(() => {
    const api = window.laipian;
    if (!api) return undefined;
    return taskCenterStore.attachSource(api.tasks);
  }, []);

  const openProjectById = useCallback(
    async (projectId: string, projectName: string): Promise<void> => {
      const api = window.laipian;
      if (!api) {
        setStage({ page: 'home' });
        return;
      }
      setStage({ page: 'opening', projectName });
      const result = await api.projects.openRecent({ projectId });
      if (result.ok) {
        setStage({ page: 'editor', opened: result.data });
      } else {
        setStage({ page: 'home' });
        feedbackStore.showBanner({
          kind: 'error',
          title: '打开项目失败',
          message: result.error.message,
          actions: [
            {
              label: '重试',
              primary: true,
              run: () => void openProjectById(projectId, projectName),
            },
            { label: '关闭', run: () => feedbackStore.clearBanner() },
          ],
        });
      }
      recent.refresh();
    },
    [recent],
  );

  const handleProjectCreated = useCallback((info: NewProjectCreatedInfo) => {
    feedbackStore.clearBanner();
    setStage({
      page: 'importing',
      project: { projectId: info.projectId, projectName: info.projectName },
      source: info.source,
    });
  }, []);

  const handleProjectOpened = useCallback((opened: OpenedProject) => {
    setStage({ page: 'editor', opened });
  }, []);

  const handleImportComplete = useCallback(() => {
    const current = stageRef.current;
    if (current.page !== 'importing') {
      return;
    }
    // 异步取回快照（探测成功事件无参，使用当前导入项目的 id）。
    void openProjectById(current.project.projectId, current.project.projectName);
  }, [openProjectById]);

  const handleImportCancelled = useCallback(() => {
    setStage({ page: 'home' });
    recent.refresh();
  }, [recent]);

  /** 导入失败"重新导入"：返回项目库并重新打开新建弹窗（规格 2 失败处理）。 */
  const handleImportRetry = useCallback(() => {
    setStage({ page: 'home' });
    setCreateRequest((n) => n + 1);
    recent.refresh();
  }, [recent]);

  const backToHome = useCallback(() => {
    setStage({ page: 'home' });
    recent.refresh();
  }, [recent]);

  /** 素材缺失时重新定位：打开项目 → 选择文件 → 校验 SHA 后复制（规格 9.3）。 */
  const handleRelocateSource = useCallback(
    async (project: ProjectSummary) => {
      const api = window.laipian;
      if (!api) {
        return;
      }
      const opened = await api.projects.openRecent({ projectId: project.projectId });
      if (!opened.ok) {
        feedbackStore.showBanner({
          kind: 'error',
          title: '重新定位失败',
          message: opened.error.message,
          actions: [
            { label: '重试', primary: true, run: () => void handleRelocateSource(project) },
            { label: '关闭', run: () => feedbackStore.clearBanner() },
          ],
        });
        return;
      }
      const picked = await api.dialog.pickVideoFile();
      if (!picked.ok) {
        feedbackStore.showBanner({
          kind: 'error',
          title: '选择文件失败',
          message: picked.error.message,
          actions: [
            { label: '重试', primary: true, run: () => void handleRelocateSource(project) },
            { label: '关闭', run: () => feedbackStore.clearBanner() },
          ],
        });
        return;
      }
      if (picked.data === null) {
        return; // 用户取消。
      }
      const relocated = await api.media.relocateSource({
        projectId: project.projectId,
        sourceSelectionToken: picked.data.token,
      });
      await api.projects.close({ projectId: project.projectId });
      if (!relocated.ok) {
        feedbackStore.showBanner({
          kind: 'error',
          title: '重新定位失败',
          message: relocated.error.message,
          actions: [
            { label: '重新选择', primary: true, run: () => void handleRelocateSource(project) },
            { label: '关闭', run: () => feedbackStore.clearBanner() },
          ],
        });
        return;
      }
      feedbackStore.pushToast({ kind: 'success', message: '已找回同一素材，项目可正常播放。' });
      recent.refresh();
    },
    [recent],
  );

  /** 重新生成缩略图与封面（规格 10.3，后台任务）。 */
  const handleRebuildThumbnails = useCallback(
    async (project: ProjectSummary) => {
      const api = window.laipian;
      if (!api) {
        return;
      }
      const opened = await api.projects.openRecent({ projectId: project.projectId });
      if (!opened.ok) {
        feedbackStore.showBanner({
          kind: 'error',
          title: '重新生成缩略图失败',
          message: opened.error.message,
          actions: [{ label: '关闭', run: () => feedbackStore.clearBanner() }],
        });
        return;
      }
      const started = await api.media.rebuildThumbnails({ projectId: project.projectId });
      if (!started.ok) {
        await api.projects.close({ projectId: project.projectId });
        feedbackStore.showBanner({
          kind: 'error',
          title: '重新生成缩略图失败',
          message: started.error.message,
          actions: [
            { label: '重试', primary: true, run: () => void handleRebuildThumbnails(project) },
            { label: '关闭', run: () => feedbackStore.clearBanner() },
          ],
        });
        return;
      }
      // 后台任务：登记到任务中心（进度/取消/失败重试），不阻塞项目库。
      taskCenterStore.announce({
        taskId: started.data.taskId,
        label: `生成缩略图与封面 · ${project.name}`,
        retry: () => void handleRebuildThumbnails(project),
      });
      feedbackStore.pushToast({
        kind: 'info',
        message: '已开始生成缩略图与封面，可在右下角任务中心查看进度。',
      });
      await api.projects.close({ projectId: project.projectId });
      recent.refresh();
    },
    [recent],
  );

  return (
    <div className="app-shell">
      {!hasElectronApi && (
        <div className="browser-banner" role="status">
          浏览器预览模式（无 Electron API）——仅供 UI 开发，文件选择与项目功能不可用
        </div>
      )}


      {stage.page === 'home' && (
        <Home
          hasApi={hasElectronApi}
          recent={recent}
          canOpenProject={hasElectronApi}
          openProjectDisabledReason="需要桌面运行环境才能从最近列表打开项目"
          openCreateRequest={createRequest}
          onProjectCreated={handleProjectCreated}
          onProjectOpened={handleProjectOpened}
          onOpenProject={(project) => void openProjectById(project.projectId, project.name)}
          onRelocateSource={(project) => void handleRelocateSource(project)}
          onRebuildThumbnails={(project) => void handleRebuildThumbnails(project)}
        />
      )}

      {stage.page === 'importing' && (
        <ImportPage
          hasApi={hasElectronApi}
          project={stage.project}
          source={stage.source}
          onComplete={handleImportComplete}
          onCancelled={handleImportCancelled}
          onRetry={handleImportRetry}
        />
      )}

      {stage.page === 'opening' && (
        <div className="editor-loading" role="status">
          <div className="editor-loading-spinner" aria-hidden="true" />
          <h1>正在打开项目…</h1>
          <p className="editor-loading-project">项目「{stage.projectName}」</p>
        </div>
      )}

      {stage.page === 'editor' && <EditorHost opened={stage.opened} onExit={backToHome} />}

      <FeedbackHost />
      <TaskCenter />
      <TooltipHost />
    </div>
  );
}
