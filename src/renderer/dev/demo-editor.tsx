/**
 * 仅开发预览，集成后删除（任务 A-T6 dev 脚手架）。
 *
 * 用途：在纯浏览器环境（vite dev server）验证工作台骨架的真实交互——
 * 播放/暂停、时间线拖动 seek、缩放平移、图层透明度、键盘定位。
 *
 * 重要说明（数据流与产品的差异）：
 * - 产品路径：视频经 main 侧 laipian-media:// 自定义协议授权流式读取
 *   （规格 12.5），ProjectSnapshot 由 projects.open() 返回。
 * - 本 demo：URL.createObjectURL（文件选择）或 vite 静态资源 URL
 *   （内置测试视频）加载本地文件，snapshot 在内存构造——仅是开发
 *   脚手架，不代表产品数据流。
 * - 保存管线：产品由外层 App + main 串行队列落盘（规格 8.2/8.3）；
 *   本 demo 用内存对象 + 真实防抖/状态流转模拟（dirty → saving → saved），
 *   用于验证 Editor 的 onViewChange 契约与保存状态显示。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import type { ProjectSnapshot, ProjectView, TimelineThumbnail } from '@shared/api-types';
import { Editor, type ProjectContentPatch, type SaveState } from '../pages/Editor';
import { TooltipHost } from '../components/TooltipHost';
import '../styles/tokens.css';
import '../styles/editor.css';
import '../styles/graphite.css';
import '../styles/rhythm.css';
import '../styles/export.css';
import '../styles/dev-demo.css';
// vite 静态资源 URL：dev server 伺服；不进生产构建（dev-editor.html 非
// build 入口，该模块不在 index.html 的模块图内）。
import devTestVideoUrl from '../../../dev-assets/dev-test.mp4?url';

interface LoadedMedia {
  src: string;
  /** 是否为 objectURL（关闭时需要 revoke，防止泄漏）。 */
  isObjectUrl: boolean;
  durationMs: number;
  originalName: string;
}

/** 借用 tests/smoke.test.ts 的最小合法 ProjectSnapshot 结构（规格 11.2）。 */
function buildSnapshot(loaded: LoadedMedia): ProjectSnapshot {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: 'dev-project-0001',
    name: loaded.originalName.replace(/\.[^.]+$/, '') || '开发预览项目',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    media: {
      id: 'dev-media-0001',
      originalName: loaded.originalName,
      sourcePath: 'media/source.mp4',
      playbackPath: null,
      sha256: '0'.repeat(64),
      sizeBytes: 0,
      durationMs: loaded.durationMs,
      width: 320,
      height: 180,
      videoCodec: 'h264',
      audioCodec: 'aac',
      avgFrameRate: { num: 30, den: 1 },
      isVfr: false,
      isHdr: false,
    },
    curve: {
      id: 'dev-curve-0001',
      name: '情绪强度',
      color: '#F04B50',
      nodes: [
        { id: 'node-start', timeMs: 0, value: 50, outMode: 'auto', inHandle: null, outHandle: null },
        { id: 'node-end', timeMs: loaded.durationMs, value: 50, outMode: 'auto', inHandle: null, outHandle: null },
      ],
    },
    annotations: [
      {
        id: 'dev-note-1',
        timeMs: Math.round(loaded.durationMs * 0.62),
        title: '情绪转折',
        body: '此处节奏明显加快，可作为段落切点参考。',
        labelOffset: { x: 12, y: -18 },
      },
    ],
    boundaries: [
      { id: 'start', timeMs: 0, fixed: true, locked: true },
      { id: 'end', timeMs: loaded.durationMs, fixed: true, locked: true },
    ],
    sections: [{ id: 'dev-section-0001', startBoundaryId: 'start', name: '段落 1', note: '' }],
    structure: [
      {
        id: 'dev-chapter-1', level: 'chapter', parentId: null, name: '开头', startMs: 0,
        note: '', narrativeRole: '', tags: [], color: '#A9B4C6', locked: false,
        coverTimeMs: null, source: 'manual', confidence: null,
      },
      {
        id: 'dev-chapter-2', level: 'chapter', parentId: null, name: '中间', startMs: Math.round(loaded.durationMs / 2),
        note: '', narrativeRole: '', tags: [], color: '#A9B4C6', locked: false,
        coverTimeMs: null, source: 'manual', confidence: null,
      },
      {
        id: 'dev-section-a', level: 'section', parentId: 'dev-chapter-1', name: '人物出场', startMs: 0,
        note: '', narrativeRole: '', tags: [], color: '#78A6FF', locked: false,
        coverTimeMs: null, source: 'manual', confidence: null,
      },
      {
        id: 'dev-section-b', level: 'section', parentId: 'dev-chapter-2', name: '抛出问题', startMs: Math.round(loaded.durationMs / 2),
        note: '', narrativeRole: '', tags: [], color: '#78A6FF', locked: false,
        coverTimeMs: null, source: 'manual', confidence: null,
      },
      {
        id: 'dev-shot-1', level: 'shot', parentId: 'dev-section-a', name: '镜头 1', startMs: 0,
        note: '', narrativeRole: '', tags: [], color: '#8B93A1', locked: false,
        coverTimeMs: null, source: 'auto', confidence: null,
      },
      {
        id: 'dev-shot-2', level: 'shot', parentId: 'dev-section-a', name: '镜头 2', startMs: Math.round(loaded.durationMs * 0.3),
        note: '', narrativeRole: '', tags: [], color: '#8B93A1', locked: false,
        coverTimeMs: null, source: 'auto', confidence: null,
      },
      {
        id: 'dev-shot-3', level: 'shot', parentId: 'dev-section-b', name: '镜头 1', startMs: Math.round(loaded.durationMs / 2),
        note: '', narrativeRole: '', tags: [], color: '#8B93A1', locked: false,
        coverTimeMs: null, source: 'auto', confidence: null,
      },
    ],
    view: {
      playheadMs: 0,
      viewStartMs: 0,
      viewEndMs: loaded.durationMs,
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
      timelineHeight: 350,
    },
  };
}

