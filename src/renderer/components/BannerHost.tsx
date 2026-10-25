/**
 * 错误横幅承载层（错误 → 下一步，规格 13）。
 *
 * 每个错误至少提供一个"下一步"操作按钮（如"重新定位""重试""打开备份"），
 * 技术细节折叠在"复制诊断信息"里，面向普通创作者只展示中文说明。
 */

import { useState } from 'react';
import { feedbackStore } from '../feedback/instance';
import { useFeedbackSnapshot } from '../feedback/hooks';
import type { BannerAction } from '../feedback/feedback-store';

export function BannerHost() {
  const snapshot = useFeedbackSnapshot();
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const banner = snapshot.banner;
  if (banner === null) {
    return null;
  }

  const runAction = (action: BannerAction): void => {
    void action.run();
  };

  const copyDiagnostics = (): void => {
    if (banner.diagnostics === undefined) {
      return;
    }
    void navigator.clipboard?.writeText(banner.diagnostics).catch(() => undefined);
  };

  return (
    <div
      className={`feedback-banner feedback-banner--${banner.kind}`}
      role={banner.kind === 'error' ? 'alert' : 'status'}
    >
      <div className="feedback-banner-main">
        <h2 className="feedback-banner-title">{banner.title}</h2>
        <p className="feedback-banner-message">{banner.message}</p>
      </div>
      <div className="feedback-banner-actions">
        {banner.actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={action.primary === true ? 'primary-button' : 'dialog-button-secondary'}
            onClick={() => runAction(action)}
          >
            {action.label}
          </button>
        ))}
        {banner.diagnostics !== undefined && (
          <button
            type="button"
            className="feedback-banner-link"
            onClick={() => setShowDiagnostics((v) => !v)}
          >
            {showDiagnostics ? '收起诊断信息' : '复制诊断信息'}
          </button>
        )}
        <button
          type="button"
          className="feedback-banner-close"
          aria-label="关闭提示"
          title="关闭提示"
          onClick={() => {
            setShowDiagnostics(false);
            feedbackStore.clearBanner();
          }}
        >
          ×
        </button>
      </div>
      {showDiagnostics && banner.diagnostics !== undefined && (
        <div className="feedback-banner-diagnostics">
          <textarea readOnly value={banner.diagnostics} aria-label="诊断信息" />
          <button type="button" className="dialog-button-secondary" onClick={copyDiagnostics}>
            复制
          </button>
        </div>
      )}
    </div>
  );
}
