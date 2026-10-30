import path from 'node:path';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, stat as fsStat } from 'node:fs/promises';
import { app, BrowserWindow, dialog, protocol, screen, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { createExternalVideoOpenCoordinator } from './external-open';
import type { ExternalVideoOpenCoordinator } from './external-open';
import { registerIpcHandlers } from './ipc';
import { handleSquirrelStartup } from './update/squirrel';
import { describeVideoSelection } from './video-pick';
import { applyWindowsFileAssociationsSync } from './windows-file-assoc';
import { setupAutoUpdate } from './update';
import { createExportService } from './services/export-service';
import { runExport } from './services/export-runner';
import { frameQueueStats, requestFilmstripBatch } from './services/frame-queue';
import { getFramePreview } from './services/frame-service';
import { resolveFfmpegPaths } from './services/ffmpeg';
import { detectShots, detectShotsRange } from './services/shot-detect-service';
import { createMediaRequestHandler, MEDIA_PROTOCOL_SCHEME, registerMediaResource } from './protocol';
import { createProjectService } from './services/project-service';
import type { ProjectService } from './services/project-service';
import { createSettingsService } from './services/settings-service';
import { createTaskManager } from './services/tasks';
import { generateThumbnails, listThumbnailEntries } from './services/thumbnail-service';
import { buildMediaUrl } from '../shared/media-url';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { ExternalVideoOpen } from '../shared/api-types';
import { createInitialSnapshot } from '../shared/schema';
import { createStructureNode } from '../shared/structure';
import {
  DEFAULT_EXPORT_MODULES,
  DEFAULT_FRAME_SETTINGS,
  DEFAULT_LAYOUT_SETTINGS,
  DEFAULT_TABLE_FIELDS,
} from '../shared/export-config';
import type { ExportRequest, ProjectMedia } from '../shared/api-types';

/**
 * 拉片台主进程入口。
 *
 * 安全基线（规格 12.5）：
 * - contextIsolation: true、sandbox: true、nodeIntegration: false、webSecurity: true。
 * - 禁止远程导航与任意新窗口；CSP 由 index.html 的 meta 设置。
 * - 单实例锁（规格 8.5：应用单实例）+ 项目级 .lock（project-service）。
 *   第二个实例退出，已有窗口聚焦，并接过命令行里的视频路径。
 * - macOS `open-file` 与 Windows argv 都进入同一条「打开方式」队列，
 *   渲染层收到的是选择令牌，不是绝对路径。
 *
 * 媒体读取（规格 12.5）：
 * - 注册 laipian-media: 为 standard + stream 特权协议，仅按已授权注册表
 *   提供 GET/HEAD + Range，URL 不携带绝对路径。
 *
 * --smoke：无头验证模式——启动窗口、等待渲染完成、探针 IPC、截图后退出。
 */

const DEV_SERVER_URL = process.env.LAIPIAN_DEV_SERVER_URL;
// 开发用 `electron . --smoke`；打包应用无法透传自定义开关（Chromium 拒绝未知 --xxx），
// 且 GUI 下 stdout 可能丢失，因此冒烟同时支持环境变量与“触发文件”（打包环境最稳）。
const SMOKE_TRIGGER_PATH = path.join(app.getPath('temp'), 'laipian-smoke-trigger');
const IS_SMOKE =
  process.argv.includes('--smoke') ||
  process.env.LAIPIAN_SMOKE === '1' ||
  existsSync(SMOKE_TRIGGER_PATH);

let mainWindow: BrowserWindow | null = null;
let projectService: ProjectService | null = null;
const windowsAllowedToClose = new WeakSet<BrowserWindow>();
/** 系统「打开方式」尚未被渲染层取走的请求。 */
let pendingExternal: ExternalVideoOpen | null = null;
/** 窗口已加载时可立刻推送；加载中则等 did-finish-load。 */
let deliverExternal: (() => void) | null = null;
/** bootstrap 完成前不要因 open-file 再开一个窗口。 */
let appBooted = false;

// 必须在 app ready 之前注册自定义协议特权（Electron 要求）。
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL_SCHEME,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
]);

// 冒烟模式使用独立 userData：避免与正在运行的正式应用争抢单实例锁而静默退出。
if (IS_SMOKE) {
  app.setPath('userData', path.join(app.getPath('temp'), 'laipian-smoke-userdata'));
  try {
    writeFileSync(
      path.join(app.getPath('temp'), 'laipian-smoke-boot.txt'),
      `boot: smoke=1 argv=${JSON.stringify(process.argv)} env=${process.env.LAIPIAN_SMOKE ?? ''}\n`,
    );
  } catch {
    // 诊断文件不可写不影响主流程。
  }
}

