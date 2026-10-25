import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VideoCanvas } from '../src/renderer/components/VideoCanvas';
import { createPlayheadStore } from '../src/renderer/editor/playhead-store';
import { computePlotXGeometry, computePlotYGeometry } from '../src/renderer/editor/editor-geometry';
import type { ProjectView } from '../src/shared/api-types';

/**
 * 画布加载态与素材缺失态测试（批次 2 / 规格 3、13）。
 * 规格 3 禁止"黑屏无说明"与"曲线先于视频"；规格 13 要求错误给出下一步。
 * 用 SSR 渲染断言文案存在（无需真实 video 元素）。
 */

const VIEW: ProjectView = {
  playheadMs: 0,
  viewStartMs: 0,
  viewEndMs: 10_000,
  videoVisible: true,
  videoOpacity: 1,
  analysisVisible: true,
  analysisOpacity: 1,
  analysisLocked: false,
  annotationsVisible: true,
  boundariesVisible: true,
  playbackRate: 1,
  volume: 1,
  muted: false,
  timelineHeight: 160,
};

function render(props: { mediaReady: boolean; mediaMissing?: boolean }): string {
  return renderToStaticMarkup(
    <VideoCanvas
      mediaSrc="laipian-media://demo/media/source.mp4"
      videoRef={createRef<HTMLVideoElement>()}
      hostRef={createRef<HTMLDivElement>()}
      geometry={computePlotXGeometry(1000)}
      plotY={computePlotYGeometry(400)}
      view={VIEW}
      playheadStore={createPlayheadStore(0)}
      durationMs={10_000}
      mediaError={null}
      mediaReady={props.mediaReady}
      mediaMissing={props.mediaMissing}
    />,
  );
}

describe('VideoCanvas 加载 / 缺失态（规格 3 / 13）', () => {
  it('视频未就绪：显示加载说明，不含曲线（避免曲线先于视频）', () => {
    const html = render({ mediaReady: false });
    expect(html).toContain('正在准备视频');
    expect(html).toContain('lp-canvas-loading');
    expect(html).not.toContain('lp-canvas-missing');
  });

  it('素材缺失：给出明确说明与下一步，且不显示加载态', () => {
    const html = render({ mediaReady: false, mediaMissing: true });
    expect(html).toContain('素材缺失');
    expect(html).toContain('重新定位素材');
    expect(html).toContain('lp-canvas-missing');
    expect(html).not.toContain('正在准备视频');
  });

  it('视频就绪：不显示任何覆盖层', () => {
    const html = render({ mediaReady: true });
    expect(html).not.toContain('正在准备视频');
    expect(html).not.toContain('素材缺失');
  });
});