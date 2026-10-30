import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { macFileAssociationExtendInfo } from './src/shared/video-extensions';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Electron Forge 打包配置（macOS 与 Windows 共用同一套共享源码）。
 *
 * 平台边界（不复制两套项目，只做打包适配）：
 * - macOS：DMG + ZIP（MakerDMG 仅在 darwin 生效）。
 * - Windows：Squirrel Setup.exe + ZIP（MakerSquirrel 仅在 win32 生效）。
 * - ZIP：两端都产出（MakerZIP 全平台支持）。
 * - asar 内保留应用代码；ffmpeg / ffprobe 可执行文件解包，确保安装后仍能运行。
 * - macOS 保留本机临时签名钩子（postPackage），并显式限制只在 darwin 运行。
 * - 版本号唯一来源是 package.json。图标由 assets/icon 解析（macOS .icns / Windows .ico）。
 */

/** 版本号唯一来源：package.json（构建时从项目根读取，兼容 CJS/ESM 配置加载）。 */
function readPackageVersion(): string {
  const candidates = [path.resolve(process.cwd(), 'package.json')];
  if (typeof __dirname === 'string') {
    candidates.push(path.resolve(__dirname, 'package.json'));
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  }
  throw new Error('forge.config.ts：无法从 package.json 读取有效 version 字段。');
}

const VERSION = readPackageVersion();
const IS_MAC = process.platform === 'darwin';
const IS_WINDOWS = process.platform === 'win32';

/**
 * 构建时注入的更新配置（由 scripts/write-update-config.cjs 生成）：
 * 含公开发布仓库名；不进 asar，放应用 resources 目录由运行时读取。
 * 文件缺失时不影响打包（应用将自动禁用更新）。
 */
const updateConfigPath = path.resolve(process.cwd(), 'build', 'update-config.json');
const hasUpdateConfig = existsSync(updateConfigPath);

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: 'com.cutspec.desktop',
    appCategoryType: 'public.app-category.video',
    appCopyright: 'Copyright © 2026 CutSpect',
    asar: {
      unpack: '**/node_modules/{ffmpeg-static,@ffprobe-installer/**}/**',
    },
    icon: 'assets/icon',
    // macOS「打开方式」：Info.plist 文档类型。Alternate，不抢默认播放器。
    // Windows 不走 Info.plist；安装/启动时由主进程写 HKCU「打开方式」（不改默认关联）。
    // 当前没有 Linux maker，因此不生成 .desktop。
    extendInfo: macFileAssociationExtendInfo(),
    // 构建时注入的更新配置（含公开发布仓库名）：放 resources 供运行时读取。
    extraResource: hasUpdateConfig ? ['build/update-config.json'] : [],
    // Windows 内部程序名与可执行文件使用稳定英文标识（界面仍显示「拉片台」）。
    // macOS 保持既有可执行名不变，避免影响既有签名/产物。
    ...(IS_WINDOWS ? { executableName: 'laipian-tai' } : {}),
    electronZipDir: process.env.ELECTRON_ZIP_DIR,
    ignore: [
      /^\/src($|\/)/,
      /^\/tests($|\/)/,
      /^\/docs($|\/)/,
      /^\/\.arts($|\/)/,
      /^\/\.codeartsdoer($|\/)/,
      /^\/\.github($|\/)/,
      /^\/\.git($|\/)/,
      /^\/index\.html$/,
      /^\/vite\.config\.ts$/,
      /^\/vitest\.config\.ts$/,
      /^\/forge\.config\.ts$/,
      /^\/tsconfig[^/]*\.json$/,
      /^\/README\.md$/,
      /^\/CONTRIBUTING\.md$/,
      /^\/SECURITY\.md$/,
      /^\/\.gitignore$/,
      /^\/package-lock\.json$/,
    ],
  },
  rebuildConfig: {},
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => {
      // 仅 macOS 做本机临时签名；Windows 不执行该钩子（签名交由发布环境处理）。
      if (packageResult.platform !== 'darwin') return;

      for (const outputPath of packageResult.outputPaths) {
        const appPath = path.join(outputPath, 'CutSpect.app');
        await execFileAsync('/usr/bin/codesign', [
          '--force',
          '--deep',
          '--sign',
          '-',
          appPath,
        ]);
      }
    },
  },
  makers: [
    // ZIP：macOS 与 Windows 都产出（MakerZIP 全平台支持）。
    new MakerZIP(),
    // DMG：只在 macOS 执行。
    ...(IS_MAC
      ? [
          new MakerDMG({
            name: `CutSpect-${VERSION}`,
            format: 'ULFO',
            icon: 'assets/icon.icns',
          }),
        ]
      : []),
    // Squirrel Setup.exe：只在 Windows 执行（必须在真实 Windows 环境生成）。
    ...(IS_WINDOWS
      ? [
          new MakerSquirrel({
            name: 'laipian-tai',
            setupExe: `LaipianTai-${VERSION}-Setup.exe`,
            setupIcon: 'assets/icon.ico',
            authors: 'CutSpect 开发组',
            description: '离线桌面拉片与视频节奏分析工具',
            noMsi: true,
          }),
        ]
      : []),
  ],
};

export default config;