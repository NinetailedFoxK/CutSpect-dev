import { describe, expect, it } from 'vitest';
import { createHistory } from '../src/shared/history';

/**
 * 内容历史测试（规格 8.1）。
 */

describe('createHistory 基本撤销/重做', () => {
  it('提交后可撤销回上一状态，再重做', () => {
    const history = createHistory({ v: 0 });
    history.commit({ v: 1 });
    history.commit({ v: 2 });
    expect(history.present().v).toBe(2);
    expect(history.undo()?.v).toBe(1);
    expect(history.undo()?.v).toBe(0);
    expect(history.canUndo()).toBe(false);
    expect(history.undo()).toBeNull();
    expect(history.redo()?.v).toBe(1);
    expect(history.redo()?.v).toBe(2);
    expect(history.canRedo()).toBe(false);
    expect(history.redo()).toBeNull();
  });

  it('新提交清空重做栈', () => {
    const history = createHistory({ v: 0 });
    history.commit({ v: 1 });
    history.commit({ v: 2 });
    history.undo();
    history.commit({ v: 9 });
    expect(history.canRedo()).toBe(false);
    expect(history.present().v).toBe(9);
  });

  it('引用相等视为无变化，不产生历史', () => {
    const first = { v: 0 };
    const history = createHistory(first);
    expect(history.commit(first)).toBe(false);
    expect(history.depth()).toBe(0);
  });
});

describe('合并（500ms 空闲合并）', () => {
  it('同 coalesceKey 且窗口内合并为一条', () => {
    const history = createHistory({ text: '' });
    history.commit({ text: 'a' }, { coalesceKey: 'title', now: 1000 });
    history.commit({ text: 'ab' }, { coalesceKey: 'title', now: 1200 });
    history.commit({ text: 'abc' }, { coalesceKey: 'title', now: 1400 });
    expect(history.depth()).toBe(1);
    // 撤销一次回到合并前原始值。
    expect(history.undo()?.text).toBe('');
  });

  it('超过窗口不再合并', () => {
    const history = createHistory({ text: '' });
    history.commit({ text: 'a' }, { coalesceKey: 'title', now: 1000 });
    history.commit({ text: 'ab' }, { coalesceKey: 'title', now: 2000 });
    expect(history.depth()).toBe(2);
  });

  it('不同 key 不合并', () => {
    const history = createHistory({ a: 0 });
    history.commit({ a: 1 }, { coalesceKey: 'x', now: 1000 });
    history.commit({ a: 2 }, { coalesceKey: 'y', now: 1000 });
    expect(history.depth()).toBe(2);
  });

  it('撤销后打断合并，紧接的同 key 编辑作为新条目', () => {
    const history = createHistory({ text: '' });
    history.commit({ text: 'a' }, { coalesceKey: 'title', now: 1000 });
    history.undo();
    history.commit({ text: 'b' }, { coalesceKey: 'title', now: 1100 });
    expect(history.depth()).toBe(1);
    expect(history.present().text).toBe('b');
  });
});

describe('上限与重置', () => {
  it('超过 limit 丢弃最旧操作', () => {
    const history = createHistory<number>(0, { limit: 3 });
    for (let i = 1; i <= 10; i++) {
      history.commit(i);
    }
    expect(history.depth()).toBe(3);
    // 只能撤销 3 次。
    expect(history.undo()).toBe(9);
    expect(history.undo()).toBe(8);
    expect(history.undo()).toBe(7);
    expect(history.canUndo()).toBe(false);
  });

  it('reset 丢弃历史并设置新起点', () => {
    const history = createHistory({ v: 0 });
    history.commit({ v: 1 });
    history.reset({ v: 100 });
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.present().v).toBe(100);
    expect(history.depth()).toBe(0);
  });
});