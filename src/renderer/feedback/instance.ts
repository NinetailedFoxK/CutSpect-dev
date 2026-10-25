/**
 * 反馈中枢与任务中心的模块级单例（UI 各处共用同一份状态）。
 *
 * 之所以用单例而非 React Context：Home / Editor / ImportPage 分属不同页面，
 * 页面切换时反馈状态（正在展示的 toast / 确认框 / 任务列表）必须保持，
 * Context 会在页面卸载时丢失。工厂函数（createFeedbackStore 等）仍导出，
 * 供单测构造隔离实例。
 */

import { createFeedbackStore } from './feedback-store';
import { createTaskCenterStore } from './task-center-store';

export const feedbackStore = createFeedbackStore();
export const taskCenterStore = createTaskCenterStore();