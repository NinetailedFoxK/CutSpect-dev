import { describe, expect, it } from 'vitest';
import type { ProjectSummary } from '../src/shared/api-types';
import { filterProjects } from '../src/renderer/pages/Home';

/** 项目库搜索过滤与排序测试（规格 2.2）。 */

function make(id: string, name: string, source: string, lastEditedAt: string): ProjectSummary {
  return {
    projectId: id,
    name,
    sourceOriginalName: source,
    durationMs: 1000,
    lastEditedAt,
    status: 'ready',
    coverMediaUrl: null,
  };
}

const projects: ProjectSummary[] = [
  make('a', '开场钩子', 'clip-A.mp4', '2026-10-20T00:00:00.000Z'),
  make('b', '情绪曲线', 'clip-B.mov', '2026-10-22T00:00:00.000Z'),
  make('c', '高潮段落', 'clip-C.webm', '2026-10-21T00:00:00.000Z'),
];

describe('filterProjects（规格 2.2）', () => {
  it('默认按最近编辑降序', () => {
    expect(filterProjects(projects, '', new Set()).map((p) => p.projectId)).toEqual(['b', 'c', 'a']);
  });

  it('按项目名搜索（大小写不敏感、忽略首尾空白）', () => {
    expect(filterProjects(projects, '  高潮 ', new Set()).map((p) => p.projectId)).toEqual(['c']);
  });

  it('按源文件名搜索', () => {
    expect(filterProjects(projects, 'clip-b', new Set()).map((p) => p.projectId)).toEqual(['b']);
  });

  it('隐藏已从最近移除的项目', () => {
    expect(filterProjects(projects, '', new Set(['b'])).map((p) => p.projectId)).toEqual(['c', 'a']);
  });

  it('无匹配返回空数组', () => {
    expect(filterProjects(projects, '不存在', new Set())).toEqual([]);
  });
});