/**
 * Windows 平台适配实现（与 src/platform/macos.ts 实现同一 PlatformAdapter 接口）。
 */
import { formatBinding as formatBindingShared } from '../shared/keymap';
import type { PlatformAdapter } from './common';

export const windowsAdapter: PlatformAdapter = {
  id: 'windows',
  isMac: false,
  modKeyLabel: 'Ctrl',
  fileManagerName: '文件资源管理器',
  revealLabel: '在文件资源管理器中显示',
  formatBinding: (binding) => formatBindingShared(binding, false),
  // Windows 可执行文件带 .exe 后缀（PATH 查找时两种名都试）。
  executableNames: (tool) => [tool, `${tool}.exe`],
  // Windows 不假设固定安装目录，仅依赖 PATH 与随包二进制。
  ffmpegFallbackDirs: [],
};