import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 渲染层构建配置。
 * - base './'：生产环境由 Electron 以 file:// 协议加载 dist/renderer/index.html，
 *   必须使用相对资源路径，否则 file:// 下模块与样式会 404。
 * - dev server 固定 127.0.0.1:5173（strictPort），dev 脚本用 wait-on 等待该端口。
 * - @shared 别名与 tsconfig.web.json 的 paths 保持一致，仅供渲染层使用；
 *   主进程/preload 走 tsc 编译输出，统一使用相对路径导入 shared。
 */
export default defineConfig(({ command }) => ({
  base: './',
  plugins: [
    react(),
    {
      name: 'dev-csp-connect',
      transformIndexHtml(html) {
        if (command !== 'serve') {
          return html;
        }
        return html.replace(
          "connect-src 'self'",
          "connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173",
        );
      },
    },
  ],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
}));