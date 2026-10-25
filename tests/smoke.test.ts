import { describe, expect, it } from 'vitest';
import { err, ok } from '../src/shared/api-types';
import type { ProjectSnapshot, Result } from '../src/shared/api-types';
import { IPC_CHANNELS } from '../src/shared/ipc-channels';
// 同时以 @shared 别名导入，验证 vite/vitest 的路径别名与 tsconfig paths 一致生效。
import { clamp, clampViewRange, formatTimeMs } from '@shared/time';

/**
 * 阶段 A 骨架冒烟测试：
 * 1) shared 类型契约可编译且结构符合规格 11.2（最小合法 ProjectSnapshot）。
 * 2) Result 辅助函数与错误形状。
 * 3) IPC 通道常量无重复（拼错/重名会导致 preload 与 main 静默失配）。
 * 4) time.ts 纯函数（规格 3.1 时间显示与 3.3 区间夹紧）。
 */

const minimalSnapshot: ProjectSnapshot = {
  schemaVersion: 1,
  id: 'project-uuid-1',
  name: '示例分析',
  revision: 1,
  createdAt: '2026-10-22T12:00:00.000Z',
  updatedAt: '2026-10-22T12:00:00.000Z',
  media: {
    id: 'media-uuid-1',
    originalName: '原视频.mp4',
    sourcePath: 'media/source.mp4',
    playbackPath: null,
    sha256: 'a'.repeat(64),
    sizeBytes: 12345678,
    durationMs: 180000,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    audioCodec: 'aac',
    avgFrameRate: { num: 30000, den: 1001 },
    isVfr: false,
    isHdr: false,
  },
  curve: {
    id: 'curve-uuid-1',
    name: '情绪强度',
    color: '#F04B50',
    nodes: [
      { id: 'node-start', timeMs: 0, value: 50, outMode: 'auto', inHandle: null, outHandle: null },
      { id: 'node-end', timeMs: 180000, value: 50, outMode: 'auto', inHandle: null, outHandle: null },
    ],
  },
  annotations: [],
  boundaries: [
    { id: 'start', timeMs: 0, fixed: true, locked: true },
    { id: 'end', timeMs: 180000, fixed: true, locked: true },
  ],
  sections: [{ id: 'section-uuid-1', startBoundaryId: 'start', name: '段落 1', note: '' }],
  view: {
    playheadMs: 0,
    viewStartMs: 0,
    viewEndMs: 180000,
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
  },
};

describe('shared 类型契约（规格 11.2 / 12.4）', () => {
  it('最小合法 ProjectSnapshot 满足类型并保留关键字段', () => {
    expect(minimalSnapshot.schemaVersion).toBe(1);
    expect(minimalSnapshot.curve.nodes).toHaveLength(2);
    expect(minimalSnapshot.curve.nodes[0]?.timeMs).toBe(0);
    expect(minimalSnapshot.boundaries.map((b) => b.fixed)).toEqual([true, true]);
    expect(minimalSnapshot.media.audioCodec).toBe('aac');
    expect(minimalSnapshot.view.timelineHeight).toBe(160);
  });
});

describe('Result 辅助函数', () => {
  it('ok() 构造成功分支', () => {
    const success: Result<number> = ok(42);
    expect(success).toEqual({ ok: true, data: 42 });
    if (success.ok) {
      expect(success.data).toBe(42);
    }
  });

  it('err() 构造失败分支（含 retryable 默认值）', () => {
    const failure = err('NOT_IMPLEMENTED', '骨架占位');
    expect(failure).toEqual({
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: '骨架占位', retryable: false },
    });
  });
});

describe('IPC 通道常量', () => {
  it('所有通道名互不重复', () => {
    const values = Object.values(IPC_CHANNELS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('三个文件选择入口与事件通道已定义', () => {
    expect(IPC_CHANNELS.dialogPickVideoFile).toBe('dialog:pick-video-file');
    expect(IPC_CHANNELS.dialogPickProjectDir).toBe('dialog:pick-project-dir');
    expect(IPC_CHANNELS.dialogPickOpenProjectFolder).toBe('dialog:pick-open-project-folder');
    expect(IPC_CHANNELS.taskEvent).toBe('task:event');
  });
});

describe('formatTimeMs（规格 3.1）', () => {
  it('不足 1 小时省略小时段', () => {
    expect(formatTimeMs(0)).toBe('00:00.000');
    expect(formatTimeMs(950)).toBe('00:00.950');
    expect(formatTimeMs(61_500)).toBe('01:01.500');
    expect(formatTimeMs(3_599_999)).toBe('59:59.999');
  });

  it('满 1 小时自动显示小时段', () => {
    expect(formatTimeMs(3_600_000)).toBe('01:00:00.000');
    expect(formatTimeMs(3_661_500)).toBe('01:01:01.500');
  });

  it('hours: always 强制显示小时段', () => {
    expect(formatTimeMs(0, { hours: 'always' })).toBe('00:00:00.000');
  });

  it('非法输入防御性归零，小数毫秒四舍五入', () => {
    expect(formatTimeMs(-100)).toBe('00:00.000');
    expect(formatTimeMs(Number.NaN)).toBe('00:00.000');
    expect(formatTimeMs(Number.POSITIVE_INFINITY)).toBe('00:00.000');
    expect(formatTimeMs(1234.6)).toBe('00:01.235');
  });
});

describe('clamp / clampViewRange（规格 3.3）', () => {
  it('clamp 基本边界与防御行为', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(Number.NaN, 0, 10)).toBe(0);
    expect(clamp(Number.POSITIVE_INFINITY, 0, 10)).toBe(10);
    expect(clamp(Number.NEGATIVE_INFINITY, 0, 10)).toBe(0);
    // min/max 传反时自动交换，仍返回有效值。
    expect(clamp(5, 10, 0)).toBe(5);
  });

  it('clampViewRange 不越出 [0, durationMs] 且保证 start < end', () => {
    expect(clampViewRange(0, 180_000, 180_000)).toEqual({
      viewStartMs: 0,
      viewEndMs: 180_000,
    });
    expect(clampViewRange(-100, 999_999, 180_000)).toEqual({
      viewStartMs: 0,
      viewEndMs: 180_000,
    });
    // end < start 时夹紧为最小跨度。
    expect(clampViewRange(50_000, 40_000, 180_000)).toEqual({
      viewStartMs: 50_000,
      viewEndMs: 50_001,
    });
  });
});