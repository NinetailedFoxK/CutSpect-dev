/**
 * 时间线结构验收探针（仅开发期）。
 *
 * 前提：vite dev server 已在 127.0.0.1:5173 运行。
 * 运行：ELECTRON_RUN_AS_NODE= node_modules/.bin/electron scripts/verify-timeline.cjs
 *
 * 校验：结构轨（章节/段落）+ 独立视频画面轨（等宽连续帧）+ 镜头叠加层 + 无黑区。
 */
const { app, BrowserWindow } = require('electron');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots');
const base = process.env.LAIPIAN_PREVIEW_URL ?? 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  await writeFile(path.join(outDir, `${name}.png`), image.toPNG());
  console.log(`[screenshot] ${path.join(outDir, `${name}.png`)}`);
}

async function probeTimeline(win) {
  return win.webContents.executeJavaScript(
    `(() => {
      const rectOf = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; };
      const tracks = [...document.querySelectorAll('.lp-structure-track')].map((t) => t.className);
      const videoTrack = document.querySelector('.lp-video-track');
      const ruler = document.querySelector('.lp-timeline-ruler');
      const slots = [...document.querySelectorAll('.lp-video-slot')];
      const imgs = [...document.querySelectorAll('.lp-video-img')];
      const overlays = [...document.querySelectorAll('.lp-shot-overlay-block')];
      const widths = slots.map((s) => Math.round(s.getBoundingClientRect().width));
      return {
        trackCount: tracks.length,
        tracks,
        ruler: ruler ? rectOf(ruler) : null,
        videoTrack: videoTrack ? rectOf(videoTrack) : null,
        slotCount: slots.length,
        imgCount: imgs.length,
        overlayCount: overlays.length,
        uniqueSlotWidths: [...new Set(widths)].length,
        sampleSlotWidths: widths.slice(0, 10),
      };
    })()`,
  );
}

app.whenReady().then(async () => {
  await mkdir(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#0c0e12',
    webPreferences: { contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
  });

  await win.loadURL(`${base}/dev-editor.html`);
  await sleep(900);
  await win.webContents.executeJavaScript(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('加载内置测试视频')); if (b) { b.click(); return true; } return false; })()`,
  );
  for (let i = 0; i < 40; i++) {
    const ok = await win.webContents.executeJavaScript(`!!document.querySelector('.lp-timeline-ruler')`);
    if (ok) break;
    await sleep(250);
  }
  await sleep(2500);
  console.log('[probe:default]', JSON.stringify(await probeTimeline(win)));
  await shot(win, 'timeline-video-track');

  // 放大时间线（Ctrl+滚轮）→ 帧密度应增加、槽位仍等宽。
  for (let i = 0; i < 6; i++) {
    await win.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector('.lp-timeline-ruler');
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + 10 }));
        return true;
      })()`,
    );
    await sleep(120);
  }
  await sleep(900);
  console.log('[probe:zoomed]', JSON.stringify(await probeTimeline(win)));
  await shot(win, 'timeline-video-track-zoomed');

  app.exit(0);
});