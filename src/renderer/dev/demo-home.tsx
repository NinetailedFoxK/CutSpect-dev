/**
 * 【仅开发预览】dev-home.html 的挂载入口（A-T5 项目库 UI 开发脚手架）。
 *
 * - 用固定假数据渲染 Home 组件树（3 张卡片：ready / missing / pending-compatible），
 *   并提供“导入页浏览器静态预览”与“工作台中转态”两个演示视图；
 * - 通过注入 mock window.laipian 演示完整交互：搜索过滤、重命名（真实改数据）、
 *   从最近列表移除 + 5 秒撤销 toast、新建弹窗（mock 选择器返回对象形态
 *   { token, fileName }，演示“文件名显示 + 项目名自动带入”）；
 * - mock 的 pick* 返回值是 { token, fileName } 对象（运行时被 NewProjectDialog 的
 *   extractPickMeta 类型守卫识别）——这也是集成阶段 main 扩展 pick* 返回值的
 *   推荐契约形态；
 * - 本文件与 dev/ 目录不进入正式 App 路径（正式入口 index.html → main.tsx → App），
 *   集成阶段完成后删除本文件与 dev-home.html。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { err, ok } from '@shared/api-types';
import type {
  FileSelectionToken,
  LaipianApi,
  ProjectSummary,
  ProjectSnapshot,
  TaskEvent,
} from '@shared/api-types';
import { Home } from '../pages/Home';
import { ImportPage } from '../pages/ImportPage';
import type { NewProjectCreatedInfo } from '../components/NewProjectDialog';
import { FeedbackHost } from '../components/FeedbackHost';
import { TaskCenter } from '../components/TaskCenter';
import { feedbackStore, taskCenterStore } from '../feedback/instance';
import '../styles/tokens.css';
import '../styles.css';
import '../styles/graphite.css';

type DemoView = 'home' | 'import' | 'editor-loading' | 'feedback' | 'confirm';

/** 相对当前时间偏移的 ISO 时间（演示“最近编辑”排序与相对显示）。 */
function isoAgo(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

/** 固定假数据：三种状态各一张卡片（coverMediaUrl 均为 null → 深色占位图块）。 */
const DEMO_PROJECTS: ProjectSummary[] = [
  {
    projectId: 'demo-uuid-ready',
    name: '广告成片 · 情绪节奏分析',
    sourceOriginalName: '广告成片_v3.mov',
    durationMs: 183_400,
    lastEditedAt: isoAgo(35 * 60_000),
    status: 'ready',
    coverMediaUrl: null,
  },
  {
    projectId: 'demo-uuid-pending',
    name: '纪录片片段 · 信息密度',
    sourceOriginalName: '纪录片_片段02.mkv',
    durationMs: 654_000,
    lastEditedAt: isoAgo(5 * 3_600_000),
    status: 'pending-compatible',
    coverMediaUrl: null,
  },
  {
    projectId: 'demo-uuid-missing',
    name: '旧素材参考',
    sourceOriginalName: '旧素材.mp4',
    durationMs: null,
    lastEditedAt: isoAgo(12 * 24 * 3_600_000),
    status: 'missing',
    coverMediaUrl: null,
  },
];

/** create / open mock 返回的最小合法快照（结构与 tests/smoke.test.ts 保持一致）。 */
const DEMO_SNAPSHOT: ProjectSnapshot = {
  schemaVersion: 1,
  id: 'demo-snapshot-id',
  name: '演示项目',
  revision: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  media: {
    id: 'demo-media-id',
    originalName: '开场30秒_成片_v2.mp4',
    sourcePath: 'media/source.mp4',
    playbackPath: null,
    sha256: 'a'.repeat(64),
    sizeBytes: 314_572_800,
    durationMs: 183_400,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    audioCodec: 'aac',
    avgFrameRate: { num: 30000, den: 1001 },
    isVfr: false,
    isHdr: false,
  },
  curve: {
    id: 'demo-curve-id',
    name: '情绪强度',
    color: '#F04B50',
    nodes: [
      { id: 'node-start', timeMs: 0, value: 50, outMode: 'auto', inHandle: null, outHandle: null },
      { id: 'node-end', timeMs: 183_400, value: 50, outMode: 'auto', inHandle: null, outHandle: null },
    ],
  },
  annotations: [],
  boundaries: [
    { id: 'start', timeMs: 0, fixed: true, locked: true },
    { id: 'end', timeMs: 183_400, fixed: true, locked: true },
  ],
  sections: [{ id: 'demo-section-id', startBoundaryId: 'start', name: '段落 1', note: '' }],
  view: {
    playheadMs: 0,
    viewStartMs: 0,
    viewEndMs: 183_400,
    videoVisible: true,
    videoOpacity: 1,
    analysisVisible: true,
    analysisOpacity: 1,
    analysisLocked: false,
    annotationsVisible: true,
    boundariesVisible: true,
    playbackRate: 1,
    volume: 1,
    muted: false,
    timelineHeight: 160,
  },
};

/** 反馈层视觉预览：toast（成功/失败/撤销）+ 错误横幅 + 任务中心。 */
function FeedbackPreview() {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) {
      return;
    }
    done.current = true;
    feedbackStore.pushToast({ kind: 'success', message: '已保存到项目文件夹。' });
    feedbackStore.pushToast({
      kind: 'info',
      message: '已从项目库移除「广告成片 · 情绪节奏分析」，磁盘文件未删除。',
      action: { label: '撤销', run: () => undefined },
    });
    feedbackStore.pushToast({ kind: 'error', message: '无法在文件管理器中显示项目文件夹。' });
    feedbackStore.showBanner({
      kind: 'error',
      title: '素材缺失',
      message: '找不到原视频副本，暂时无法播放；分析内容仍可查看。',
      actions: [
        { label: '重新定位素材', primary: true, run: () => undefined },
        { label: '关闭', run: () => feedbackStore.clearBanner() },
      ],
      diagnostics: 'code=MEDIA_MISSING\nprojectId=demo-uuid-ready',
    });

    const listeners: Array<(event: TaskEvent) => void> = [];
    taskCenterStore.attachSource({
      subscribe(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    const push = (event: TaskEvent): void => {
      listeners.forEach((listener) => listener(event));
    };
    taskCenterStore.announce({ taskId: 'demo-thumbs', label: '生成缩略图与封面 · 广告成片' });
    push({
      taskId: 'demo-thumbs',
      kind: 'thumbnails',
      status: 'running',
      projectId: 'p1',
      progress: { kind: 'step', step: '生成缩略图 42/86' },
      message: null,
      updatedAt: new Date().toISOString(),
    });
    taskCenterStore.announce({ taskId: 'demo-shots', label: '识别镜头' });
    push({
      taskId: 'demo-shots',
      kind: 'shot-detect',
      status: 'failed',
      projectId: 'p1',
      progress: null,
      message: '视频无法解码，请生成兼容副本后重试。',
      updatedAt: new Date().toISOString(),
    });
  }, []);

  return (
    <div className="app-shell" style={{ minHeight: '100vh' }}>
      <FeedbackHost />
    </div>
  );
}

/** 确认对话框预览：重复导入确认。 */
function ConfirmPreview() {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) {
      return;
    }
    done.current = true;
    void feedbackStore.confirm({
      title: '这个视频已经导入过了',
      message: '「开场30秒_成片_v2.mp4」已导入为项目「广告成片 · 情绪节奏分析」。',
      impact: '继续会再次复制同一份视频到新项目文件夹，额外占用磁盘空间；已有项目不受影响。',
      confirmLabel: '仍要新建',
      cancelLabel: '取消',
    });
  }, []);
  return (
    <div className="app-shell" style={{ minHeight: '100vh' }}>
      <FeedbackHost />
    </div>
  );
}