function isAllowedNavigation(targetUrl: string): boolean {
  if (DEV_SERVER_URL && (targetUrl === DEV_SERVER_URL || targetUrl.startsWith(`${DEV_SERVER_URL}/`))) {
    return true;
  }
  // 生产环境：仅允许本地打包文件；laipian-media: 仅用于子资源，不导航。
  return targetUrl.startsWith('file://');
}

/** 窗口最小尺寸：允许在 1366×768（含 125% 缩放）等较小/高 DPI 屏幕上完整显示。 */
const WINDOW_MIN_WIDTH = 1024;
const WINDOW_MIN_HEIGHT = 600;
const WINDOW_DEFAULT_WIDTH = 1440;
const WINDOW_DEFAULT_HEIGHT = 900;

/**
 * 依据主显示器工作区计算初始窗口尺寸：不超出屏幕可用区域，
 * 避免高 DPI 缩放（125% / 150%）下窗口打开即溢出屏幕造成按钮裁切。
 */
function initialWindowSize(): { width: number; height: number } {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.max(WINDOW_MIN_WIDTH, Math.min(WINDOW_DEFAULT_WIDTH, workArea.width)),
    height: Math.max(WINDOW_MIN_HEIGHT, Math.min(WINDOW_DEFAULT_HEIGHT, workArea.height)),
  };
}

