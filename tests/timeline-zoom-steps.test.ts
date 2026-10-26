import { describe, expect, it } from 'vitest';
import {
  ZOOM_STEP_DEFS,
  nearestZoomStepIndex,
  zoomStepsFor,
} from '../src/renderer/editor/timeline-math';

/**
 * 缩放档位（时间轨修复文档 §6.3）：离散档位替代敏感的连续对数滑杆。
 */

describe('缩放档位（§6.3）', () => {
  it('档位顺序为"适应全片 → 更细"（跨度递减），与文档一致', () => {
    const steps = zoomStepsFor(14 * 60_000);
    expect(steps.map((s) => s.label)).toEqual([
      '适应全片',
      '10 分钟',
      '5 分钟',
      '2 分钟',
      '1 分钟',
      '30 秒',
      '10 秒',
      '5 秒',
      '1 秒',
    ]);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]?.spanMs ?? 0).toBeLessThan(steps[i - 1]?.spanMs ?? 0);
    }
  });

  it('超过片长的档位被折叠（不出现大于片长的固定档）', () => {
    const steps = zoomStepsFor(30_000); // 30 秒片长
    expect(steps.map((s) => s.label)).toEqual(['适应全片', '10 秒', '5 秒', '1 秒']);
  });

  it('nearestZoomStepIndex 命中当前跨度', () => {
    const duration = 14 * 60_000;
    const steps = zoomStepsFor(duration);
    const twoMin = steps.findIndex((s) => s.label === '2 分钟');
    expect(nearestZoomStepIndex(120_000, duration)).toBe(twoMin);
    expect(nearestZoomStepIndex(duration, duration)).toBe(0);
  });

  it('ZOOM_STEP_DEFS 首项为"适应全片"（spanMs=0）', () => {
    expect(ZOOM_STEP_DEFS[0]).toEqual({ spanMs: 0, label: '适应全片' });
  });
});