function DemoApp() {
  const [projects, setProjects] = useState<ProjectSummary[]>(DEMO_PROJECTS);
  const [view, setView] = useState<DemoView>(() => {
    const param = new URLSearchParams(window.location.search).get('view');
    return param === 'import' ||
      param === 'editor-loading' ||
      param === 'feedback' ||
      param === 'confirm'
      ? param
      : 'home';
  });
  const [importProject, setImportProject] = useState<NewProjectCreatedInfo>({
    projectId: 'demo-created-1',
    projectName: '开场30秒_成片_v2',
    source: {
      fileName: '开场30秒_成片_v2.mp4',
      sizeBytes: 314_572_800,
      durationMs: 183_400,
      width: 1920,
      height: 1080,
    },
  });
  const [loadingProject, setLoadingProject] = useState({
    projectId: 'demo-created-1',
    projectName: '开场30秒_成片_v2',
  });
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  // mock window.laipian：仅本 demo 页生命周期内存在。
  const demoApi = useMemo<LaipianApi>(() => {
    const notImplemented = (what: string) =>
      err('NOT_IMPLEMENTED', `${what} 为 demo mock 占位（真实实现见主进程服务）。`);
    return {
      app: {
        onCloseRequested: () => () => undefined,
        confirmClose: async () => ok(null),
        onOpenVideo: () => () => undefined,
        consumePendingOpenVideo: async () => ok(null),
      },
      dialog: {
        // 对象形态（推荐给集成阶段的 pick* 返回值契约）：token + 元信息。
        pickVideoFile: async () =>
          ok({
            token: 'demo-token-video-1' as FileSelectionToken,
            fileName: '开场30秒_成片_v2.mp4',
            sizeBytes: 314_572_800,
            durationMs: 183_400,
            width: 1920,
            height: 1080,
          }),
        pickProjectDir: async () =>
          ok({ token: 'demo-token-dir-1', fileName: 'CutSpect 项目' } as unknown as FileSelectionToken),
        pickOpenProjectFolder: async () => ok('demo-token-open-1' as FileSelectionToken),
      },
      projects: {
        listRecent: async () => ok(projectsRef.current),
        create: async () => ok({ projectId: 'demo-created-1' }),
        checkDuplicate: async () => ok({ duplicate: null }),
        open: async () =>
          ok({ projectId: 'demo-opened-1', snapshot: DEMO_SNAPSHOT, mediaUrl: null, status: 'ready' as const, recovery: null }),
        openRecent: async () =>
          ok({ projectId: 'demo-opened-1', snapshot: DEMO_SNAPSHOT, mediaUrl: null, status: 'ready' as const, recovery: null }),
        rename: async (params) => {
          // 真实改数据：演示卡片名称更新（走 Home 的 refresh → 注入数据重渲染）。
          setProjects((prev) =>
            prev.map((p) => (p.projectId === params.projectId ? { ...p, name: params.name } : p)),
          );
          return ok(null);
        },
        save: async () => notImplemented('projects.save'),
        listBackups: async () => notImplemented('projects.listBackups'),
        restoreBackup: async () => notImplemented('projects.restoreBackup'),
        restoreRecovery: async () => notImplemented('projects.restoreRecovery'),
        discardRecovery: async () => notImplemented('projects.discardRecovery'),
        // 返回 ok 让 Home 演示“本地隐藏 + 5 秒撤销 toast”（撤销=恢复本地展示）。
        removeRecent: async () => ok(null),
        reveal: async () => ok(null),
        close: async () => ok(null),
      },
      media: {
        probe: async () => notImplemented('media.probe'),
        createCompatibleCopy: async () => notImplemented('media.createCompatibleCopy'),
        rebuildThumbnails: async () => notImplemented('media.rebuildThumbnails'),
        relocateSource: async () => notImplemented('media.relocateSource'),
        listThumbnails: async () => ok([]),
        getFramePreview: async () => notImplemented('media.getFramePreview'),
        filmstrip: async () => notImplemented('media.filmstrip'),
        cancelFilmstrip: async () => ok(null),
        detectShots: async () => notImplemented('media.detectShots'),
        readDetectedCuts: async () => ok(null),
        detectShotsRange: async () => notImplemented('media.detectShotsRange'),
        readDetectedCutsRange: async () => ok(null),
      },
      tasks: {
        // 不推送任何事件：演示“等待任务事件”的真实初始态（禁止假进度）。
        subscribe: () => () => undefined,
        snapshot: async () => ok([]),
        cancel: async () => notImplemented('tasks.cancel'),
      },
      exports: {
        save: async () => notImplemented('exports.save'),
        start: async () => notImplemented('exports.start'),
        products: async () => notImplemented('exports.products'),
        reveal: async () => notImplemented('exports.reveal'),
        open: async () => notImplemented('exports.open'),
      },
      settings: {
        get: async () => ok({ keymap: {} }),
        set: async () => ok({ keymap: {} }),
      },
      updates: {
        getState: async () =>
          ok({
            status: 'disabled' as const,
            version: null,
            percent: null,
            message: null,
            canInstall: false,
          }),
        check: async () => ok(null),
        install: async () => ok(null),
        subscribe: () => () => undefined,
      },
    };
  }, []);

  useEffect(() => {
    window.laipian = demoApi;
    return () => {
      window.laipian = undefined;
    };
  }, [demoApi]);

  const recent = useMemo(
    () => ({
      state: { phase: 'ready' as const, projects },
      refresh: () => {
        // demo 数据固定：真实环境此处会重新 listRecent（见 useRecentProjects）。
      },
    }),
    [projects],
  );

  const demoToolbarStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    flexWrap: 'wrap' as const,
    padding: '8px 16px',
    borderBottom: '1px solid rgba(245, 186, 66, 0.4)',
    background: 'rgba(245, 186, 66, 0.1)',
    color: '#f5ba42',
    fontSize: '12.5px',
  };
  const demoButtonStyle = {
    padding: '4px 12px',
    border: '1px solid rgba(245, 186, 66, 0.55)',
    borderRadius: '6px',
    background: 'transparent',
    color: '#f5ba42',
    fontSize: '12.5px',
    cursor: 'pointer',
  };

  return (
    <div className="app-shell">
      <div className="demo-toolbar" style={demoToolbarStyle}>
        <strong>dev-home · 仅开发预览（固定假数据，不进入正式 App 路径）</strong>
        <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }}>
          <button type="button" style={demoButtonStyle} onClick={() => setView('home')}>
            项目库
          </button>
          <button type="button" style={demoButtonStyle} onClick={() => setView('import')}>
            导入页（浏览器静态预览）
          </button>
          <button type="button" style={demoButtonStyle} onClick={() => setView('editor-loading')}>
            工作台中转态
          </button>
          <button type="button" style={demoButtonStyle} onClick={() => setView('feedback')}>
            反馈层预览
          </button>
          <button type="button" style={demoButtonStyle} onClick={() => setView('confirm')}>
            确认对话框
          </button>
        </div>
      </div>

      {view === 'home' && (
        <Home
          hasApi={true}
          recent={recent}
          canOpenProject={true}
          openProjectDisabledReason=""
          onProjectCreated={(info) => {
            setImportProject(info);
            setLoadingProject(info);
            setView('import');
          }}
          onProjectOpened={(opened) => {
            setLoadingProject({ projectId: opened.projectId, projectName: opened.snapshot.name });
            setView('editor-loading');
          }}
          onOpenProject={(project) => {
            console.info('[dev demo] 打开最近项目：', project.projectId, project.name);
          }}
        />
      )}

      {view === 'import' && (
        <div>
          <div
            style={{
              margin: '18px auto 0',
              maxWidth: '760px',
              padding: '24px 32px 0',
              fontSize: '12.5px',
              color: '#9aa0ad',
            }}
          >
            【演示说明】浏览器静态预览态：进度条 0%、按钮禁用（需要桌面运行环境）。
            桌面环境下此页由真实 TaskEvent 驱动，读取信息成功后自动进入“工作台中转态”
            （点上方工具栏按钮预览该态）。
          </div>
          <ImportPage
            hasApi={false}
            project={importProject}
            source={importProject.source}
            onComplete={() => {
              setLoadingProject(importProject);
              setView('editor-loading');
            }}
            onCancelled={() => {
              setView('home');
            }}
            onRetry={() => {
              setView('home');
            }}
          />
        </div>
      )}

      {view === 'editor-loading' && (
        // 重现 App.tsx 的中转态结构（集成阶段 Editor 挂载点），复用 .editor-loading 样式。
        <div className="editor-loading" role="status">
          <div className="editor-loading-spinner" aria-hidden="true" />
          <h1>正在进入工作台…</h1>
          <p className="editor-loading-project">项目「{loadingProject.projectName}」</p>
          <button type="button" className="dialog-button-secondary" onClick={() => setView('home')}>
            返回项目库
          </button>
        </div>
      )}

      {view === 'feedback' && (
        <div>
          <FeedbackPreview />
          <TaskCenter defaultOpen />
        </div>
      )}
      {view === 'confirm' && <ConfirmPreview />}
    </div>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('找不到 #root 挂载点（dev-home.html）');
}

createRoot(rootEl).render(
  <StrictMode>
    <DemoApp />
  </StrictMode>,
);
