/**
 * IPC 调用来源判断（纯函数，便于单测，不依赖 Electron）。
 *
 * - 打包态只信任 `file://`（应用自己的渲染层）。
 * - 开发态额外信任 Vite dev server。默认 `http://127.0.0.1:5173`，
 *   可用 `LAIPIAN_DEV_SERVER_URL` 覆盖。
 * - 打包态即使环境变量指向 Vite，也不放行：否则本机 5173 上的页面能调用 IPC。
 */

export const DEFAULT_DEV_SERVER_URL = 'http://127.0.0.1:5173';

export function isTrustedFrameUrl(
  url: string,
  options: { isPackaged: boolean; devServerUrl?: string | null },
): boolean {
  if (url.startsWith('file://')) {
    return true;
  }
  if (options.isPackaged) {
    return false;
  }
  const configured = options.devServerUrl?.trim() ?? '';
  const dev = configured.length > 0 ? configured : DEFAULT_DEV_SERVER_URL;
  return url === dev || url.startsWith(`${dev}/`);
}
