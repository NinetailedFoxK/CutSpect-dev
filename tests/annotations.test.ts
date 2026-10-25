import { describe, expect, it } from 'vitest';
import {
  addAnnotation,
  findAnnotationAt,
  removeAnnotation,
  sortAnnotations,
  titleFromBody,
  updateAnnotation,
} from '../src/shared/annotations';

/** 标注结构操作测试（规格 6）。 */

describe('addAnnotation（规格 6.1 唯一性）', () => {
  it('新建标注；同一毫秒重复创建返回已有标注', () => {
    const first = addAnnotation([], 5_000, 'a1');
    expect(first.created).toBe(true);
    expect(first.annotations).toHaveLength(1);

    const dup = addAnnotation(first.annotations, 5_000, 'a2');
    expect(dup.created).toBe(false);
    expect(dup.existing?.id).toBe('a1');
    expect(dup.annotations).toHaveLength(1);
  });

  it('按时间排序', () => {
    let list = addAnnotation([], 9_000, 'b').annotations;
    list = addAnnotation(list, 1_000, 'a').annotations;
    list = addAnnotation(list, 5_000, 'm').annotations;
    expect(list.map((a) => a.timeMs)).toEqual([1_000, 5_000, 9_000]);
    expect(findAnnotationAt(list, 5_000)?.id).toBe('m');
  });
});

describe('updateAnnotation（规格 6.2 修改与约束）', () => {
  it('修改标题/正文/时间；时间冲突被拒绝', () => {
    let list = addAnnotation([], 5_000, 'a').annotations;
    list = addAnnotation(list, 8_000, 'b').annotations;

    const ok = updateAnnotation(list, 'a', { title: '开场', body: '说明' });
    expect(ok.ok).toBe(true);
    expect(ok.annotations.find((a) => a.id === 'a')?.title).toBe('开场');

    const conflict = updateAnnotation(list, 'a', { timeMs: 8_000 });
    expect(conflict.ok).toBe(false);
    expect(conflict.message).toContain('同一时刻');
  });

  it('标题超过 80 与正文超过 5000 被拒绝', () => {
    const list = addAnnotation([], 5_000, 'a').annotations;
    expect(updateAnnotation(list, 'a', { title: 'x'.repeat(81) }).ok).toBe(false);
    expect(updateAnnotation(list, 'a', { body: 'x'.repeat(5001) }).ok).toBe(false);
  });

  it('修改标签偏移只改偏移，不动时间', () => {
    const list = addAnnotation([], 5_000, 'a').annotations;
    const moved = updateAnnotation(list, 'a', { labelOffset: { x: 40, y: 10 } });
    expect(moved.annotations[0]?.timeMs).toBe(5_000);
    expect(moved.annotations[0]?.labelOffset).toEqual({ x: 40, y: 10 });
  });
});

describe('removeAnnotation / titleFromBody / sortAnnotations', () => {
  it('删除标注', () => {
    const list = addAnnotation([], 5_000, 'a').annotations;
    expect(removeAnnotation(list, 'a')).toHaveLength(0);
  });

  it('标题为空时取正文首个非空行前 20 字符', () => {
    expect(titleFromBody('\n  第一行标题很长的样子超过二十个字符哦\n第二行')).toBe(
      '第一行标题很长的样子超过二十个字符哦'.slice(0, 20),
    );
    expect(titleFromBody('   \n  ')).toBe('');
  });

  it('sortAnnotations 不修改入参', () => {
    const list = addAnnotation(addAnnotation([], 9_000, 'b').annotations, 1_000, 'a').annotations;
    const sorted = sortAnnotations(list);
    expect(sorted.map((a) => a.timeMs)).toEqual([1_000, 9_000]);
  });
});