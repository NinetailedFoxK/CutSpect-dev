import { describe, expect, it } from 'vitest';
import { adapterFor, currentAdapter, detectPlatformId } from '../src/platform/common';

/**
 * 平台适配层契约测试（macOS / Windows 实现同一接口）。
 * 用显式 adapterFor 断言，避免依赖运行环境；currentAdapter 仅做形状校验。
 */
describe('平台适配层 currentAdapter', () => {
  it('检测结果落在受支持集合内，且 isMac 与 id 自洽', () => {
    const id = detectPlatformId();
    expect(['macos', 'windows', 'linux']).toContain(id);

    const adapter = currentAdapter();
    // Linux 目前复用 Windows 适配（adapter.id 为 windows），不是独立实现。
    expect(adapter.id).toBe(id === 'linux' ? 'windows' : id);
    expect(typeof adapter.isMac).toBe('boolean');
    expect(typeof adapter.formatBinding).toBe('function');
    expect(typeof adapter.executableNames).toBe('function');
  });
});

describe('macOS 适配', () => {
  const mac = adapterFor('macos');

  it('使用 Command 与访达术语', () => {
    expect(mac.isMac).toBe(true);
    expect(mac.modKeyLabel).toBe('⌘');
    expect(mac.fileManagerName).toBe('访达');
    expect(mac.revealLabel).toBe('在访达中显示');
  });

  it('键位按 Command 展示，可执行文件无 .exe 后缀', () => {
    expect(mac.formatBinding('mod+shift+z')).toBe('⌘⇧Z');
    expect(mac.formatBinding('mod+z')).toBe('⌘Z');
    expect(mac.executableNames('ffmpeg')).toEqual(['ffmpeg']);
  });
});

describe('Windows 适配', () => {
  const win = adapterFor('windows');

  it('使用 Ctrl 与文件资源管理器术语，且不出现 Command 符号', () => {
    expect(win.isMac).toBe(false);
    expect(win.modKeyLabel).toBe('Ctrl');
    expect(win.fileManagerName).toBe('文件资源管理器');
    expect(win.revealLabel).toBe('在文件资源管理器中显示');
    expect(win.revealLabel).not.toContain('访达');
    expect(win.modKeyLabel).not.toContain('⌘');
  });

  it('键位按 Ctrl 展示，可执行文件带 .exe 后缀', () => {
    expect(win.formatBinding('mod+shift+z')).toBe('Ctrl+Shift+Z');
    expect(win.formatBinding('ctrl+wheel')).toBe('Ctrl+滚轮');
    expect(win.executableNames('ffprobe')).toEqual(['ffprobe', 'ffprobe.exe']);
  });
});