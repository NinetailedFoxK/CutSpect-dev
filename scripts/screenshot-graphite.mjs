/**
 * 石墨工作台视觉验收截图（仅开发期使用，不进入打包产物）。
 *
 * 用官方 Electron 加载 vite dev server 上的开发预览页，抓取真实渲染截图：
 * - dev-home.html   → 项目库首页
 * - dev-editor.html → 加载内置测试视频后进入编辑器，检查顶栏/工具栏/监视器/
 *   播放栏/三轨时间线/右侧检查器/分割线的整体视觉与配色。
 *
 * 前提：vite dev server 已在 127.0.0.1:5173 运行。
 *   npx vite &
 *   npx wait-on tcp:127.0.0.1:5173
 *   npx electron scripts/screenshot-graphite.mjs
 */
import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = path.join(root, 'docs', 'screenshots');
const base = process.env.LAIPIAN_PREVIEW_URL ?? 'http://127.0.0.1:5173';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  const file = path.join(outDir, `${name}.png`);
  await writeFile(file, image.toPNG());
  console.log(`[screenshot] ${file}`);
}

async function waitFor(win, selector, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await win.webContents.executeJavaScript(
      `!!document.querySelector(${JSON.stringify(selector)})`,
    );
    if (found) return true;
    await sleep(250);
  }
  return false;
}

app
  .whenReady()
  .then(async () => {
    await mkdir(outDir, { recursive: true });
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      backgroundColor: '#0c0e12',
      webPreferences: { contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
    });

    // 1) 项目库首页
    await win.loadURL(`${base}/dev-home.html?view=home`);
    await sleep(1200);
    await shot(win, 'graphite-home');

    // 2) 编辑器：加载内置测试视频
    await win.loadURL(`${base}/dev-editor.html`);
    await sleep(600);
    const clicked = await win.webContents.executeJavaScript(
      `(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('加载内置测试视频'));
        if (b) { b.click(); return true; }
        return false;
      })()`,
    );
    console.log(`[screenshot] dev builtin video clicked=${clicked}`);
    const ready = await waitFor(win, '.lp-editor');
    console.log(`[screenshot] editor ready=${ready}`);
    await sleep(2500);
    await shot(win, 'graphite-editor');

    // 3) 速查面板（模拟 ? 键）
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))`,
    ).catch(() => undefined);
    await sleep(700);
    await shot(win, 'graphite-shortcuts');

    app.quit();
  })
  .catch((error) => {
    console.error('[screenshot] 失败：', error);
    app.exit(1);
  });