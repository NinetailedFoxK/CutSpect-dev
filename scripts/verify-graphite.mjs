/**
 * 石墨工作台真实窗口探针（开发期使用）。
 *
 * 加载 dev-editor.html → 加载内置测试视频 → 读取真实布局尺寸与计算样式，
 * 输出可核对的 JSON（不依赖人眼，用于自动化验收）。
 *   npx electron scripts/verify-graphite.mjs
 */
import { app, BrowserWindow } from 'electron';

const base = process.env.LAIPIAN_PREVIEW_URL ?? 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  const bg = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).backgroundColor : null;
  };
  const color = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).color : null;
  };
  const splitter = document.querySelector('.lp-splitter');
  const panelSplitter = document.querySelector('.lp-panel-splitter');
  const panel = document.querySelector('.lp-panel');
  return {
    topbar: rect('.lp-topbar'),
    toolbar: rect('.lp-toolbar'),
    playerbar: rect('.lp-playerbar'),
    panel: rect('.lp-panel'),
    timeline: rect('.lp-timeline'),
    canvasHost: rect('.lp-canvas-host'),
    topbarBg: bg('.lp-topbar'),
    toolbarBg: bg('.lp-toolbar'),
    canvasBg: bg('.lp-canvas-host'),
    timelineBg: bg('.lp-timeline'),
    bodyBg: bg('.lp-editor'),
    panelBg: bg('.lp-panel'),
    splitterPresent: !!splitter,
    splitterRole: splitter ? splitter.getAttribute('role') : null,
    splitterOrientation: splitter ? splitter.getAttribute('aria-orientation') : null,
    splitterHeight: splitter ? Math.round(splitter.getBoundingClientRect().height) : null,
    panelSplitterPresent: !!panelSplitter,
    panelSplitterOrientation: panelSplitter ? panelSplitter.getAttribute('aria-orientation') : null,
    panelInlineWidth: panel ? panel.style.width : null,
    chapterTrackBg: bg('.lp-structure-track.is-chapter'),
    shotTrackBg: bg('.lp-structure-track.is-shot'),
    structureBlockCount: document.querySelectorAll('.lp-structure-block').length,
    toolGroups: document.querySelectorAll('.lp-tool-group').length,
    panelTabs: [...document.querySelectorAll('.lp-panel-tab')].map((b) => b.textContent.trim()),
    bodyFont: getComputedStyle(document.body).fontFamily,
    bodyFontSize: getComputedStyle(document.body).fontSize,
  };
})()`;

app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      backgroundColor: '#0c0e12',
      webPreferences: { contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
    });
    await win.loadURL(`${base}/dev-editor.html`);
    await sleep(600);
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('加载内置测试视频')); if(b) b.click(); })()`,
    );
    for (let i = 0; i < 40; i++) {
      const ok = await win.webContents.executeJavaScript(`!!document.querySelector('.lp-editor')`);
      if (ok) break;
      await sleep(250);
    }
    await sleep(2500);
    const probe = await win.webContents.executeJavaScript(PROBE);
    console.log(`[verify] ${JSON.stringify(probe, null, 2)}`);
    app.quit();
  })
  .catch((error) => {
    console.error('[verify] 失败：', error);
    app.exit(1);
  });