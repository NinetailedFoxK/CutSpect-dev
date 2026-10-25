/**
 * 反馈中枢的 React 适配（useSyncExternalStore）。
 *
 * 组件订阅的是模块级单例 store；getServerSnapshot 复用 getSnapshot，
 * 使 SSR 渲染（curve-layer.test 等）也能取到稳定的初始快照。
 */

import { useSyncExternalStore } from 'react';
import { feedbackStore, taskCenterStore } from './instance';
import type { FeedbackSnapshot } from './feedback-store';
import type { TaskCenterEntry } from './task-center-store';

export function useFeedbackSnapshot(): FeedbackSnapshot {
  return useSyncExternalStore(
    feedbackStore.subscribe,
    feedbackStore.getSnapshot,
    feedbackStore.getSnapshot,
  );
}

export function useTaskCenterEntries(): TaskCenterEntry[] {
  return useSyncExternalStore(
    taskCenterStore.subscribe,
    taskCenterStore.getSnapshot,
    taskCenterStore.getSnapshot,
  );
}