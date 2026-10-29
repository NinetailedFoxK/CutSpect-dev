import { describe, expect, it } from 'vitest';
import { DEFAULT_DEV_SERVER_URL, isTrustedFrameUrl } from '../src/main/ipc-trust';

describe('isTrustedFrameUrl', () => {
  it('打包态只信任 file://，不信任 Vite 默认地址', () => {
    expect(isTrustedFrameUrl('file:///app/index.html', { isPackaged: true })).toBe(true);
    expect(isTrustedFrameUrl(DEFAULT_DEV_SERVER_URL, { isPackaged: true })).toBe(false);
    expect(isTrustedFrameUrl(`${DEFAULT_DEV_SERVER_URL}/`, { isPackaged: true })).toBe(false);
    expect(isTrustedFrameUrl(`${DEFAULT_DEV_SERVER_URL}/index.html`, { isPackaged: true })).toBe(false);
    expect(
      isTrustedFrameUrl(DEFAULT_DEV_SERVER_URL, {
        isPackaged: true,
        devServerUrl: DEFAULT_DEV_SERVER_URL,
      }),
    ).toBe(false);
    expect(isTrustedFrameUrl('https://example.com', { isPackaged: true })).toBe(false);
    expect(isTrustedFrameUrl('', { isPackaged: true })).toBe(false);
  });

  it('开发态信任 file:// 与配置的 Vite 地址', () => {
    expect(isTrustedFrameUrl('file:///tmp/index.html', { isPackaged: false })).toBe(true);
    expect(isTrustedFrameUrl(DEFAULT_DEV_SERVER_URL, { isPackaged: false })).toBe(true);
    expect(isTrustedFrameUrl(`${DEFAULT_DEV_SERVER_URL}/src/renderer/main.tsx`, { isPackaged: false })).toBe(true);
    expect(isTrustedFrameUrl('http://127.0.0.1:5174', { isPackaged: false })).toBe(false);
    expect(isTrustedFrameUrl('http://evil.example', { isPackaged: false })).toBe(false);
    expect(
      isTrustedFrameUrl('http://127.0.0.1:4173/index.html', {
        isPackaged: false,
        devServerUrl: 'http://127.0.0.1:4173',
      }),
    ).toBe(true);
    expect(
      isTrustedFrameUrl(DEFAULT_DEV_SERVER_URL, {
        isPackaged: false,
        devServerUrl: 'http://127.0.0.1:4173',
      }),
    ).toBe(false);
  });
});
