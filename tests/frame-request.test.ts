import { describe, expect, it } from 'vitest';
import { createLatestOnly, decideThrottle, FRAME_PREVIEW_THROTTLE_MS } from '../src/renderer/editor/frame-request';

/** 画面帧请求竞态与节流规则测试（规格 5.5 / 9）。 */

describe('createLatestOnly', () => {
  it('只有最新代际被认可，旧代际结果应丢弃', () => {
    const guard = createLatestOnly();
    const first = guard.begin();
    const second = guard.begin();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    const third = guard.begin();
    expect(guard.isCurrent(second)).toBe(false);
    expect(guard.isCurrent(third)).toBe(true);
  });
});

describe('decideThrottle', () => {
  it('距上次超过间隔 → 立即请求、无尾部', () => {
    expect(decideThrottle(FRAME_PREVIEW_THROTTLE_MS)).toEqual({ immediate: true, tailMs: null });
    expect(decideThrottle(FRAME_PREVIEW_THROTTLE_MS + 500)).toEqual({ immediate: true, tailMs: null });
  });

  it('间隔内 → 延后到尾部（保证捕获最后一次变化）', () => {
    expect(decideThrottle(0)).toEqual({ immediate: false, tailMs: FRAME_PREVIEW_THROTTLE_MS });
    expect(decideThrottle(40)).toEqual({ immediate: false, tailMs: FRAME_PREVIEW_THROTTLE_MS - 40 });
  });
});