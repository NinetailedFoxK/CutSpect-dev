import type { Boundary, DetectedCut, Section } from '@shared/api-types';
import { addBoundary, SHOT_BOUNDARY_PREFIX } from '@shared/sections';
import { SHOT_BOUNDARY_DEDUPE_MS } from '@shared/shots';

/**
 * 把镜头识别候选切点转换为正式分段（纯函数，供 Editor 与测试共用）。
 *
 * 规则（需求：智能识别镜头）：
 * - 与已有边界（含手动/锁定/端点）相距 < 100ms 的候选一律跳过 → 保留手动边界，不重复添加；
 * - 逐个复用 addBoundary，从而继承其全部不变量（端点不可越、间隔 ≥ 100ms、保留已有段落名称/备注）；
 * - 新增段落按时间顺序命名为「镜头 001」「镜头 002」…；
 * - 返回全新的 boundaries / sections（调用方一次 commit → 一条历史 → 可整批撤销）。
 */

export interface ApplyShotCutsResult {
  boundaries: Boundary[];
  sections: Section[];
  appliedCount: number;
}

/** 过滤后可用于应用的候选时间点（升序、去重、与现有边界不冲突）。 */
export function filterCandidateTimes(
  boundaries: readonly Boundary[],
  cutTimes: readonly number[],
): number[] {
  const unique = [...new Set(cutTimes.map((t) => Math.round(t)))].sort((a, b) => a - b);
  return unique.filter((timeMs) =>
    boundaries.every((boundary) => Math.abs(boundary.timeMs - timeMs) >= SHOT_BOUNDARY_DEDUPE_MS),
  );
}

export function applyShotCuts(
  boundaries: readonly Boundary[],
  sections: readonly Section[],
  cutTimes: readonly number[],
  durationMs: number,
  idSuffix = 'shots',
): ApplyShotCutsResult {
  let nextBoundaries = [...boundaries];
  let nextSections = [...sections];
  const created: { boundaryId: string; timeMs: number }[] = [];

  const candidates = filterCandidateTimes(boundaries, cutTimes);
  for (let index = 0; index < candidates.length; index++) {
    const timeMs = candidates[index];
    if (timeMs === undefined) {
      continue;
    }
    const boundaryId = `${SHOT_BOUNDARY_PREFIX}${idSuffix}-${index}`;
    const sectionId = `sec-shot-${idSuffix}-${index}`;
    const edit = addBoundary(nextBoundaries, nextSections, timeMs, boundaryId, sectionId, durationMs);
    if (edit.ok) {
      nextBoundaries = edit.boundaries;
      nextSections = edit.sections;
      created.push({ boundaryId, timeMs });
    }
  }

  const nameByBoundary = new Map(
    created
      .slice()
      .sort((a, b) => a.timeMs - b.timeMs)
      .map((item, index) => [item.boundaryId, `镜头 ${String(index + 1).padStart(3, '0')}`] as const),
  );
  const renamed = nextSections.map((section) => {
    const name = nameByBoundary.get(section.startBoundaryId);
    return name === undefined ? section : { ...section, name };
  });

  return { boundaries: nextBoundaries, sections: renamed, appliedCount: created.length };
}

/** 候选切点中与现有边界重复（< 100ms）的数量（供 UI 提示）。 */
export function countConflictingCuts(
  boundaries: readonly Boundary[],
  cuts: readonly DetectedCut[],
): number {
  return cuts.filter((cut) =>
    boundaries.some((boundary) => Math.abs(boundary.timeMs - cut.timeMs) < SHOT_BOUNDARY_DEDUPE_MS),
  ).length;
}