/** 读取媒体 metadata（duration），构造 snapshot 前的一次性探测。 */
function probeMedia(src: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = src;
    video.onloadedmetadata = () => {
      const durationMs = Math.round(video.duration * 1000);
      video.src = '';
      if (Number.isFinite(durationMs) && durationMs > 0) {
        resolve(durationMs);
      } else {
        reject(new Error('无法读取视频时长（duration 无效）'));
      }
    };
    video.onerror = () => {
      video.src = '';
      reject(new Error('视频加载失败：编码不受浏览器支持或文件损坏'));
    };
  });
}

function DevLauncher(props: { onLoaded: (loaded: LoadedMedia) => void }) {
  const { onLoaded } = props;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
    }
  }, []);

  const load = useCallback(
    async (src: string, originalName: string, isObjectUrl: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const durationMs = await probeMedia(src);
        onLoaded({ src, isObjectUrl, durationMs, originalName });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        if (isObjectUrl) {
          URL.revokeObjectURL(src);
        }
        setLoading(false);
      }
    },
    [onLoaded],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // 允许重复选择同一文件。
      if (!file) {
        return;
      }
      // 开发脚手架：URL.createObjectURL 仅用于浏览器 demo；
      // 产品路径是 laipian-media:// 协议（见文件头说明）。
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      void load(url, file.name, true);
    },
    [load],
  );

  return (
    <div className="dev-launcher">
      <div className="dev-banner" role="status">
        开发预览模式 —— 工作台骨架（任务 A-T6）交互验证页。
        产品中视频经 <code>laipian-media://</code> 协议加载；本页的本地文件
        选择与 objectURL 仅为开发脚手架，集成后删除。
      </div>
      <div className="dev-launcher-card">
        <h1>加载一条视频进入工作台</h1>
        <label className="dev-file-label">
          <input
            type="file"
            accept="video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.mov,.m4v,.webm,.mkv"
            onChange={handleFileChange}
            disabled={loading}
          />
          选择本地视频文件（objectURL，仅开发）
        </label>
        <button
          type="button"
          className="dev-builtin-button"
          onClick={() => void load(devTestVideoUrl, 'dev-test.mp4', false)}
          disabled={loading}
        >
          加载内置测试视频（testsrc2 · 10s · 320×180 · 含音频）
        </button>
        {loading && <p className="dev-hint">正在读取媒体信息…</p>}
        {error && (
          <p className="dev-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function DemoEditorApp() {
  const [loaded, setLoaded] = useState<LoadedMedia | null>(null);
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  // —— 模拟保存管线（真实状态流转；落盘目标是内存对象） ——
  const [saveStatus, setSaveStatus] = useState<SaveState>('saved');
  const [persistedView, setPersistedView] = useState<ProjectView | null>(null);
  const [revision, setRevision] = useState(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestViewRef = useRef<ProjectView | null>(null);

  const handleClose = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (loaded?.isObjectUrl) {
      URL.revokeObjectURL(loaded.src);
    }
    latestViewRef.current = null;
    setSnapshot(null);
    setLoaded(null);
    setSaveStatus('saved');
    setPersistedView(null);
  }, [loaded]);

  const handleContentChange = useCallback((patch: ProjectContentPatch) => {
    // demo：内容改动直接落到内存 snapshot（真实产品进 history + 串行落盘）。
    setSnapshot((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaveStatus('dirty');
  }, []);

  const handleViewChange = useCallback((view: ProjectView) => {
    // 真实防抖管线演示（规格 8.2 的 renderer 侧契约）：
    // 内容提交后防抖保存；持续编辑时重复推迟；模拟落盘耗时后置为已保存。
    latestViewRef.current = view;
    setSaveStatus('dirty');
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      setSaveStatus('saving');
      // 模拟磁盘写入耗时（产品为 main 串行队列 + 原子替换，规格 8.3）。
      setTimeout(() => {
        const current = latestViewRef.current;
        if (current) {
          setPersistedView(current);
          setRevision((r) => r + 1);
          setSaveStatus('saved');
        }
      }, 250);
    }, 800);
  }, []);

  useEffect(() => () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
  }, []);

  if (!loaded || !snapshot) {
    return (
      <DevLauncher
        onLoaded={(media) => {
          setLoaded(media);
          setSnapshot(buildSnapshot(media));
        }}
      />
    );
  }

  return (
    <div className="dev-editor-root">
      <div className="dev-statusbar">
        <span>
          demo 保存管线（内存落盘）· revision {revision} ·
          状态机：onViewChange → dirty →（防抖 800ms）→ saving →（250ms）→ saved
        </span>
        {persistedView && (
          <code className="dev-view-dump">
            view: playhead={persistedView.playheadMs}ms range=[{persistedView.viewStartMs},
            {persistedView.viewEndMs}] video={persistedView.videoVisible}/
            {Math.round(persistedView.videoOpacity * 100)}% analysis={persistedView.analysisVisible}/
            {Math.round(persistedView.analysisOpacity * 100)}% rate={persistedView.playbackRate}×
            vol={Math.round(persistedView.volume * 100)}%{persistedView.muted ? ' 静音' : ''}
          </code>
        )}
      </div>
      <Editor
        key={loaded.src}
        snapshot={snapshot}
        mediaSrc={loaded.src}
        onClose={handleClose}
        onViewChange={handleViewChange}
        onContentChange={handleContentChange}
        canUndo={false}
        canRedo={false}
        onUndo={() => undefined}
        onRedo={() => undefined}
        saveStatus={saveStatus}
      />
    </div>
  );
}

