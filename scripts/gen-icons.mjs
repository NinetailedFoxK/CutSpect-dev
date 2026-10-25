/**
 * 从 src/renderer/assets/icons/ 的 SVG 源生成 React 图标数据模块（仅开发期脚本）。
 *
 * 用法：node scripts/gen-icons.mjs
 * 输出：src/renderer/components/icon-data.ts（ICONS / ICON_LABELS / ICON_SHORTCUTS）
 *
 * 这样做的原因：Electron 以 file:// 加载渲染层，`<use href>` 引用外部雪碧图在
 * 打包后不可靠；把图标内联进 TS 模块可随构建一起打包，且无需运行时请求。
 * 后续替换图标只需替换 assets/icons 下的 SVG 并重新运行本脚本。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const srcDir = path.join(root, 'src', 'renderer', 'assets', 'icons');
const outFile = path.join(root, 'src', 'renderer', 'components', 'icon-data.ts');

const meta = JSON.parse(await readFile(path.join(srcDir, 'icons.json'), 'utf8'));
const labels = Object.fromEntries(meta.map((m) => [m.name, m.label]));
const shortcuts = Object.fromEntries(meta.map((m) => [m.name, m.shortcut || '']));

const files = (await readdir(srcDir)).filter(
  (f) => f.endsWith('.svg') && f !== 'laipian-icons.svg',
);

const entries = [];
for (const file of files.sort()) {
  const name = file.replace(/\.svg$/, '');
  const raw = await readFile(path.join(srcDir, file), 'utf8');
  const viewBox = /viewBox="([^"]+)"/.exec(raw)?.[1] ?? '0 0 24 24';
  const body = raw
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  entries.push({ name, viewBox, body });
}

const lines = [];
lines.push('/* 自动生成，请勿手改：由 scripts/gen-icons.mjs 从 src/renderer/assets/icons/ 生成。 */');
lines.push('');
lines.push('export interface IconDef {');
lines.push('  viewBox: string;');
lines.push('  body: string;');
lines.push('}');
lines.push('');
lines.push('export const ICONS: Record<string, IconDef> = {');
for (const entry of entries) {
  lines.push(
    `  ${JSON.stringify(entry.name)}: { viewBox: ${JSON.stringify(entry.viewBox)}, body: ${JSON.stringify(entry.body)} },`,
  );
}
lines.push('};');
lines.push('');
lines.push('export const ICON_LABELS: Record<string, string> = {');
for (const [key, value] of Object.entries(labels)) {
  lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
}
lines.push('};');
lines.push('');
lines.push('export const ICON_SHORTCUTS: Record<string, string> = {');
for (const [key, value] of Object.entries(shortcuts)) {
  lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
}
lines.push('};');
lines.push('');

await writeFile(outFile, lines.join('\n'), 'utf8');
console.log(`[gen-icons] ${entries.length} icons -> ${path.relative(root, outFile)}`);