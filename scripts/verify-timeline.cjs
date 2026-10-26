/**
 * 时间线结构验收探针（仅开发期）。
 *
 * 前提：vite dev server 已在 127.0.0.1:5173 运行。
 * 运行：ELECTRON_RUN_AS_NODE= node_modules/.bin/electron scripts/verify-timeline.cjs
 *
 * 校验（对应《时间轨修复文档》第 8.4 节）：
 * - 结构轨（章节/段落）与视频画面轨不重叠、各自固定高；
 * - 视频画面轨固定 68—76px，槽位不再被拉成狭长竖条；
 * - 可见槽必须有图片 / 加载 / 失败三者之一，不留无说明空白；
 * - 缩放与平移后结构标题仍可见（跨视口交集）。
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
      const rectOf = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
      const trackEls = [...document.querySelectorAll('.lp-structure-track')];
      const tracks = trackEls.map((t) => t.className);
      const trackRects = trackEls.map((track) => {
        const r = track.getBoundingClientRect();
        const blocks = [...track.querySelectorAll('.lp-structure-block')].map((b) => b.getBoundingClientRect());
        const maxBlockHeight = blocks.reduce((m, b) => Math.max(m, Math.round(b.height)), 0);
        const overflowing = blocks.filter((b) => b.top < r.top - 1 || b.bottom > r.bottom + 1).length;
        return { ...rectOf(track), blockCount: blocks.length, maxBlockHeight, overflowing };
      });
      const videoTrack = document.querySelector('.lp-video-track');
      const structureTracks = document.querySelector('.lp-structure-tracks');
      const ruler = document.querySelector('.lp-timeline-ruler');
      const slots = [...document.querySelectorAll('.lp-video-slot')];
      const imgs = [...document.querySelectorAll('.lp-video-img')];
      const overlays = [...document.querySelectorAll('.lp-shot-overlay-block')];
      const widths = slots.map((s) => Math.round(s.getBoundingClientRect().width));
      // 槽位宽高比：竖条（被裁窄）会 <0.6，正常 16:9 ≈1.78。
      const slotAspects = slots.map((s) => { const r = s.getBoundingClientRect(); return r.height > 0 ? Number((r.width / r.height).toFixed(3)) : 0; });
      const nameEls = [...document.querySelectorAll('.lp-structure-block-name')];
      return {
        trackCount: tracks.length,
        tracks,
        trackRects,
        structureTracks: structureTracks ? rectOf(structureTracks) : null,
        ruler: ruler ? rectOf(ruler) : null,
        videoTrack: videoTrack ? rectOf(videoTrack) : null,
        slotCount: slots.length,
        imgCount: imgs.length,
        fallbackCount: imgs.filter((i) => i.classList.contains('is-fallback')).length,
        overlayCount: overlays.length,
        noticeCount: document.querySelectorAll('.lp-filmstrip-notice').length,
        errorNotice: !!document.querySelector('.lp-filmstrip-notice.is-error'),
        clippedCount: document.querySelectorAll('.lp-structure-block.is-clipped-start, .lp-shot-overlay-block.is-clipped-start').length,
        structureNameVisibleCount: nameEls.filter((el) => el.getBoundingClientRect().width > 0 && (el.textContent || '').trim().length > 0).length,
        zoomSpanText: (() => { const el = document.querySelector('.lp-zoom-span'); return el ? (el.textContent || '').trim() : null; })(),
        followButtonText: (() => { const el = document.querySelector('.lp-follow-button'); return el ? (el.textContent || '').trim() : null; })(),
        uniqueSlotWidths: [...new Set(widths)].length,
        sampleSlotWidths: widths.slice(0, 10),
        slotAspects: slotAspects.slice(0, 10),
      };
    })()`,
  );
}

/** 轨道高度 / 上下边界 / 画面可辨认性断言。 */
function assertTimeline(label, probe) {
  const failures = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); };

  check(probe.trackCount === 2, `结构轨应为 章节+段落 两条，实际 ${probe.trackCount}`);
  check(Array.isArray(probe.trackRects) && probe.trackRects.length === probe.trackCount, '轨道测量数量与轨道数不一致');

  for (const track of probe.trackRects ?? []) {
    // 结构轨固定高：92px 结构区扣内边距/行距后每轨约 40px。
    check(track.h >= 30 && track.h <= 48, `${track.name} 高度 ${track.h} 不在固定区间 [30,48]`);
    check(track.overflowing === 0, `${track.name} 有 ${track.overflowing} 个块越出本轨上下边界`);
    check(track.maxBlockHeight <= track.h, `${track.name} 块高 ${track.maxBlockHeight} 超过轨高 ${track.h}`);
  }

  const st = probe.structureTracks;
  const vt = probe.videoTrack;
  if (st && vt) {
    check(st.bottom <= vt.top, `结构轨底 ${st.bottom} 与视频轨顶 ${vt.top} 重叠`);
  }
  if (vt) {
    // 视频画面轨固定高 72px：不再占满剩余高度（否则拉成竖条）。
    check(vt.h >= 68 && vt.h <= 76, `视频轨高度 ${vt.h} 不在固定区间 [68,76]`);
    // 槽位比例：不再是被裁成狭长竖条。
    for (const aspect of probe.slotAspects ?? []) {
      check(aspect >= 1.3 && aspect <= 2.3, `视频槽宽高比 ${aspect} 超出 [1.3,2.3]（可能被拉成竖条）`);
    }
  }
  // 可见槽必须有可辨认画面或明确状态（图片 / 加载 / 失败提示），绝不留无说明空白。
  check(
    (probe.imgCount ?? 0) > 0 || (probe.noticeCount ?? 0) > 0,
    `可见槽既无图片也无状态提示（img=${probe.imgCount}, notice=${probe.noticeCount}）`,
  );
  // 结构标题可见：跨视口 / 缩放后仍能辨认章节、段落名称。
  check((probe.structureNameVisibleCount ?? 0) > 0, '没有任何可见的结构标题（章节/段落名称）');
  // 缩放档位显示当前跨度；「回到播放头」若出现必须有文字（§6.3 / §6.4）。
  check(
    typeof probe.zoomSpanText === 'string' && probe.zoomSpanText.includes('当前范围'),
    `缩放档位未显示"当前范围"：${probe.zoomSpanText}`,
  );
  if (probe.followButtonText !== null) {
    check(probe.followButtonText.includes('回到播放头'), `回到播放头按钮缺少文字：${probe.followButtonText}`);
  }

  const status = failures.length === 0 ? 'PASS' : 'FAIL';
  console.log(`[assert:${label}] ${status}` + (failures.length ? `\n  - ${failures.join('\n  - ')}` : ''));
  return failures;
}

