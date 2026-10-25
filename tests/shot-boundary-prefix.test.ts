import { describe, expect, it } from 'vitest';
import { SHOT_BOUNDARY_PREFIX, isShotGeneratedBoundary } from '../src/shared/sections';
import { applyShotCuts } from '../src/renderer/editor/shot-apply';
import type { Boundary, Section } from '../src/shared/api-types';

/**
 * 镜头识别边界与手动段落边界的区分（监视器只显示焦点镜头边界）。
 */

describe('isShotGeneratedBoundary', () => {
  it('识别 shot-apply 生成的前缀', () => {
    expect(isShotGeneratedBoundary(`${SHOT_BOUNDARY_PREFIX}abc-1`)).toBe(true);
    expect(isShotGeneratedBoundary('b-1234')).toBe(false);
    expect(isShotGeneratedBoundary('p-boundary-start')).toBe(false);
  });
});

describe('applyShotCuts 生成的边界带可识别前缀', () => {
  it('切点转为 bnd-shot- 前缀边界，与手动边界可区分', () => {
    const durationMs = 10_000;
    const boundaries: Boundary[] = [
      { id: 'p-boundary-start', timeMs: 0, fixed: true, locked: true },
      { id: 'p-boundary-end', timeMs: durationMs, fixed: true, locked: true },
    ];
    const sections: Section[] = [
      { id: 'p-section-1', startBoundaryId: 'p-boundary-start', name: '段落 1', note: '' },
    ];
    const result = applyShotCuts(boundaries, sections, [3000, 6000], durationMs);
    const generated = result.boundaries.filter((b) => isShotGeneratedBoundary(b.id));
    expect(generated.length).toBeGreaterThan(0);
    for (const boundary of generated) {
      expect(boundary.id.startsWith(SHOT_BOUNDARY_PREFIX)).toBe(true);
    }
    // 手动首尾边界仍在且不是 shot 前缀。
    expect(result.boundaries.some((b) => b.id === 'p-boundary-start' && !isShotGeneratedBoundary(b.id))).toBe(true);
  });
});