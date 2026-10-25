/*
 * 生成公开更新清单 latest.json（发布产物之一，由 release.yml 在发布前调用）。
 *
 * 用法：node scripts/write-latest-json.cjs <artifactsDir>
 * 读取环境变量：RELEASE_REPO（公开发布仓库 owner/repo）、RELEASE_TAG（如 v0.10.0）
 *
 * 扫描 artifacts 目录内实际存在的产物文件名，拼出公开下载 URL，
 * 输出 <artifactsDir>/latest.json 后随 Release 一起上传。
 * 该文件供用户/自建更新服务读取；不包含任何 Token 与源码信息。
 */
const fs = require('node:fs');
const path = require('node:path');

const repo = (process.env.RELEASE_REPO ?? '').trim();
const tag = (process.env.RELEASE_TAG ?? '').trim();
const artifactsDir = path.resolve(process.argv[2] ?? 'artifacts');

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

const files = walk(artifactsDir).map((f) => path.basename(f));
const find = (re) => files.find((name) => re.test(name)) ?? null;
const urlOf = (name) =>
  name !== null && repo.length > 0 && tag.length > 0
    ? `https://github.com/${repo}/releases/download/${tag}/${name}`
    : null;

const winSetup = find(/Windows-x64-Setup\.exe$/i);
const winZip = find(/Windows-x64\.zip$/i);
const macDmg = find(/macOS-.+\.dmg$/i);
const macZip = find(/macOS-.+\.zip$/i);

const version =
  (macDmg ?? macZip ?? winSetup ?? '')
    .match(/-(\d+\.\d+\.\d+[^-]*)-/)?.[1] ?? '';
const semver = tag.replace(/^v/, '') || version;

const latest = {
  version: semver,
  tag,
  pub_date: new Date().toISOString(),
  notes: '详见本 Release 的更新说明（CHANGELOG）。',
  repository: repo,
  platforms: {
    'win32-x64': {
      installer: urlOf(winSetup),
      zip: urlOf(winZip),
      feed: urlOf('RELEASES'),
      nupkg: files.filter((f) => /\.nupkg$/i.test(f)).map(urlOf),
    },
    darwin: {
      dmg: urlOf(macDmg),
      zip: urlOf(macZip),
    },
  },
};

const outFile = path.join(artifactsDir, 'latest.json');
fs.writeFileSync(outFile, `${JSON.stringify(latest, null, 2)}\n`);
console.log(`[latest.json] 写入 ${outFile}`);
console.log(JSON.stringify(latest, null, 2));

if (winSetup === null || macZip === null) {
  console.error('[latest.json] 警告：缺少 Windows Setup.exe 或 macOS ZIP 产物。');
  process.exitCode = 1;
}