import { describe, expect, it } from 'vitest';
import {
  formatAspectRatio,
  formatResolution,
  formatBytes,
  stripExtension,
} from '../src/renderer/lib/format';

/**
 * 展示格式化工具测试（批次 1 新增：分辨率 / 画面比例）。
 */

describe('formatResolution', () => {
  it('合法尺寸显示 宽 × 高', () => {
    expect(formatResolution(1920, 1080)).toBe('1920 × 1080');
    expect(formatResolution(1280.4, 720.6)).toBe('1280 × 721');
  });
  it('缺失或非法显示 —', () => {
    expect(formatResolution(null, 1080)).toBe('—');
    expect(formatResolution(0, 1080)).toBe('—');
    expect(formatResolution(NaN, 1080)).toBe('—');
  });
});

describe('formatAspectRatio', () => {
  it('常见比例归一为标准写法', () => {
    expect(formatAspectRatio(1920, 1080)).toBe('16:9');
    expect(formatAspectRatio(1280, 720)).toBe('16:9');
    expect(formatAspectRatio(1080, 1920)).toBe('9:16');
    expect(formatAspectRatio(1440, 1080)).toBe('4:3');
    expect(formatAspectRatio(1080, 1080)).toBe('1:1');
  });
  it('电影宽银幕近似命中 2.39:1', () => {
    expect(formatAspectRatio(2048, 858)).toBe('2.39:1');
  });
  it('非标准比例退化为化简比', () => {
    expect(formatAspectRatio(1000, 618)).toBe('500:309');
  });
  it('缺失或非法显示 —', () => {
    expect(formatAspectRatio(null, 1080)).toBe('—');
    expect(formatAspectRatio(1920, 0)).toBe('—');
  });
});

describe('formatBytes / stripExtension（回归）', () => {
  it('1024 进制与非法值', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(null)).toBe('—');
  });
  it('去扩展名保留无扩展名与隐藏名', () => {
    expect(stripExtension('a.mp4')).toBe('a');
    expect(stripExtension('noext')).toBe('noext');
    expect(stripExtension('.hidden')).toBe('.hidden');
  });
});