function createWindow(): BrowserWindow {
  const { width, height } = initialWindowSize();
  const win = new BrowserWindow({
    width,
    height,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    backgroundColor: '#15171C',
    title: 'CutSpect',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedNavigation(targetUrl)) {
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('close', (event) => {
    if (IS_SMOKE || windowsAllowedToClose.has(win)) {
      return;
    }
    event.preventDefault();
    win.webContents.send(IPC_CHANNELS.appCloseRequested);
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
    if (!IS_SMOKE) {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return win;
}

function publishExternal(payload: ExternalVideoOpen): void {
  pendingExternal = payload;
  deliverExternal?.();
}

function consumePendingExternal(): ExternalVideoOpen | null {
  // 不在读取时清掉：开发模式 StrictMode 会重挂载渲染层，需要能再读到同一次打开。
  // 新的文件会覆盖这一条。
  return pendingExternal;
}

function attachExternalOpenDelivery(win: BrowserWindow): void {
  const send = (): void => {
    if (pendingExternal === null || win.isDestroyed()) {
      return;
    }
    win.webContents.send(IPC_CHANNELS.appOpenVideo, pendingExternal);
  };
  win.webContents.on('did-finish-load', send);
  deliverExternal = () => {
    if (win.isDestroyed() || win.webContents.isLoading()) {
      return;
    }
    send();
  };
}

function focusMainWindow(): void {
  if (!appBooted) {
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    attachExternalOpenDelivery(mainWindow);
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
}

async function isExistingVideoFile(filePath: string): Promise<boolean> {
  try {
    const info = await fsStat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

function logOpenWith(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** 冒烟模式不接「打开方式」，避免和正式实例或探测流程互相影响。 */
const externalOpen: ExternalVideoOpenCoordinator | null = IS_SMOKE
  ? null
  : createExternalVideoOpenCoordinator({
      cwd: process.cwd(),
      now: () => Date.now(),
      existsFile: isExistingVideoFile,
      describeVideo: describeVideoSelection,
      deliver: publishExternal,
    });

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 冒烟用最小 ProjectMedia（仅供抽帧缓存键与帧号计算）。 */
function smokeProjectMedia(durationMs: number): ProjectMedia {
  return {
    id: 'media',
    originalName: 'dev-test.mp4',
    sourcePath: 'media/source.mp4',
    playbackPath: null,
    sha256: 'smoke',
    sizeBytes: 0,
    durationMs,
    width: 320,
    height: 180,
    videoCodec: 'h264',
    audioCodec: 'aac',
    avgFrameRate: { num: 30, den: 1 },
    isVfr: false,
    isHdr: false,
  };
}

interface ImageProbe {
  ok: boolean;
  stage: string;
  width?: number;
  height?: number;
}

/** 让渲染层用 <img> 经 laipian-media: 读取一张图片，返回解码结果。 */
function probeImage(win: BrowserWindow, url: string, timeoutMs = 6000): Promise<ImageProbe> {
  return win.webContents.executeJavaScript(
    `(async () => new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => resolve({ ok: false, stage: 'timeout' }), ${timeoutMs});
      img.onload = () => { clearTimeout(timer); resolve({ ok: true, stage: 'ready', width: img.naturalWidth, height: img.naturalHeight }); };
      img.onerror = () => { clearTimeout(timer); resolve({ ok: false, stage: 'error' }); };
      img.src = ${JSON.stringify(url)};
    }))()`,
    true,
  );
}

/** 精确帧通路探针：main 侧 ffmpeg 抽帧 → 协议命名资源 → img 解码（节点联动核心）。 */
async function smokeFrameProbe(
  sourceAbsPath: string,
  win: BrowserWindow,
): Promise<ImageProbe & { mediaUrl?: string }> {
  const folder = await mkdtemp(path.join(app.getPath('temp'), 'laipian-smoke-frame-'));
  try {
    registerMediaResource('smoketest', 'media', 'frame', path.join(folder, 'cache', 'frames'));
    const generated = await getFramePreview({
      projectId: 'smoketest',
      projectFolder: folder,
      sourceAbsPath,
      media: smokeProjectMedia(10_000),
      timeMs: 2000,
      width: 176,
      height: 99,
    });
    if (!generated.ok) {
      return { ok: false, stage: `generate:${generated.error.code}` };
    }
    const probe = await probeImage(win, generated.data.mediaUrl);
    return { ...probe, mediaUrl: generated.data.mediaUrl };
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 时间线缩略图通路探针：main 侧生成缩略图 → 协议命名资源 → img 解码。 */
async function smokeThumbProbe(
  sourceAbsPath: string,
  win: BrowserWindow,
): Promise<ImageProbe & { count?: number }> {
  const folder = await mkdtemp(path.join(app.getPath('temp'), 'laipian-smoke-thumb-'));
  try {
    const generated = await generateThumbnails({
      sourceAbsPath,
      projectFolder: folder,
      durationMs: 10_000,
      sha256: 'smoke',
    });
    if (!generated.ok) {
      return { ok: false, stage: `generate:${generated.error.code}` };
    }
    registerMediaResource('smoketest', 'media', 'thumb', path.join(folder, 'cache', 'thumbs'));
    const entries = await listThumbnailEntries(folder, 10_000);
    const first = entries[0];
    if (first === undefined) {
      return { ok: false, stage: 'empty' };
    }
    const url = buildMediaUrl('smoketest', 'media', 'thumb', 'smoke', first.name);
    const probe = await probeImage(win, url);
    return { ...probe, count: entries.length };
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

const execFileAsync = promisify(execFile);

/** 智能镜头识别探针：生成合成硬切视频 → 内置 FFmpeg scdet → 解析出切点（验证打包后 FFmpeg 可用）。 */
async function smokeShotProbe(): Promise<{
  ok: boolean;
  stage: string;
  cuts: number;
  firstMs?: number;
  rangeCuts?: number;
  rangeFirstMs?: number;
}> {
  const folder = await mkdtemp(path.join(app.getPath('temp'), 'laipian-smoke-shot-'));
  try {
    const ffmpeg = resolveFfmpegPaths().ffmpeg;
    if (ffmpeg === null) {
      return { ok: false, stage: 'no-ffmpeg', cuts: 0 };
    }
    const source = path.join(folder, 'cut.mp4');
    await execFileAsync(ffmpeg.path, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x180:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'color=c=white:s=320x180:r=30:d=2',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[out]',
      '-map',
      '[out]',
      source,
    ]);
    const result = await detectShots({
      projectFolder: folder,
      sourceAbsPath: source,
      media: smokeProjectMedia(4000),
      threshold: 10,
      minShotMs: 500,
    });
    if (!result.ok) {
      return { ok: false, stage: `detect:${result.error.code}`, cuts: 0 };
    }
    // 局部（选中区域）识别：只分析 [1000,3000)，切点应回到全局 ~2000ms（非局部 ~1000ms）。
    const range = await detectShotsRange({
      sourceAbsPath: source,
      threshold: 10,
      minShotMs: 300,
      inMs: 1000,
      outMs: 3000,
      projectFolder: folder,
      sha256: 'smoke',
    });
    return {
      ok: true,
      stage: 'ready',
      cuts: result.data.length,
      firstMs: result.data[0]?.timeMs,
      rangeCuts: range.ok ? range.data.length : 0,
      rangeFirstMs: range.ok ? range.data[0]?.timeMs : undefined,
    };
  } catch (error) {
    return { ok: false, stage: `error:${error instanceof Error ? error.message : String(error)}`, cuts: 0 };
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 冒烟结果同时落盘（打包应用在 macOS GUI 下 stdout 可能丢失，凭文件确证结果）。 */
const SMOKE_LOG_PATH = path.join(app.getPath('temp'), 'laipian-smoke-result.log');

/**
 * 真实导出探针（规格 13 重设计验收）：合成三段硬切视频 → 构建含三级结构与曲线的
 * 快照 → 一次性导出 PDF / XLSX / PNG / JSON（含代表画面）→ 校验产物存在且非空。
 * 用于确认 printToPDF、exceljs、sharp 抽帧在内置 FFmpeg + 真实窗口下均可用。
 */
async function smokeExportProbe(): Promise<{
  ok: boolean;
  stage: string;
  products: number;
  pdfBytes?: number;
  xlsxBytes?: number;
  pngBytes?: number;
  frames: number;
  failures: number;
}> {
  const folder = await mkdtemp(path.join(app.getPath('temp'), 'laipian-smoke-export-'));
  try {
    const ffmpeg = resolveFfmpegPaths().ffmpeg;
    if (ffmpeg === null) {
      return { ok: false, stage: 'no-ffmpeg', products: 0, frames: 0, failures: 0 };
    }
    const source = path.join(folder, 'src.mp4');
    await execFileAsync(ffmpeg.path, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x180:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=c=white:s=320x180:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x180:r=30:d=1',
      '-filter_complex',
      '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
      '-map',
      '[out]',
      source,
    ]);

    const media = smokeProjectMedia(3000);
    const base = createInitialSnapshot({ projectId: 'smoke-export', name: '导出冒烟', media });
    const snapshot: typeof base = {
      ...base,
      structure: [
        createStructureNode({ id: 'ch', level: 'chapter', parentId: null, name: '整片', startMs: 0 }),
        createStructureNode({ id: 'sc', level: 'section', parentId: 'ch', name: '开场', startMs: 0 }),
        createStructureNode({ id: 's1', level: 'shot', parentId: 'sc', name: '镜头 1', startMs: 0 }),
        createStructureNode({ id: 's2', level: 'shot', parentId: 'sc', name: '镜头 2', startMs: 1000 }),
        createStructureNode({ id: 's3', level: 'shot', parentId: 'sc', name: '镜头 3', startMs: 2000 }),
      ],
      curve: {
        ...base.curve,
        nodes: [
          { id: 'n1', timeMs: 0, value: 20, outMode: 'linear', inHandle: null, outHandle: null },
          { id: 'n2', timeMs: 1500, value: 85, outMode: 'linear', inHandle: null, outHandle: null },
          { id: 'n3', timeMs: 3000, value: 40, outMode: 'linear', inHandle: null, outHandle: null },
        ],
      },
    };

    const request: ExportRequest = {
      projectId: 'smoke-export',
      snapshot,
      kinds: ['pdf', 'xlsx', 'png', 'json'],
      scope: { kind: 'project' },
      modules: [...DEFAULT_EXPORT_MODULES],
      frames: { ...DEFAULT_FRAME_SETTINGS, includeShotFrame: true, includeCurveNodeFrames: true },
      table: { fields: [...DEFAULT_TABLE_FIELDS] },
      layout: { ...DEFAULT_LAYOUT_SETTINGS },
      zip: false,
      suggestedName: 'smoke-export',
    };

    const result = await runExport({
      request,
      target: { path: path.join(folder, 'out'), mode: 'directory' },
      media: {
        projectId: 'smoke-export',
        folder,
        sourceAbsPath: source,
        media,
        durationMs: 3000,
        sha256: 'smoke',
      },
      ctx: { signal: new AbortController().signal, report: () => undefined, reportStep: () => undefined },
    });
    if (!result.ok) {
      return {
        ok: false,
        stage: `run:${result.error.code}:${result.error.message}`,
        products: 0,
        frames: 0,
        failures: 0,
      };
    }
    const sizeOf = async (name: string): Promise<number> =>
      fsStat(path.join(folder, 'out', name)).then((s) => s.size).catch(() => 0);
    const pdfBytes = await sizeOf('smoke-export.pdf');
    const xlsxBytes = await sizeOf('smoke-export.xlsx');
    const pngBytes = await sizeOf('smoke-export.png');
    const jsonBytes = await sizeOf('smoke-export.json');
    const ok = pdfBytes > 1000 && xlsxBytes > 1000 && pngBytes > 1000 && jsonBytes > 0;
    return {
      ok,
      stage: ok ? 'ready' : 'empty',
      products: result.data.length,
      pdfBytes,
      xlsxBytes,
      pngBytes,
      frames: 3,
      failures: 0,
    };
  } catch (error) {
    return {
      ok: false,
      stage: `error:${error instanceof Error ? error.message : String(error)}`,
      products: 0,
      frames: 0,
      failures: 0,
    };
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 时间线抽帧队列探针（本轮性能验收）：真实合成视频 →
 * 1) 单批抽 8 帧（校验批量产帧）；
 * 2) 三个不同项目并发请求，采样队列并发度（校验全局 ≤ 2 个 ffmpeg）；
 * 3) 同项目后发请求到来时，前一任务被取消并终止（校验取消机制）。
 */
async function smokeFilmstripProbe(): Promise<{
  ok: boolean;
  frames: number;
  maxRunning: number;
  cancelled: boolean;
  stage: string;
  rssMb?: number;
  load1?: number;
}> {
  const folder = await mkdtemp(path.join(app.getPath('temp'), 'laipian-smoke-fs-'));
  try {
    const ffmpeg = resolveFfmpegPaths().ffmpeg;
    if (ffmpeg === null) {
      return { ok: false, frames: 0, maxRunning: 0, cancelled: false, stage: 'no-ffmpeg' };
    }
    const source = path.join(folder, 'src.mp4');
    await execFileAsync(ffmpeg.path, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=c=white:s=320x180:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=2',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
      '-map', '[out]', source,
    ]);
    const media = smokeProjectMedia(6000);
    const base = {
      projectFolder: folder,
      sourceAbsPath: source,
      media,
      width: 320,
      height: 180,
    };

    // 1) 单批：一次 ffmpeg 抽 8 帧。
    const single = await requestFilmstripBatch({
      ...base,
      projectId: 'smoke-fs-single',
      startMs: 0,
      endMs: 3000,
      count: 8,
    });
    const frames = single.ok ? single.data.length : 0;

    // 2) 并发：三个不同项目 → 队列并发度采样应 ≤ 2。
    const samples: number[] = [];
    const timer = setInterval(() => samples.push(frameQueueStats().running), 15);
    await Promise.all([
      requestFilmstripBatch({ ...base, projectId: 'smoke-fs-a', startMs: 0, endMs: 2000, count: 12 }),
      requestFilmstripBatch({ ...base, projectId: 'smoke-fs-b', startMs: 2000, endMs: 4000, count: 12 }),
      requestFilmstripBatch({ ...base, projectId: 'smoke-fs-c', startMs: 4000, endMs: 6000, count: 12 }),
    ]);
    clearInterval(timer);
    const maxRunning = samples.reduce((m, v) => Math.max(m, v), 0);

    // 3) 取消：同项目先发大任务，随后立即发新请求 → 前一任务应被取消/截断。
    const stale = requestFilmstripBatch({
      ...base,
      projectId: 'smoke-fs-cancel',
      startMs: 0,
      endMs: 6000,
      count: 200,
    });
    const fresh = requestFilmstripBatch({
      ...base,
      projectId: 'smoke-fs-cancel',
      startMs: 0,
      endMs: 800,
      count: 4,
    });
    const staleResult = await stale;
    await fresh;
    const cancelled = !staleResult.ok || staleResult.data.length === 0;

    return {
      ok: frames === 8 && maxRunning <= 2 && cancelled,
      frames,
      maxRunning,
      cancelled,
      stage: 'ready',
      rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      load1: Number(os.loadavg()[0]?.toFixed(2) ?? 0),
    };
  } catch (error) {
    return {
      ok: false,
      frames: 0,
      maxRunning: 0,
      cancelled: false,
      stage: `error:${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 无头冒烟：等待加载 → IPC 探针 → 截图 → 打印 SMOKE_OK → exit(0)。 */

async function runSmoke(win: BrowserWindow): Promise<void> {
  const log = (message: string): void => {
    const line = `[smoke] ${message}\n`;
    process.stdout.write(line);
    try {
      appendFileSync(SMOKE_LOG_PATH, line);
    } catch {
      // 结果文件不可写不影响主流程。
    }
  };
  try {
    writeFileSync(SMOKE_LOG_PATH, '');
  } catch {
    // 忽略：仅用于清理上一次结果。
  }

  win.webContents.on('console-message', (event) => {
    const message = (event as unknown as { message?: string }).message ?? '';
    process.stdout.write(`[renderer] ${message}\n`);
  });

  await new Promise<void>((resolve, reject) => {
    const finish = setTimeout(resolve, 10_000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(finish);
      resolve();
    });
    win.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
      clearTimeout(finish);
      reject(new Error(`页面加载失败：${errorCode} ${errorDescription ?? ''}`));
    });
  });

  log(`page loaded: ${win.webContents.getURL()}`);
  await delay(1200);

  // IPC 通路探针：验证 window.laipian 注入、方法形状，
  // 以及一次真实 invoke 往返（listRecent 现已真实实现，应返回 ok + 数组）。
  const probe = await win.webContents.executeJavaScript(
    `(async () => {
      const api = window.laipian;
      if (!api) return { stage: 'missing-api' };
      const hasDialog = typeof api.dialog?.pickVideoFile === 'function'
        && typeof api.dialog?.pickProjectDir === 'function'
        && typeof api.dialog?.pickOpenProjectFolder === 'function';
      const hasSubscribe = typeof api.tasks?.subscribe === 'function';
      const hasOpenRecent = typeof api.projects?.openRecent === 'function';
      let recentOk = null;
      try {
        const resp = await api.projects.listRecent();
        recentOk = resp && resp.ok === true && Array.isArray(resp.data);
      } catch (e) {
        recentOk = 'THROWN:' + String(e).slice(0, 100);
      }
      return { stage: 'ok', hasDialog, hasSubscribe, hasOpenRecent, recentOk };
    })()`,
    true,
  );
  log(`ipc probe: ${JSON.stringify(probe)}`);
  if (
    probe?.stage !== 'ok' ||
    probe.hasDialog !== true ||
    probe.hasSubscribe !== true ||
    probe.hasOpenRecent !== true ||
    probe.recentOk !== true
  ) {
    throw new Error(`IPC 通路探针失败：${JSON.stringify(probe)}`);
  }

  // 快捷键设置通路探针（v1.1 需求 6）：全局 settings 读写往返（冒烟用独立 userData，不影响用户设置）。
  const settingsProbe = await win.webContents.executeJavaScript(
    `(async () => {
      const api = window.laipian;
      if (!api || !api.settings) return { stage: 'missing-api' };
      const before = await api.settings.get();
      const wrote = await api.settings.set({ settings: { keymap: { 'play.toggle': 'p' } } });
      const after = await api.settings.get();
      await api.settings.set({ settings: { keymap: {} } });
      return {
        stage: 'ok',
        beforeOk: before.ok === true,
        wroteOk: wrote.ok === true,
        applied: wrote.ok && wrote.data.keymap['play.toggle'] === 'p',
        persisted: after.ok && after.data.keymap['play.toggle'] === 'p',
      };
    })()`,
    true,
  );
  log(`settings probe: ${JSON.stringify(settingsProbe)}`);
  if (
    settingsProbe?.stage !== 'ok' ||
    settingsProbe.wroteOk !== true ||
    settingsProbe.applied !== true ||
    settingsProbe.persisted !== true
  ) {
    throw new Error(`快捷键设置通路探针失败：${JSON.stringify(settingsProbe)}`);
  }

  // 渲染层挂载探针：确认构建产物真实渲染（非空白页）。
  const domProbe = await win.webContents.executeJavaScript(
    `(() => ({
      home: !!document.querySelector('.home-page'),
      brand: (document.querySelector('.brand h1') || {}).textContent || null
    }))()`,
    true,
  );
  log(`dom probe: ${JSON.stringify(domProbe)}`);
  if (domProbe?.home !== true || domProbe.brand !== 'CutSpect') {
    throw new Error(`渲染层挂载探针失败：${JSON.stringify(domProbe)}`);
  }

  // 真实媒体协议探针：仅当测试素材存在时验证 laipian-media: 的取流与 seek
  // （规格 12.5 Range/206 与阶段 A 完成条件“资源读取支持 seek”）。
  const devMedia = path.resolve(process.cwd(), 'dev-assets', 'dev-test.mp4');
  if (existsSync(devMedia)) {
    const mediaProbe = await win.webContents.executeJavaScript(
      `(async () => new Promise((resolve) => {
        const v = document.createElement('video');
        v.preload = 'auto'; v.muted = true;
        v.style.display = 'none';
        const done = (payload) => { try { v.remove(); } catch (e) {} resolve(payload); };
        const timer = setTimeout(() => done({ ok: false, stage: 'timeout' }), 8000);
        v.addEventListener('error', () => { clearTimeout(timer); done({ ok: false, stage: 'error', code: v.error ? v.error.code : null }); });
        v.addEventListener('loadedmetadata', () => {
          const duration = v.duration;
          v.addEventListener('seeked', () => { clearTimeout(timer); done({ ok: true, stage: 'ready', duration, seekedTime: v.currentTime }); }, { once: true });
          v.currentTime = 2;
        }, { once: true });
        document.body.appendChild(v);
        v.src = 'laipian-media://smoketest/media/source';
      }))()`,
      true,
    );
    log(`media probe: ${JSON.stringify(mediaProbe)}`);
    if (mediaProbe?.ok !== true || Math.abs((mediaProbe.duration ?? 0) - 10) > 0.3) {
      throw new Error(`媒体协议探针失败：${JSON.stringify(mediaProbe)}`);
    }
    if (Math.abs((mediaProbe.seekedTime ?? 0) - 2) > 0.35) {
      throw new Error(`媒体 seek 探针失败：${JSON.stringify(mediaProbe)}`);
    }
  } else {
    log('media probe skipped: dev-assets/dev-test.mp4 不存在');
  }

  // 帧带 / 精确帧真实通路探针（P0：时间线帧带 + 节点帧联动）：
  // main 侧 ffmpeg 生成 → laipian-media: 命名资源（thumb/frame）→ 渲染层 <img> 解码。
  if (existsSync(devMedia)) {
    const frameProbe = await smokeFrameProbe(devMedia, win);
    log(`frame probe: ${JSON.stringify(frameProbe)}`);
    if (frameProbe.ok !== true || !(typeof frameProbe.width === 'number' && frameProbe.width > 0)) {
      throw new Error(`精确帧通路探针失败：${JSON.stringify(frameProbe)}`);
    }
    const thumbProbe = await smokeThumbProbe(devMedia, win);
    log(`thumb probe: ${JSON.stringify(thumbProbe)}`);
    if (thumbProbe.ok !== true || !(typeof thumbProbe.count === 'number' && thumbProbe.count > 0)) {
      throw new Error(`时间线缩略图通路探针失败：${JSON.stringify(thumbProbe)}`);
    }
  }

  // 智能镜头识别探针：合成硬切视频 → 内置 FFmpeg scdet → 解析切点。
  const shotProbe = await smokeShotProbe();
  log(`shot probe: ${JSON.stringify(shotProbe)}`);
  if (shotProbe.ok !== true || shotProbe.cuts < 1) {
    throw new Error(`镜头识别探针失败：${JSON.stringify(shotProbe)}`);
  }

  // 真实导出探针：合成视频 → 真实生成 PDF/XLSX/PNG/JSON（含代表画面）并校验非空。
  const exportProbe = await smokeExportProbe();
  log(`export probe: ${JSON.stringify(exportProbe)}`);
  if (exportProbe.ok !== true || exportProbe.products < 4) {
    throw new Error(`导出探针失败：${JSON.stringify(exportProbe)}`);
  }

  // 时间线抽帧队列探针：批量产帧 + 全局并发 ≤ 2 + 同项目取消终止。
  const filmstripProbe = await smokeFilmstripProbe();
  log(`filmstrip probe: ${JSON.stringify(filmstripProbe)}`);
  if (filmstripProbe.ok !== true) {
    throw new Error(`抽帧队列探针失败：${JSON.stringify(filmstripProbe)}`);
  }

  const image = await win.webContents.capturePage();
  const { writeFile } = await import('node:fs/promises');
  const target = path.join(app.getPath('temp'), 'laipian-smoke.png');
  await writeFile(target, image.toPNG());
  log(`screenshot saved: ${target}`);
  log('SMOKE_OK');
  app.exit(0);
}

/** Squirrel 调用 Update.exe：分离进程、忽略 stdio，完成后 resolve。 */
function spawnUpdateExe(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
      child.on('error', () => resolve());
      child.on('exit', () => resolve());
    } catch {
      resolve();
    }
  });
}

async function bootstrap(): Promise<void> {
  const tasks = createTaskManager();
  projectService = createProjectService({
    userDataDir: app.getPath('userData'),
    tasks,
    revealInFolder: (absPath) => {
      shell.showItemInFolder(absPath);
    },
  });
  const exportService = createExportService({
    showSaveDialog: async (options) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    showDirectoryDialog: async (options) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const openOptions = {
        title: options.title,
        properties: ['openDirectory', 'createDirectory'] as const,
      };
      const result = win
        ? await dialog.showOpenDialog(win, { ...openOptions, properties: [...openOptions.properties] })
        : await dialog.showOpenDialog({ ...openOptions, properties: [...openOptions.properties] });
      const first = result.canceled ? undefined : result.filePaths[0];
      return first ?? null;
    },
    revealInFolder: (absPath) => {
      shell.showItemInFolder(absPath);
    },
    openWithSystem: (absPath) => shell.openPath(absPath),
  });

  // 应用级设置（v1.1 快捷键自定义）：全局 userData/settings.json。
  const settingsService = createSettingsService({ userDataDir: app.getPath('userData') });

  // 自动更新：公开更新源；开发环境 / 未配置仓库时自动禁用（不打扰用户）。
  const updateService = setupAutoUpdate({
    log: (message) => process.stderr.write(`${message}\n`),
  });

  // 任务事件 → 所有窗口（规格 10.4：进度/状态/取消推送）。
  tasks.subscribe((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.taskEvent, event);
      }
    }
  });

  // 受控媒体读取协议：GET/HEAD + Range（规格 12.5）。
  protocol.handle(MEDIA_PROTOCOL_SCHEME, createMediaRequestHandler());

  // 冒烟模式：登记测试素材，供渲染层经协议真实取流与 seek 验证。
  if (IS_SMOKE) {
    const devMedia = path.resolve(process.cwd(), 'dev-assets', 'dev-test.mp4');
    if (existsSync(devMedia)) {
      registerMediaResource('smoketest', 'media', 'source', devMedia);
    }
  }

  registerIpcHandlers({
    projects: projectService,
    tasks,
    exports: exportService,
    settings: settingsService,
    updates: updateService,
    allowWindowClose: (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      windowsAllowedToClose.add(win);
      setImmediate(() => win.close());
    },
    consumePendingOpenVideo: consumePendingExternal,
  });

  mainWindow = createWindow();
  if (externalOpen) {
    attachExternalOpenDelivery(mainWindow);
  }
  appBooted = true;
  if (externalOpen) {
    externalOpen.enqueueArgv(process.argv, process.cwd());
    externalOpen.start();
    // 打包后的 Windows（含 ZIP 直出）补登记「打开方式」。
    // Squirrel 安装/卸载事件在创建窗口前已经处理过，这里是幂等补写。
    if (process.platform === 'win32' && app.isPackaged) {
      setTimeout(() => {
        try {
          applyWindowsFileAssociationsSync('install', process.execPath, logOpenWith);
        } catch (error) {
          logOpenWith(
            `[open-with] 文件关联登记失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }, 0);
    }
  }
  if (IS_SMOKE) {
    try {
      await runSmoke(mainWindow);
    } catch (error) {
      process.stderr.write(
        `[smoke] FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      app.exit(1);
    }
  }
}

// Windows Squirrel：安装/更新/卸载事件必须在创建窗口前处理，并尽快退出。
// --squirrel-firstrun（首次安装启动）不接管，应用正常显示自身。
const squirrelHandled =
  process.platform === 'win32' &&
  handleSquirrelStartup({
    argv: process.argv,
    execPath: process.execPath,
    spawn: spawnUpdateExe,
    quit: (code) => app.exit(code),
    logger: (message) => process.stderr.write(`${message}\n`),
    onInstall: () => {
      applyWindowsFileAssociationsSync('install', process.execPath, logOpenWith);
    },
    onUninstall: () => {
      applyWindowsFileAssociationsSync('uninstall', process.execPath, logOpenWith);
    },
  });

// 与 Squirrel 生成的 AppUserModelId 保持一致（任务栏归组 / 通知 / 更新识别）。
if (process.platform === 'win32') {
  app.setAppUserModelId('com.squirrel.laipian-tai.laipian-tai');
}

if (squirrelHandled) {
  // 已交由 Update.exe 维护快捷方式：等待其完成后由 quit 回调退出，不初始化应用。
} else {
  // 单实例锁：第二个实例直接退出并让已有实例聚焦（规格 8.5）。
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
  } else {
    app.on('second-instance', (_event, argv, workingDirectory) => {
      focusMainWindow();
      externalOpen?.enqueueArgv(argv, workingDirectory || process.cwd());
    });

    // macOS「打开方式」在 ready 之前就会发 open-file，必须尽早监听。
    app.on('open-file', (event, filePath) => {
      event.preventDefault();
      focusMainWindow();
      externalOpen?.enqueuePath(filePath);
    });

    void app.whenReady().then(bootstrap);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
        if (externalOpen) {
          attachExternalOpenDelivery(mainWindow);
        }
      }
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });

    // 退出前释放项目锁并注销媒体注册（规格 8.4 / 8.5）。
    app.on('before-quit', () => {
      void projectService?.releaseAllLocks();
    });
  }
}
