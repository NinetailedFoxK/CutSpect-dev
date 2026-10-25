/**
 * 批次验证截图脚本（仅开发期使用，不进入打包产物）。
 *
 * 用官方 Electron 加载 vite dev server 上的开发预览页 dev-home.html，
 * 逐个切换 view（home / import / feedback / confirm）并抓取真实渲染截图，
 * 输出到 docs/screenshots/。前提：vite dev server 已在 127.0.0.1:5173 运行。
 *
 * 用法：
 *   npm run dev:renderer &            # 或 npx vite
 *   npx wait-on tcp:127.0.0.1:5173
 *   npx electron scripts/screenshot.mjs
 */
import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = path.join(root, 'docs', 'screenshots');
const base = process.env.LAIPIAN_PREVIEW_URL ?? 'http://127.0.0.1:5173/dev-home.html';
const views = (process.env.LAIPIAN_PREVIEW_VIEWS ?? 'home,import,feedback,confirm')
  .split(',')
  .map((v) => v.trim())
  .filter((v) => v.length > 0);

app
  .whenReady()
  .then(async () => {
    await mkdir(outDir, { recursive: true });
    const win = new BrowserWindow({
      width: 1320,
      height: 900,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    for (const view of views) {
      await win.loadURL(`${base}?view=${view}`);
      // 工作台预览页先加载内置测试视频，再等待播放器与布局稳定。
      if (base.includes('dev-editor.html')) {
        await win.webContents.executeJavaScript(
          "document.querySelector('.dev-builtin-button')?.click()",
        );
      }
      // 等待字体/布局稳定与 useEffect 内注入的反馈状态渲染完成。
      await new Promise((resolve) => setTimeout(resolve, base.includes('dev-editor.html') ? 2200 : 1000));
      const image = await win.webContents.capturePage();
      const file = path.join(outDir, `batch1-${view}.png`);
      await writeFile(file, image.toPNG());
      console.log(`[screenshot] ${file}`);
    }
    app.quit();
  })
  .catch((error) => {
    console.error('[screenshot] 失败：', error);
    app.exit(1);
  });
