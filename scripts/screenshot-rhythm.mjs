/**
 * 石墨节奏台视觉验收截图（仅开发期，不进入打包产物）。
 *
 * 前提：vite dev server 已在 127.0.0.1:5173 运行。
 *   npx vite &
 *   npx wait-on tcp:127.0.0.1:5173
 *   npx electron scripts/screenshot-rhythm.mjs
 *
 * 抓取三张图并输出探针：
 * - rhythm-editor          默认（含镜头索引 / 读谱工具条 / 状态栏 / 检查器）
 * - rhythm-inspector-collapsed  收起右侧检查器后
 * - rhythm-rail-collapsed       收起左侧镜头索引后
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

async function waitFor(win, selector, timeoutMs = 15000) {
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
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });

    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log('[console]', level, message);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.log('[render-gone]', JSON.stringify(details));
    });

    await win.loadURL(`${base}/dev-home.html?view=home`);
    await sleep(1400);
    await shot(win, 'rhythm-home');

    await win.loadURL(`${base}/dev-editor.html`);
    await sleep(600);
    const clicked = await win.webContents.executeJavaScript(
      `(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('加载内置测试视频'));
        if (b) { b.click(); return true; }
        return false;
      })()`,
    );
    const ready = await waitFor(win, '.lp-editor');
    console.log(`[screenshot] builtin clicked=${clicked} editorReady=${ready}`);
    await sleep(2600);

    const probe = await win.webContents.executeJavaScript(
      `(() => {
        const rect = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
        const radius = (s) => { const el = document.querySelector(s); return el ? getComputedStyle(el).borderRadius : null; };
        return {
          rail: !!document.querySelector('.lp-rail'),
          railItems: document.querySelectorAll('.lp-rail-item').length,
          railWidth: rect('.lp-rail')?.w ?? 0,
          stage: !!document.querySelector('.lp-stage'),
          score: !!document.querySelector('.lp-score'),
          scoreToolButtons: document.querySelectorAll('.lp-score-toolbar .lp-tool-slot').length,
          shotBarInToolbar: !!document.querySelector('.lp-score-toolbar .lp-shot-bar'),
          statusBar: !!document.querySelector('.lp-statusbar'),
          statusText: document.querySelector('.lp-statusbar')?.textContent?.slice(0, 60) ?? null,
          canvasRadius: radius('.lp-canvas-host'),
          timelineRadius: radius('.lp-timeline'),
          timelineMargin: (() => { const el = document.querySelector('.lp-timeline'); return el ? getComputedStyle(el).margin : null; })(),
          panel: !!document.querySelector('.lp-panel'),
          oldToolbarWall: !!document.querySelector('.lp-body > .lp-toolbar'),
          shotFrames: document.querySelectorAll('.lp-structure-track.is-shot .lp-shot-frames').length,
          shotFrameImgs: document.querySelectorAll('.lp-shot-frame img').length,
          standaloneFilmstrip: !!document.querySelector('.lp-timeline-body'),
          svgIcons: document.querySelectorAll('.lp-editor svg').length,
          v2ViewBox: document.querySelectorAll('.lp-editor svg[viewBox="0 0 24 24"]').length,
          badGlyphs: (() => {
            const t = document.body.innerText;
            return ['◆', '🔒', '🔓', '▶', '▼', '◂', '▸', '←', '→'].filter((c) => t.includes(c));
          })(),
          toolBtnSize: (() => {
            const b = document.querySelector('.lp-score-toolbar .lp-tool-slot');
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) };
          })(),
          toolSlotKeys: document.querySelectorAll('.lp-score-toolbar .lp-tool-slot-key').length,
          thumbNaturals: [...document.querySelectorAll('.lp-shot-frame img, .lp-filmstrip-img')]
            .map((i) => i.naturalWidth)
            .filter((n) => n > 0)
            .slice(0, 5),
        };
      })()`,
    );
    console.log('[probe:default]', JSON.stringify(probe));
    await shot(win, 'rhythm-editor');

    // 悬停提示：把鼠标移到工具栏第一个按钮上，等待 450ms 延迟后检查提示。
    const btnRect = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.lp-score-toolbar .lp-tool-slot'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    );
    let tipText = null;
    if (btnRect !== null) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: btnRect.x, y: btnRect.y });
      await sleep(900);
      tipText = await win.webContents.executeJavaScript(
        `(() => { const t = document.querySelector('.lp-tooltip'); return t ? t.textContent : null; })()`,
      );
    }
    console.log('[probe:tooltip]', JSON.stringify(tipText));
    await shot(win, 'rhythm-tooltip');

    const legendProbe = await win.webContents.executeJavaScript(
      `(() => ({ legend: document.querySelectorAll('.lp-timeline-legend .lp-legend-item').length }))()`,
    );
    const openedLayers = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.lp-topbar-button[aria-label="图层设置"]'); if (b) { b.click(); return true; } return false; })()`,
    );
    await sleep(400);
    const layerProbe = await win.webContents.executeJavaScript(
      `(() => ({ opened: ${openedLayers}, layerIcons: document.querySelectorAll('.lp-layers-popover .lp-layer-name svg').length }))()`,
    );
    console.log('[probe:legend]', JSON.stringify(legendProbe), '[probe:layers]', JSON.stringify(layerProbe));
    await shot(win, 'rhythm-layers');
    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.lp-topbar-button[aria-label="图层设置"]'); if (b) b.click(); return true; })()`,
    );
    await sleep(200);

    const toSheet = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.lp-monitor-button[aria-label="谱面视图"]'); if (b) { b.click(); return true; } return false; })()`,
    );
    await sleep(800);
    const probeSheet = await win.webContents.executeJavaScript(
      `(() => ({
        toggled: ${toSheet},
        scoreCanvas: !!document.querySelector('.lp-score-canvas'),
        gridInScore: document.querySelectorAll('.lp-score-canvas .lp-grid-line').length,
        curveInScore: document.querySelectorAll('.lp-score-canvas .lp-curve-layer').length,
        curveInVideo: document.querySelectorAll('.lp-canvas-host .lp-curve-layer').length,
      }))()`,
    );
    console.log('[probe:sheet]', JSON.stringify(probeSheet));
    await shot(win, 'rhythm-sheet');
    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.lp-monitor-button[aria-label="叠加视图"]'); if (b) b.click(); return true; })()`,
    );
    await sleep(500);
    const backOverlay = await win.webContents.executeJavaScript(
      `(() => ({ scoreCanvas: !!document.querySelector('.lp-score-canvas'), curveInVideo: document.querySelectorAll('.lp-canvas-host .lp-curve-layer').length }))()`,
    );
    console.log('[probe:back-to-overlay]', JSON.stringify(backOverlay));

    const collapsedInspector = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.lp-panel-collapse'); if (b) { b.click(); return true; } return false; })()`,
    );
    await sleep(500);
    const probe2 = await win.webContents.executeJavaScript(
      `(() => ({ handle: !!document.querySelector('.lp-panel-handle'), panel: !!document.querySelector('.lp-panel') }))()`,
    );
    console.log(`[probe:inspector-collapsed] clicked=${collapsedInspector}`, JSON.stringify(probe2));
    await shot(win, 'rhythm-inspector-collapsed');

    await win.webContents.executeJavaScript(
      `(() => {
        const expand = document.querySelector('.lp-panel-handle');
        if (expand) expand.click();
        const rail = document.querySelector('.lp-rail .lp-rail-handle');
        if (rail) rail.click();
        return true;
      })()`,
    );
    await sleep(500);
    const probe3 = await win.webContents.executeJavaScript(
      `(() => {
        const rail = document.querySelector('.lp-rail');
        return {
          collapsed: rail ? rail.classList.contains('is-collapsed') : null,
          width: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
          panel: !!document.querySelector('.lp-panel'),
        };
      })()`,
    );
    console.log('[probe:rail-collapsed]', JSON.stringify(probe3));
    await shot(win, 'rhythm-rail-collapsed');

    app.quit();
  })
  .catch((error) => {
    console.error('[screenshot] 失败：', error);
    app.exit(1);
  });