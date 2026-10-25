/*
 * 生成 Windows 图标 assets/icon.ico（仅开发期脚本）。
 *
 * 用法：node scripts/build-icon-ico.cjs
 * 来源：assets/icon.iconset 下的 PNG（与 macOS icon.icns 同源），
 * 把 16/32/64/128/256 五个尺寸以 PNG 压缩方式装入 ICO 容器。
 * 与 scripts/build-icon.cjs（macOS .icns）成对，保证两端图标一致。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const iconset = path.join(root, 'assets', 'icon.iconset');

/** 装进 ICO 的尺寸（256 在目录项中用 0 表示）。 */
const entries = [
  [16, 'icon_16x16.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_256x256.png'],
];

const images = entries.map(([size, file]) => ({
  size,
  png: fs.readFileSync(path.join(iconset, file)),
}));

const dirHeader = Buffer.alloc(6);
dirHeader.writeUInt16LE(0, 0); // reserved
dirHeader.writeUInt16LE(1, 2); // type: icon
dirHeader.writeUInt16LE(images.length, 4);

let offset = 6 + 16 * images.length;
const dirEntries = [];
for (const { size, png } of images) {
  const entry = Buffer.alloc(16);
  const dim = size >= 256 ? 0 : size;
  entry.writeUInt8(dim, 0); // width
  entry.writeUInt8(dim, 1); // height
  entry.writeUInt8(0, 2); // color count
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bit count
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += png.length;
  dirEntries.push(entry);
}

const ico = Buffer.concat([dirHeader, ...dirEntries, ...images.map((i) => i.png)]);
fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), ico);
console.log(`[build-icon-ico] ${images.length} sizes -> assets/icon.ico (${ico.length} bytes)`);