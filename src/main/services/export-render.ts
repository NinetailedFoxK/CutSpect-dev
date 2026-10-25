import { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';

/**
 * 导出渲染器（批次 B-2 / B-4）：把已生成的 HTML 转成 PDF / PNG。
 *
 * 使用 Electron 隐藏 BrowserWindow：
 * - PDF：webContents.printToPDF（保留排版与内联画面，可直接阅读/发送/打印）；
 * - PNG：先按内容尺寸调整窗口，再 capturePage（用于"完整节奏谱"）。
 *
 * 本模块依赖 electron（需真实窗口环境），其字符串内容由 shared/export-html 的
 * 纯函数覆盖单测；渲染本身在真实窗口内验证（与 render-png.ts 同策略）。
 */

const LOAD_TIMEOUT_MS = 30_000;

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlDataUrl(html: string): string {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
}

async function withWindow<T>(run: (win: BrowserWindow) => Promise<T>): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    width: 1240,
    height: 1754,
    useContentSize: true,
    webPreferences: {
      offscreen: false,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      javascript: true,
    },
  });
  try {
    return await run(win);
  } finally {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
}

/** 加载 HTML（data URL）并等待图片解码完成。 */
async function loadHtml(win: BrowserWindow, html: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('导出页面加载超时。')), LOAD_TIMEOUT_MS);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
    win.webContents.once('did-fail-load', (_e, code, description) => {
      clearTimeout(timer);
      reject(new Error(`导出页面加载失败：${code} ${description ?? ''}`));
    });
    void win.loadURL(htmlDataUrl(html));
  });
  // 等待所有内联 <img> 解码（data URL，通常紧随加载完成）。
  await win.webContents
    .executeJavaScript(
      `Promise.all(Array.from(document.images).map((img) =>
        img.complete ? Promise.resolve() : new Promise((r) => { img.onload = r; img.onerror = r; })))`.trim(),
      true,
    )
    .catch(() => undefined);
}

export interface PdfRenderOptions {
  landscape: boolean;
  showHeader: boolean;
  showPageNumber: boolean;
  projectName: string;
  generatedAt?: string;
}

/**
 * 渲染 HTML → PDF 并写入目标路径。
 * 支持页眉（项目名）与页码（第 N / M 页）；背景色保留（printBackground）。
 */
export async function renderHtmlToPdf(
  html: string,
  targetPath: string,
  options: PdfRenderOptions,
): Promise<void> {
  await withWindow(async (win) => {
    await loadHtml(win, html);
    const showFooter = options.showPageNumber;
    const showHeader = options.showHeader;
    const footer = showFooter
      ? `<div style="font-size:9px;width:100%;text-align:center;color:#8A93A6;padding:0 14mm;">${escapeAttr(options.projectName)} · 第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</div>`
      : '<div></div>';
    const header = showHeader
      ? `<div style="font-size:9px;width:100%;text-align:right;color:#8A93A6;padding:0 14mm;">${escapeAttr(options.projectName)}</div>`
      : '<div></div>';
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      landscape: options.landscape,
      pageSize: 'A4',
      displayHeaderFooter: showHeader || showFooter,
      headerTemplate: header,
      footerTemplate: footer,
      margins: {
        top: showHeader ? 0.7 : 0.35,
        bottom: showFooter ? 0.7 : 0.35,
        left: 0.2,
        right: 0.2,
      },
      preferCSSPageSize: false,
    });
    await writeFile(targetPath, pdf);
  });
}

/** 渲染 HTML → PNG（整页截图），并写入目标路径。用于"完整节奏谱"。 */
export async function renderHtmlToPng(html: string, targetPath: string): Promise<void> {
  await withWindow(async (win) => {
    await loadHtml(win, html);
    const size = (await win.webContents.executeJavaScript(
      `(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))()`,
      true,
    )) as { width: number; height: number };
    const width = Math.max(320, Math.min(4000, Math.round(size.width)));
    const height = Math.max(200, Math.min(4000, Math.round(size.height)));
    win.setContentSize(width, height);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const image = await win.webContents.capturePage({
      x: 0,
      y: 0,
      width,
      height,
    });
    await writeFile(targetPath, image.toPNG());
  });
}