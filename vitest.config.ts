import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 单元测试配置：node 环境，只跑 tests/ 下的用例。
 * 测试对象是 src/shared 的纯函数与类型契约（阶段 A 骨架冒烟）。
 * @shared 别名与 vite.config.ts / tsconfig 保持一致。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    reporters: 'default',
  },
});