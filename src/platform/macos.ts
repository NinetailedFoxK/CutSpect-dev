/**
 * macOS 平台适配实现（与 src/platform/windows.ts 实现同一 PlatformAdapter 接口）。
 */
import { formatBinding as formatBindingShared } from '../shared/keymap';
import type { PlatformAdapter } from './common';

export const macosAdapter: PlatformAdapter = {
  id: 'macos',
  isMac: true,
  modKeyLabel: '⌘',
  fileManagerName: '访达',
  revealLabel: '在访达中显示',
  formatBinding: (binding) => formatBindingShared(binding, true),
  executableNames: (tool) => [tool],
  // 开发机常见 Homebrew 安装目录（可能未进入当前进程 PATH）。
  ffmpegFallbackDirs: ['/opt/homebrew/bin', '/usr/local/bin'],
};