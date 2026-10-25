/*
 * 构建时注入自动更新配置（不发送源码、不硬编码仓库名）。
 *
 * 由 npm 的 pre 钩子自动调用：
 *   premake / premake:win / premake:mac / prepackage
 *
 * 读取（仅构建机可见，来自 CI 的 vars/secrets 或本地 shell）：
 *   LAIPIAN_RELEASE_REPO  公开发布仓库 owner/repo（如 ZevinZhao/CutSpect-downloads）
 *   LAIPIAN_UPDATE_FEED   自定义 feed 基础地址（可选，覆盖 Electron 官方托管）
 *
 * 输出：build/update-config.json —— 由 forge.config.ts 作为 extraResource 打进
 * 应用资源目录（app.asar 之外），运行时经 process.resourcesPath 读取。
 * 未提供任何值时写出空对象，应用会自动禁用更新（安全默认）。
 *
 * 绝不写入任何 Token：更新源是公开仓库 / 官方托管，用户端无需凭据。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'build');
const outFile = path.join(outDir, 'update-config.json');

const config = {};
const repo = (process.env.LAIPIAN_RELEASE_REPO ?? '').trim();
const feed = (process.env.LAIPIAN_UPDATE_FEED ?? '').trim();
if (repo.length > 0) {
  config.repo = repo;
}
if (feed.length > 0) {
  config.feed = feed;
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(config, null, 2)}\n`);
console.log(`[update-config] ${path.relative(root, outFile)} <- ${JSON.stringify(config)}`);