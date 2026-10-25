import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TimelineSplitter } from '../src/renderer/components/TimelineSplitter';

/**
 * 分割线渲染测试（需求 1.2 / 1.6）：SSR 渲染验证可访问性契约与关键属性。
 * 拖动 / 键盘 / 双击等交互行为由 tests/layout.test.ts 的状态机覆盖。
 */

const noop = (): void => undefined;

describe('TimelineSplitter 可访问性渲染', () => {
  it('输出 role=separator、水平方向与当前/最小/最大高度，且可聚焦', () => {
    const html = renderToStaticMarkup(
      <TimelineSplitter
        height={300}
        limits={{ min: 160, max: 600 }}
        onPreview={noop}
        onCommit={noop}
        onReset={noop}
      />,
    );
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="horizontal"');
    expect(html).toContain('aria-valuenow="300"');
    expect(html).toContain('aria-valuemin="160"');
    expect(html).toContain('aria-valuemax="600"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('lp-splitter');
  });
});