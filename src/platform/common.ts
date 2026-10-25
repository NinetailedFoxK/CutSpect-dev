/**
 * 平台适配层公共定义（src/platform）。
 *
 * 一套共享源码原则：
 * - macOS 与 Windows 各自实现同一 PlatformAdapter 接口，业务代码只依赖接口，
 *   不把 process.platform / userAgent 判断散落到各处。
 * - 只有「真正不同的系统行为」才进入适配层：主修饰键名称、系统文件管理器名称、
 *   键位展示、可执行文件后缀、开发期工具回退目录。
 * - 界面、数据模型、快捷键绑定、导出格式仍完全共用，不存在两套业务源码。
 *
 * 本模块不依赖 DOM 或 Node 专有 API，main 与 renderer 均可安全导入。
 */
import { macosAdapter } from './macos';
import { windowsAdapter } from './windows';

export type PlatformId = 'macos' | 'windows' | 'linux';

export interface PlatformAdapter {
  readonly id: PlatformId;
  readonly isMac: boolean;
  /** 主修饰键展示文本：macOS 为 ⌘，Windows/Linux 为 Ctrl。 */
  readonly modKeyLabel: string;
  /** 系统文件管理器名称：macOS 为「访达」，Windows 为「文件资源管理器」。 */
  readonly fileManagerName: string;
  /** 「在<文件管理器>中显示」文案（用于按钮、菜单与提示）。 */
  readonly revealLabel: string;
  /** 按平台把规范化键位（如 `mod+shift+z`）格式化为展示文本。 */
  formatBinding(binding: string): string;
  /** 解析可执行文件的候选文件名（Windows 需要 `.exe` 后缀）。 */
  executableNames(tool: string): string[];
  /** 开发期工具（ffmpeg/ffprobe）回退查找目录（不含 PATH）。 */
  readonly ffmpegFallbackDirs: readonly string[];
}

/**
 * 解析当前平台标识。
 * - 优先使用 `process.platform`（main 进程、vitest、preload 可用）；
 * - 渲染层主世界没有 process 时回退到 `navigator.userAgent`。
 */
export function detectPlatformId(): PlatformId {
  const proc = (globalThis as { process?: { platform?: string } }).process;
  if (proc !== undefined && typeof proc.platform === 'string') {
    if (proc.platform === 'darwin') {
      return 'macos';
    }
    if (proc.platform === 'win32') {
      return 'windows';
    }
    return 'linux';
  }
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  const ua = nav?.userAgent ?? '';
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) {
    return 'macos';
  }
  if (/Windows|Win32|Win64/i.test(ua)) {
    return 'windows';
  }
  return 'linux';
}

/**
 * 取指定平台的适配实现。
 * 当前版本正式支持 macOS 与 Windows；Linux 复用 Windows 实现（Ctrl 术语、
 * 文件资源管理器提示），仅作为未验证的回退，不构成对 Linux 的官方支持。
 */
export function adapterFor(id: PlatformId): PlatformAdapter {
  return id === 'macos' ? macosAdapter : windowsAdapter;
}

let cached: PlatformAdapter | null = null;

/** 当前平台适配实现（按平台检测结果缓存，进程内稳定）。 */
export function currentAdapter(): PlatformAdapter {
  if (cached === null) {
    cached = adapterFor(detectPlatformId());
  }
  return cached;
}