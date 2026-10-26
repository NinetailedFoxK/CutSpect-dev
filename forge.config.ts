import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Electron Forge 打包配置。
 * - asar 内保留应用代码；ffmpeg / ffprobe 可执行文件解包，确保安装后仍能运行。
 * - ignore 排除源码、测试、文档与开发配置，缩小正式应用体积。
 * - 同时产出 ZIP 与 DMG；没有开发者证书时为本机可用的未签名构建。
 * - ELECTRON_ZIP_DIR 仅用于无网络环境复用已校验的本机 Electron 缓存。
 */
const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: 'com.cutspec.desktop',
    appCategoryType: 'public.app-category.video',
    appCopyright: 'Copyright © 2026 CutSpect',
    asar: {
      unpack: '**/node_modules/{ffmpeg-static,@ffprobe-installer/**}/**',
    },
    icon: 'assets/icon',
    electronZipDir: process.env.ELECTRON_ZIP_DIR,
    ignore: [
      /^\/src($|\/)/,
      /^\/tests($|\/)/,
      /^\/docs($|\/)/,
      /^\/\.arts($|\/)/,
      /^\/\.codeartsdoer($|\/)/,
      /^\/\.git($|\/)/,
      /^\/index\.html$/,
      /^\/vite\.config\.ts$/,
      /^\/vitest\.config\.ts$/,
      /^\/forge\.config\.ts$/,
      /^\/tsconfig[^/]*\.json$/,
      /^\/README\.md$/,
      /^\/\.gitignore$/,
      /^\/package-lock\.json$/,
    ],
  },
  rebuildConfig: {},
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => {
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
    new MakerZIP(),
    new MakerDMG({
      name: 'CutSpect-0.11.0',
      format: 'ULFO',
    }),
  ],
};

export default config;
