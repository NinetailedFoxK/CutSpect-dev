import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Annotation, Boundary, Curve, Section } from '../src/shared/api-types';
import { CurveLayer } from '../src/renderer/components/CurveLayer';

/**
 * CurveLayer / 分析层渲染测试（规格 3.1 / 5 / 6 / 7）：不依赖浏览器布局，
 * 用 SSR 渲染固定几何，验证曲线 path、节点、标注点/标签、分段虚线与段名的坐标映射。
 */

const curve: Curve = {
  id: 'c',
  name: '情绪强度',
  color: '#F04B50',
  nodes: [
    { id: 'a', timeMs: 0, value: 50, outMode: 'auto', inHandle: null, outHandle: null },
    { id: 'b', timeMs: 10_000, value: 50, outMode: 'auto', inHandle: null, outHandle: null },
  ],
};

const boundaries: Boundary[] = [
  { id: 'start', timeMs: 0, fixed: true, locked: true },
  { id: 'b1', timeMs: 5_000, fixed: false, locked: false },
  { id: 'end', timeMs: 10_000, fixed: true, locked: true },
];
const sections: Section[] = [
  { id: 's1', startBoundaryId: 'start', name: '开场', note: '' },
  { id: 's2', startBoundaryId: 'b1', name: '高潮', note: '' },
];
const annotations: Annotation[] = [
  { id: 'n1', timeMs: 2_500, title: '铺垫', body: '', labelOffset: { x: 10, y: -30 } },
];

function render(overrides: Partial<Parameters<typeof CurveLayer>[0]> = {}): string {
  return renderToStaticMarkup(
    <CurveLayer
      curve={curve}
      annotations={annotations}
      boundaries={boundaries}
      sections={sections}
      plotX={{ plotLeft: 12, plotWidth: 1000 }}
      plotY={{ plotTop: 16, plotHeight: 300 }}
      viewStartMs={0}
      viewEndMs={10_000}
      durationMs={10_000}
      analysisVisible
      analysisOpacity={1}
      locked={false}
      tool="select"
      selectedNodeIds={[]}
      onSelectNodes={() => undefined}
      onCommit={() => undefined}
      onRequestPause={() => undefined}
      {...overrides}
    />,
  );
}

describe('曲线渲染（规格 3.1）', () => {
  it('红色曲线路径端点映射到绘图区左右边缘与 50% 高度', () => {
    const html = render();
    expect(html).toContain('lp-curve-path');
    expect(html).toContain('M 0.00 150.00');
    expect(html).toContain('1000.00 150.00');
  });

  it('交互时渲染 2 个首尾端点节点（圆角方形，与普通节点区分）', () => {
    const html = render();
    expect((html.match(/<g class="lp-node/g) ?? []).length).toBe(2);
    expect((html.match(/class="lp-node-mark"/g) ?? []).length).toBe(2);
    // 首尾端点使用圆角方形（规格：不能只靠颜色区分）。
    expect(html).toContain('rx="3"');
    expect(html).toContain('class="lp-node is-fixed"');
  });

  it('分析层隐藏或锁定时不渲染编辑节点', () => {
    expect(render({ analysisVisible: false })).not.toContain('lp-node');
    expect(render({ locked: true })).not.toContain('lp-node');
  });
});

describe('标注渲染（规格 6）', () => {
  it('渲染黄色标注点与标题标签', () => {
    const html = render();
    expect(html).toContain('lp-annotation-point');
    expect(html).toContain('lp-annotation-label');
    expect(html).toContain('铺垫');
  });

  it('annotationsVisible=false 时不渲染标注', () => {
    expect(render({ annotationsVisible: false })).not.toContain('lp-annotation-point');
  });

  it('选中标注带选中样式', () => {
    expect(render({ selectedAnnotationId: 'n1' })).toContain('lp-annotation is-selected');
  });
});

describe('分段渲染（规格 7）', () => {
  it('渲染内部边界虚线与段落名', () => {
    const html = render();
    expect(html).toContain('lp-boundary-line');
    // 内部边界 x = 5000/10000*1000 = 500。
    expect(html).toContain('x1="500"');
    expect(html).toContain('开场');
    expect(html).toContain('高潮');
  });

  it('锁定边界带锁定标记；boundariesVisible=false 不渲染', () => {
    const locked = boundaries.map((b) => (b.id === 'b1' ? { ...b, locked: true } : b));
    expect(render({ boundaries: locked })).toContain('lp-boundary-lock');
    expect(render({ boundariesVisible: false })).not.toContain('lp-boundary-line');
  });
});