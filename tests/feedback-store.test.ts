import { describe, expect, it } from 'vitest';
import { createFeedbackStore } from '../src/renderer/feedback/feedback-store';

/**
 * 统一反馈中枢测试（批次 1 基础设施）。
 * 覆盖：toast 增删、snapshot 引用稳定（useSyncExternalStore 前提）、
 * 自动消失、banner 覆盖/清除、confirm 顶替与 resolve、订阅健壮性。
 */

describe('createFeedbackStore（统一反馈）', () => {
  it('pushToast 追加并可 dismissToast 移除', () => {
    const store = createFeedbackStore();
    const id = store.pushToast({ kind: 'success', message: '已保存', durationMs: 0 });
    expect(store.getSnapshot().toasts.map((t) => t.message)).toEqual(['已保存']);
    store.dismissToast(id);
    expect(store.getSnapshot().toasts).toEqual([]);
  });

  it('状态未变化时 getSnapshot 引用稳定', () => {
    const store = createFeedbackStore();
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.pushToast({ kind: 'info', message: 'x', durationMs: 0 });
    expect(store.getSnapshot()).not.toBe(first);
  });

  it('带 action 的 toast 缺省停留更久（撤销窗口）', () => {
    const store = createFeedbackStore();
    store.pushToast({ kind: 'info', message: '已移除', action: { label: '撤销', run: () => undefined } });
    expect(store.getSnapshot().toasts[0]?.durationMs).toBe(6000);
  });

  it('自动消失：durationMs 到点后移除', async () => {
    const store = createFeedbackStore();
    store.pushToast({ kind: 'info', message: 'x', durationMs: 10 });
    expect(store.getSnapshot().toasts).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(store.getSnapshot().toasts).toHaveLength(0);
  });

  it('showBanner 覆盖旧横幅，clearBanner 清除', () => {
    const store = createFeedbackStore();
    store.showBanner({ kind: 'error', title: '打开失败', message: 'm1', actions: [] });
    store.showBanner({ kind: 'error', title: '保存失败', message: 'm2', actions: [] });
    expect(store.getSnapshot().banner?.title).toBe('保存失败');
    store.clearBanner();
    expect(store.getSnapshot().banner).toBeNull();
  });

  it('confirm：新请求顶替旧请求（旧请求按取消处理），resolveConfirm 兑现', async () => {
    const store = createFeedbackStore();
    const first = store.confirm({ title: 'A', message: 'a', confirmLabel: '确定' });
    const second = store.confirm({ title: 'B', message: 'b', confirmLabel: '仍要新建' });
    expect(await first).toBe(false);
    expect(store.getSnapshot().confirm?.title).toBe('B');
    store.resolveConfirm(true);
    expect(await second).toBe(true);
    expect(store.getSnapshot().confirm).toBeNull();
  });

  it('confirm 缺省：cancelLabel 取消、danger false', async () => {
    const store = createFeedbackStore();
    const p = store.confirm({ title: 'A', message: 'a', confirmLabel: '确定' });
    const pending = store.getSnapshot().confirm;
    expect(pending?.cancelLabel).toBe('取消');
    expect(pending?.danger).toBe(false);
    store.resolveConfirm(false);
    expect(await p).toBe(false);
  });

  it('subscribe 返回退订；单个 listener 抛错不影响广播', () => {
    const store = createFeedbackStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
      throw new Error('boom');
    });
    store.pushToast({ kind: 'info', message: 'x', durationMs: 0 });
    expect(calls).toBe(1);
    unsubscribe();
    store.pushToast({ kind: 'info', message: 'y', durationMs: 0 });
    expect(calls).toBe(1);
  });
});