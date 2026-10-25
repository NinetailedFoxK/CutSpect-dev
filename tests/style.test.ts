import { describe, expect, it } from 'vitest';
import type { ProjectMedia } from '../src/shared/api-types';
import { createInitialSnapshot, projectStyleSchema } from '../src/shared/schema';
import {
  DEFAULT_STYLE,
  NODE_SHAPES,
  PRESET_ORDER,
  STYLE_PRESETS,
  resolveStyle,
} from '../src/shared/style';

/**
 * 分析监视器样式模型测试（第一阶段）：
 * 四套预设合法、默认值、部分样式合并、初始快照写入默认样式。
 */

function makeMedia(durationMs = 60_000): ProjectMedia {
  return {
    id: 'm',
    originalName: '原视频.mp4',
    sourcePath: 'media/source.mp4',
    playbackPath: null,
    sha256: 'a'.repeat(64),
    sizeBytes: 1,
    durationMs,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    audioCodec: 'aac',
    avgFrameRate: { num: 30, den: 1 },
    isVfr: false,
    isHdr: false,
  };
}

describe('STYLE_PRESETS 四套专业预设', () => {
  it('齐全、preset 自洽且通过 schema 校验', () => {
    expect(PRESET_ORDER).toHaveLength(4);
    for (const id of PRESET_ORDER) {
      const preset = STYLE_PRESETS[id];
      expect(preset.style.preset).toBe(id);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(projectStyleSchema.safeParse(preset.style).success).toBe(true);
    }
  });

  it('专业默认为克制的（3px 主线、圆形节点 10px、光晕很低）', () => {
    expect(DEFAULT_STYLE.curve.width).toBe(3);
    expect(DEFAULT_STYLE.curve.halo).toBeLessThan(0.2);
    expect(DEFAULT_STYLE.node.shape).toBe('circle');
    expect(DEFAULT_STYLE.node.size).toBe(10);
    expect(DEFAULT_STYLE.node.endpointShape).toBe('rounded');
    expect(DEFAULT_STYLE.grid.opacity).toBeLessThanOrEqual(0.1);
  });

  it('深夜蓝使用青色节点、极简白使用圆环节点', () => {
    expect(STYLE_PRESETS.midnight.style.node.color).toBe('#5BD69A');
    expect(STYLE_PRESETS.mono.style.node.shape).toBe('ring');
  });
});

describe('resolveStyle 旧项目兼容', () => {
  it('缺省返回默认样式', () => {
    expect(resolveStyle(null)).toEqual(DEFAULT_STYLE);
    expect(resolveStyle(undefined)).toEqual(DEFAULT_STYLE);
  });

  it('部分字段与默认合并', () => {
    const merged = resolveStyle({ curve: { width: 6 }, node: { size: 14 } });
    expect(merged.curve.width).toBe(6);
    expect(merged.curve.halo).toBe(DEFAULT_STYLE.curve.halo);
    expect(merged.node.size).toBe(14);
    expect(merged.node.shape).toBe(DEFAULT_STYLE.node.shape);
    expect(merged.annotation).toEqual(DEFAULT_STYLE.annotation);
    expect(merged.grid).toEqual(DEFAULT_STYLE.grid);
  });
});

describe('节点形状集合', () => {
  it('只含专业预设形状，不含星形/爱心等装饰形状', () => {
    expect(NODE_SHAPES).toContain('circle');
    expect(NODE_SHAPES).toContain('diamond');
    expect(NODE_SHAPES).toContain('rounded');
    expect(NODE_SHAPES).toContain('hexagon');
    expect(NODE_SHAPES).toContain('ring');
    expect(NODE_SHAPES).toHaveLength(5);
  });
});

describe('createInitialSnapshot', () => {
  it('新项目写入默认样式', () => {
    const snapshot = createInitialSnapshot({ projectId: 'p', name: '示例', media: makeMedia() });
    expect(snapshot.style).toEqual(DEFAULT_STYLE);
  });
});