async function wheel(win, { deltaY, shiftKey = false, ctrlKey = false, repeat = 1 }) {
  for (let i = 0; i < repeat; i++) {
    await win.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector('.lp-timeline-ruler');
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: ${deltaY}, shiftKey: ${shiftKey}, ctrlKey: ${ctrlKey}, bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + 10 }));
        return true;
      })()`,
    );
    await sleep(120);
  }
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
  const failures = [];

  const defaultProbe = await probeTimeline(win);
  console.log('[probe:default]', JSON.stringify(defaultProbe));
  failures.push(...assertTimeline('default', defaultProbe));
  await shot(win, 'timeline-video-track');

  // 放大（Ctrl+滚轮）：帧密度随缩放变化，槽位仍等宽、仍有画面或状态。
  await wheel(win, { deltaY: -120, ctrlKey: true, repeat: 6 });
  await sleep(900);
  const zoomedProbe = await probeTimeline(win);
  console.log('[probe:zoomed]', JSON.stringify(zoomedProbe));
  failures.push(...assertTimeline('zoomed', zoomedProbe));
  await shot(win, 'timeline-video-track-zoomed');

  // 平移到视频中部（Shift+滚轮）：结构标题仍应可见（跨视口交集 / 延续标识）。
  await wheel(win, { deltaY: 120, shiftKey: true, repeat: 3 });
  await sleep(700);
  const pannedProbe = await probeTimeline(win);
  console.log('[probe:panned]', JSON.stringify(pannedProbe));
  failures.push(...assertTimeline('panned', pannedProbe));
  await shot(win, 'timeline-video-track-panned');

  if (failures.length > 0) {
    console.error(`[verify-timeline] FAIL（${failures.length} 项断言未通过）`);
    app.exit(1);
    return;
  }
  console.log('[verify-timeline] OK');
  app.exit(0);
});