const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const iconset = path.join(root, 'assets', 'icon.iconset');
const entries = [
  ['icp4', 'icon_16x16.png'],
  ['icp5', 'icon_32x32.png'],
  ['icp6', 'icon_32x32@2x.png'],
  ['ic07', 'icon_128x128.png'],
  ['ic08', 'icon_256x256.png'],
  ['ic09', 'icon_512x512.png'],
  ['ic10', 'icon_512x512@2x.png'],
];

const chunks = entries.map(([type, file]) => {
  const png = fs.readFileSync(path.join(iconset, file));
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([header, png]);
});

const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write('icns', 0, 4, 'ascii');
header.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync(path.join(root, 'assets', 'icon.icns'), Buffer.concat([header, body]));
