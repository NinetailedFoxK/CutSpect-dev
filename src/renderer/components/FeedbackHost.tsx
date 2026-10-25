/**
 * 反馈承载层组合：toast + 错误横幅 + 确认对话框。
 * 由 App 在应用外壳内挂载一次，覆盖所有页面。
 */

import { BannerHost } from './BannerHost';
import { ConfirmHost } from './ConfirmHost';
import { ToastHost } from './ToastHost';

export function FeedbackHost() {
  return (
    <>
      <BannerHost />
      <ToastHost />
      <ConfirmHost />
    </>
  );
}