/**
 * 仅开发预览：注入最小 laipian.media.tasks 桩，让帧带在浏览器预览中可见。
 *
 * 真实产品由 main 侧生成缩略图（160×90→320×180）；本桩用 SVG data URL 生成
 * 320×180 假帧，仅用于验证「帧带渲染 / 加载 / 清晰度 / 缩放」等前端行为。
 */
function installDevMediaMock(): void {
  const w = window as unknown as { laipian?: unknown };
  if (w.laipian) {
    return;
  }
  const makeThumb = (timeMs: number): TimelineThumbnail => {
    const hue = Math.round((timeMs / 100) % 360);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">` +
      `<rect width="320" height="180" fill="hsl(${hue} 35% 30%)"/>` +
      `<rect y="150" width="320" height="30" fill="rgba(0,0,0,0.55)"/>` +
      `<text x="10" y="171" fill="#e8eaf0" font-size="16" font-family="monospace">` +
      `${(timeMs / 1000).toFixed(1)}s</text></svg>`;
    return { timeMs, width: 320, height: 180, mediaUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` };
  };
  const thumbs: TimelineThumbnail[] = [];
  for (let s = 0; s < 10; s++) {
    thumbs.push(makeThumb(s * 1000));
  }
  const notImpl = () =>
    Promise.resolve({ ok: false, error: { code: 'DEV_MOCK', message: '开发预览未实现' } });
  const base = {
    media: {
      listThumbnails: () => Promise.resolve({ ok: true, data: thumbs }),
      getFramePreview: notImpl,
      // 开发预览：按可视范围返回等宽假帧（不同色调 + 序号），仅用于验证帧带布局。
      filmstrip: (params: { startMs: number; endMs: number; count: number }) =>
        Promise.resolve({
          ok: true,
          data: Array.from({ length: Math.max(1, Math.min(72, params.count)) }, (_v, i) => {
            const span = Math.max(1, params.endMs - params.startMs);
            const hue = Math.round((i * 360) / Math.max(1, params.count));
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="hsl(${hue},45%,38%)"/><text x="14" y="170" font-size="60" fill="rgba(255,255,255,0.75)">${i + 1}</text></svg>`;
            return {
              index: i,
              timeMs: Math.round(params.startMs + (span * (i + 0.5)) / Math.max(1, params.count)),
              mediaUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
            };
          }),
        }),
      cancelFilmstrip: () => Promise.resolve({ ok: true, data: null }),
    },
    tasks: {
      subscribe: () => () => undefined,
      snapshot: () => Promise.resolve({ ok: true, data: [] }),
      cancel: notImpl,
    },
    exports: { save: notImpl, start: notImpl, products: notImpl, reveal: notImpl, open: notImpl },
    projects: { reveal: notImpl },
    settings: { get: notImpl, set: notImpl, save: notImpl, load: notImpl },
  };
  w.laipian = new Proxy(base, {
    get: (target, prop) =>
      prop in target ? Reflect.get(target, prop) : notImpl,
  });
}

installDevMediaMock();

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('找不到 #root 挂载点（dev-editor.html）');
}

createRoot(rootEl).render(
  <StrictMode>
    <DemoEditorApp />
    <TooltipHost />
  </StrictMode>,
);
