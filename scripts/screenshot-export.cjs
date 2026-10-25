/**
 * 导出中心截图（仅开发期使用）。
 *
 * 加载 vite dev server 的 dev-editor.html → 进入编辑器 → 打开导出对话框，
 * 分别抓标准导出与专业自定义两种状态的截图。
 *
 * 前提：vite dev server 已在 127.0.0.1:5173 运行。
 * 运行：ELECTRON_RUN_AS_NODE= node_modules/.bin/electron scripts/screenshot-export.cjs
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
  const file = path.join(outDir, `${name}.png`);
  await writeFile(file, image.toPNG());
  console.log(`[screenshot] ${file}`);
}

async function waitFor(win, check, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await win.webContents.executeJavaScript(check);
    if (found) return true;
    await sleep(250);
  }
  return false;
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
    `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('加载内置测试视频'));
      if (b) { b.click(); return true; }
      return false;
    })()`,
  );

  const editorReady = await waitFor(
    win,
    `([...document.querySelectorAll('.lp-topbar-button')].some((x) => x.textContent.includes('导出')))`,
  );
  console.log(`[screenshot] editor ready: ${editorReady}`);

  const opened = await win.webContents.executeJavaScript(
    `(() => {
      const b = [...document.querySelectorAll('.lp-topbar-button')].find((x) => x.textContent.includes('导出'));
      if (b) { b.click(); return true; }
      return false;
    })()`,
  );
  console.log(`[screenshot] export opened: ${opened}`);
  await sleep(800);

  const probe = await win.webContents.executeJavaScript(
    `(() => {
      const dlg = document.querySelector('.lp-export-dialog');
      const dlgStyle = dlg ? getComputedStyle(dlg) : null;
      const choices = [...document.querySelectorAll('.lp-export-choice')].map((b) => {
        const cs = getComputedStyle(b);
        return {
          text: (b.innerText || '').replace(/\\n/g, ' | '),
          color: cs.color,
          bg: cs.backgroundColor,
          display: cs.display,
          h: b.offsetHeight,
          w: b.offsetWidth,
        };
      });
      const title = document.querySelector('.lp-export-choice-title');
      const titleStyle = title ? getComputedStyle(title) : null;
      const sheets = [...document.styleSheets].map((s) => s.href || '(inline)');
      const hasExportRule = [...document.styleSheets].some((s) => {
        try {
          return [...s.cssRules].some((r) => (r.cssText || '').includes('lp-export-choice'));
        } catch (e) {
          return false;
        }
      });
      return {
        dialogBg: dlgStyle ? dlgStyle.backgroundColor : null,
        dialogColor: dlgStyle ? dlgStyle.color : null,
        choices,
        titleColor: titleStyle ? titleStyle.color : null,
        titleFont: titleStyle ? titleStyle.fontSize : null,
        sheets,
        hasExportRule,
      };
    })()`,
  );
  console.log(`[probe] ${JSON.stringify(probe)}`);

  await shot(win, 'export-standard');

  const custom = await win.webContents.executeJavaScript(
    `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('专业自定义'));
      if (b) { b.click(); return true; }
      return false;
    })()`,
  );
  console.log(`[screenshot] custom toggled: ${custom}`);
  await sleep(800);
  await shot(win, 'export-custom');

  app.exit(0);
});