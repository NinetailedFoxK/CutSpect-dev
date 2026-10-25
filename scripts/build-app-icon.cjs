/**
 * 应用图标生成（仅开发期，不进入打包产物）。
 *
 * 用 Electron（系统 WebKit/Blink）把 assets/icon.svg 渲染为 1024×1024 PNG，
 * 再用 macOS 自带 sips 生成 icon.iconset 各尺寸，最后用 build-icon.cjs 合成 icon.icns。
 * 选 Electron 而非第三方栅格化，是因为新 Logo 用了 linearGradient / clipPath /
 * feDropShadow，浏览器内核渲染最忠实（与运行时显示一致）。
 *
 * 用法：ELECTRON_RUN_AS_NODE= node_modules/.bin/electron scripts/build-app-icon.cjs
 */
const { app, BrowserWindow } = require('electron');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'assets');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const svg = await readFile(path.join(assets, 'icon.svg'), 'utf8');
  // 强制输出尺寸（保留 viewBox，等比缩放）。
  const scaled = svg.replace(/width="1254"\s+height="1254"/, 'width="1024" height="1024"');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;}svg{display:block;width:1024px;height:1024px;}</style></head><body>${scaled}</body></html>`;

  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    useContentSize: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, sandbox: true, offscreen: false },
  });
  await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`);
  await sleep(400);
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  await writeFile(path.join(assets, 'icon-1024.png'), image.toPNG());
  console.log('[icon] wrote assets/icon-1024.png');
  app.exit(0);
});