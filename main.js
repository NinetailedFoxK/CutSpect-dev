"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const electron_1 = require("electron");
const ipc_1 = require("./ipc");
const export_service_1 = require("./services/export-service");
const frame_service_1 = require("./services/frame-service");
const protocol_1 = require("./protocol");
const project_service_1 = require("./services/project-service");
const tasks_1 = require("./services/tasks");
const thumbnail_service_1 = require("./services/thumbnail-service");
const media_url_1 = require("../shared/media-url");
const ipc_channels_1 = require("../shared/ipc-channels");
/**
 * 拉片台主进程入口。
 *
 * 安全基线（规格 12.5）：
 * - contextIsolation: true、sandbox: true、nodeIntegration: false、webSecurity: true。
 * - 禁止远程导航与任意新窗口；CSP 由 index.html 的 meta 设置。
 * - 单实例锁（规格 8.5：应用单实例）+ 项目级 .lock（project-service）。
 *
 * 媒体读取（规格 12.5）：
 * - 注册 laipian-media: 为 standard + stream 特权协议，仅按已授权注册表
 *   提供 GET/HEAD + Range，URL 不携带绝对路径。
 *
 * --smoke：无头验证模式——启动窗口、等待渲染完成、探针 IPC、截图后退出。
 */
const DEV_SERVER_URL = process.env.LAIPIAN_DEV_SERVER_URL;
// 开发用 `electron . --smoke`；打包应用无法透传自定义开关（Chromium 会拒绝），
// 因此同时支持环境变量 LAIPIAN_SMOKE=1。
const IS_SMOKE = process.argv.includes('--smoke') || process.env.LAIPIAN_SMOKE === '1';
let mainWindow = null;
let projectService = null;
const windowsAllowedToClose = new WeakSet();
// 必须在 app ready 之前注册自定义协议特权（Electron 要求）。
electron_1.protocol.registerSchemesAsPrivileged([
    {
        scheme: protocol_1.MEDIA_PROTOCOL_SCHEME,
        privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
    },
]);
// 冒烟模式使用独立 userData：避免与正在运行的正式应用争抢单实例锁而静默退出。
if (IS_SMOKE) {
    electron_1.app.setPath('userData', node_path_1.default.join(electron_1.app.getPath('temp'), 'laipian-smoke-userdata'));
}
function isAllowedNavigation(targetUrl) {
    if (DEV_SERVER_URL && (targetUrl === DEV_SERVER_URL || targetUrl.startsWith(`${DEV_SERVER_URL}/`))) {
        return true;
    }
    // 生产环境：仅允许本地打包文件；laipian-media: 仅用于子资源，不导航。
    return targetUrl.startsWith('file://');
}
function createWindow() {
    const win = new electron_1.BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1100,
        minHeight: 720,
        backgroundColor: '#15171C',
        title: '拉片台',
        show: false,
        webPreferences: {
            preload: node_path_1.default.join(__dirname, '../preload/index.js'),
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
        win.webContents.send(ipc_channels_1.IPC_CHANNELS.appCloseRequested);
    });
    win.once('ready-to-show', () => {
        win.show();
    });
    if (DEV_SERVER_URL) {
        void win.loadURL(DEV_SERVER_URL);
        if (!IS_SMOKE) {
            win.webContents.openDevTools({ mode: 'detach' });
        }
    }
    else {
        void win.loadFile(node_path_1.default.join(__dirname, '../renderer/index.html'));
    }
    return win;
}
function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
/** 冒烟用最小 ProjectMedia（仅供抽帧缓存键与帧号计算）。 */
function smokeProjectMedia(durationMs) {
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
/** 让渲染层用 <img> 经 laipian-media: 读取一张图片，返回解码结果。 */
function probeImage(win, url, timeoutMs = 6000) {
    return win.webContents.executeJavaScript(`(async () => new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => resolve({ ok: false, stage: 'timeout' }), ${timeoutMs});
      img.onload = () => { clearTimeout(timer); resolve({ ok: true, stage: 'ready', width: img.naturalWidth, height: img.naturalHeight }); };
      img.onerror = () => { clearTimeout(timer); resolve({ ok: false, stage: 'error' }); };
      img.src = ${JSON.stringify(url)};
    }))()`, true);
}
/** 精确帧通路探针：main 侧 ffmpeg 抽帧 → 协议命名资源 → img 解码（节点联动核心）。 */
async function smokeFrameProbe(sourceAbsPath, win) {
    const folder = await (0, promises_1.mkdtemp)(node_path_1.default.join(electron_1.app.getPath('temp'), 'laipian-smoke-frame-'));
    try {
        (0, protocol_1.registerMediaResource)('smoketest', 'media', 'frame', node_path_1.default.join(folder, 'cache', 'frames'));
        const generated = await (0, frame_service_1.getFramePreview)({
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
    }
    finally {
        await (0, promises_1.rm)(folder, { recursive: true, force: true }).catch(() => undefined);
    }
}
/** 时间线缩略图通路探针：main 侧生成缩略图 → 协议命名资源 → img 解码。 */
async function smokeThumbProbe(sourceAbsPath, win) {
    const folder = await (0, promises_1.mkdtemp)(node_path_1.default.join(electron_1.app.getPath('temp'), 'laipian-smoke-thumb-'));
    try {
        const generated = await (0, thumbnail_service_1.generateThumbnails)({
            sourceAbsPath,
            projectFolder: folder,
            durationMs: 10_000,
            sha256: 'smoke',
        });
        if (!generated.ok) {
            return { ok: false, stage: `generate:${generated.error.code}` };
        }
        (0, protocol_1.registerMediaResource)('smoketest', 'media', 'thumb', node_path_1.default.join(folder, 'cache', 'thumbs'));
        const entries = await (0, thumbnail_service_1.listThumbnailEntries)(folder, 10_000);
        const first = entries[0];
        if (first === undefined) {
            return { ok: false, stage: 'empty' };
        }
        const url = (0, media_url_1.buildMediaUrl)('smoketest', 'media', 'thumb', 'smoke', first.name);
        const probe = await probeImage(win, url);
        return { ...probe, count: entries.length };
    }
    finally {
        await (0, promises_1.rm)(folder, { recursive: true, force: true }).catch(() => undefined);
    }
}
/** 无头冒烟：等待加载 → IPC 探针 → 截图 → 打印 SMOKE_OK → exit(0)。 */
async function runSmoke(win) {
    const log = (message) => {
        process.stdout.write(`[smoke] ${message}\n`);
    };
    win.webContents.on('console-message', (event) => {
        const message = event.message ?? '';
        process.stdout.write(`[renderer] ${message}\n`);
    });
    await new Promise((resolve, reject) => {
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
    const probe = await win.webContents.executeJavaScript(`(async () => {
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
    })()`, true);
    log(`ipc probe: ${JSON.stringify(probe)}`);
    if (probe?.stage !== 'ok' ||
        probe.hasDialog !== true ||
        probe.hasSubscribe !== true ||
        probe.hasOpenRecent !== true ||
        probe.recentOk !== true) {
        throw new Error(`IPC 通路探针失败：${JSON.stringify(probe)}`);
    }
    // 渲染层挂载探针：确认构建产物真实渲染（非空白页）。
    const domProbe = await win.webContents.executeJavaScript(`(() => ({
      home: !!document.querySelector('.home-page'),
      brand: (document.querySelector('.brand h1') || {}).textContent || null
    }))()`, true);
    log(`dom probe: ${JSON.stringify(domProbe)}`);
    if (domProbe?.home !== true || domProbe.brand !== '拉片台') {
        throw new Error(`渲染层挂载探针失败：${JSON.stringify(domProbe)}`);
    }
    // 真实媒体协议探针：仅当测试素材存在时验证 laipian-media: 的取流与 seek
    // （规格 12.5 Range/206 与阶段 A 完成条件“资源读取支持 seek”）。
    const devMedia = node_path_1.default.resolve(process.cwd(), 'dev-assets', 'dev-test.mp4');
    if ((0, node_fs_1.existsSync)(devMedia)) {
        const mediaProbe = await win.webContents.executeJavaScript(`(async () => new Promise((resolve) => {
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
      }))()`, true);
        log(`media probe: ${JSON.stringify(mediaProbe)}`);
        if (mediaProbe?.ok !== true || Math.abs((mediaProbe.duration ?? 0) - 10) > 0.3) {
            throw new Error(`媒体协议探针失败：${JSON.stringify(mediaProbe)}`);
        }
        if (Math.abs((mediaProbe.seekedTime ?? 0) - 2) > 0.35) {
            throw new Error(`媒体 seek 探针失败：${JSON.stringify(mediaProbe)}`);
        }
    }
    else {
        log('media probe skipped: dev-assets/dev-test.mp4 不存在');
    }
    // 帧带 / 精确帧真实通路探针（P0：时间线帧带 + 节点帧联动）：
    // main 侧 ffmpeg 生成 → laipian-media: 命名资源（thumb/frame）→ 渲染层 <img> 解码。
    if ((0, node_fs_1.existsSync)(devMedia)) {
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
    const image = await win.webContents.capturePage();
    const { writeFile } = await Promise.resolve().then(() => __importStar(require('node:fs/promises')));
    const target = node_path_1.default.join(electron_1.app.getPath('temp'), 'laipian-smoke.png');
    await writeFile(target, image.toPNG());
    log(`screenshot saved: ${target}`);
    log('SMOKE_OK');
    electron_1.app.exit(0);
}
async function bootstrap() {
    const tasks = (0, tasks_1.createTaskManager)();
    projectService = (0, project_service_1.createProjectService)({
        userDataDir: electron_1.app.getPath('userData'),
        tasks,
        revealInFolder: (absPath) => {
            electron_1.shell.showItemInFolder(absPath);
        },
    });
    const exportService = (0, export_service_1.createExportService)({
        showSaveDialog: async (options) => {
            const win = electron_1.BrowserWindow.getFocusedWindow() ?? electron_1.BrowserWindow.getAllWindows()[0];
            const result = win
                ? await electron_1.dialog.showSaveDialog(win, options)
                : await electron_1.dialog.showSaveDialog(options);
            return result.canceled || !result.filePath ? null : result.filePath;
        },
    });
    // 任务事件 → 所有窗口（规格 10.4：进度/状态/取消推送）。
    tasks.subscribe((event) => {
        for (const win of electron_1.BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                win.webContents.send(ipc_channels_1.IPC_CHANNELS.taskEvent, event);
            }
        }
    });
    // 受控媒体读取协议：GET/HEAD + Range（规格 12.5）。
    electron_1.protocol.handle(protocol_1.MEDIA_PROTOCOL_SCHEME, (0, protocol_1.createMediaRequestHandler)());
    // 冒烟模式：登记测试素材，供渲染层经协议真实取流与 seek 验证。
    if (IS_SMOKE) {
        const devMedia = node_path_1.default.resolve(process.cwd(), 'dev-assets', 'dev-test.mp4');
        if ((0, node_fs_1.existsSync)(devMedia)) {
            (0, protocol_1.registerMediaResource)('smoketest', 'media', 'source', devMedia);
        }
    }
    (0, ipc_1.registerIpcHandlers)({
        projects: projectService,
        tasks,
        exports: exportService,
        allowWindowClose: (event) => {
            const win = electron_1.BrowserWindow.fromWebContents(event.sender);
            if (!win || win.isDestroyed())
                return;
            windowsAllowedToClose.add(win);
            setImmediate(() => win.close());
        },
    });
    mainWindow = createWindow();
    if (IS_SMOKE) {
        try {
            await runSmoke(mainWindow);
        }
        catch (error) {
            process.stderr.write(`[smoke] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
            electron_1.app.exit(1);
        }
    }
}
// 单实例锁：第二个实例直接退出并让已有实例聚焦（规格 8.5）。
const gotSingleInstanceLock = electron_1.app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    electron_1.app.quit();
}
else {
    electron_1.app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.focus();
        }
    });
    void electron_1.app.whenReady().then(bootstrap);
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            mainWindow = createWindow();
        }
    });
    electron_1.app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            electron_1.app.quit();
        }
    });
    // 退出前释放项目锁并注销媒体注册（规格 8.4 / 8.5）。
    electron_1.app.on('before-quit', () => {
        void projectService?.releaseAllLocks();
    });
}
//# sourceMappingURL=main.js.map