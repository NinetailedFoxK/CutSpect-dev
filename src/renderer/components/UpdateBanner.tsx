/**
 * 自动更新横幅（不打扰用户）：
 * - 无更新 / 检查中：不渲染任何内容；
 * - 有更新（后台下载中）→ 已就绪（可重启安装）→ 出错（可关闭）；
 * - 「立即重启并安装」前先保存项目（由调用方注入 onInstall 保证）；
 * - 渲染层只接收状态对象，不含任何 Token / 私有地址。
 */
import { useCallback, useEffect, useState } from 'react';
import { INITIAL_UPDATE_STATE } from '@shared/update';
import type { UpdateState } from '@shared/update';

export interface UpdateBannerProps {
  /** 点「立即重启并安装」时：先保存项目，再触发安装。 */
  onInstall?: () => void | Promise<void>;
}

const BUTTON_STYLE = {
  border: '1px solid rgba(255,255,255,0.2)',
  background: 'transparent',
  color: '#E6EDF3',
  borderRadius: 6,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
} as const;

const PRIMARY_BUTTON_STYLE = {
  ...BUTTON_STYLE,
  background: '#2F81F7',
  border: '1px solid #2F81F7',
  color: '#FFFFFF',
} as const;

export function UpdateBanner({ onInstall }: UpdateBannerProps) {
  const [state, setState] = useState<UpdateState>(INITIAL_UPDATE_STATE);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = window.laipian?.updates;
    if (api === undefined) {
      return undefined;
    }
    let active = true;
    void api.getState().then((result) => {
      if (active && result.ok) {
        setState(result.data);
      }
    });
    const unsubscribe = api.subscribe((next) => {
      setDismissed(false);
      setState(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const handleInstall = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      if (onInstall !== undefined) {
        await onInstall();
      } else {
        await window.laipian?.updates.install();
      }
    } finally {
      setBusy(false);
    }
  }, [onInstall]);

  if (dismissed) {
    return null;
  }
  if (state.status !== 'available' && state.status !== 'ready' && state.status !== 'error') {
    return null;
  }

  const isError = state.status === 'error';
  const isReady = state.status === 'ready';
  const fallback =
    isReady === true ? '更新已准备好，可重启并安装。' : '发现新版本，正在后台下载…';
  const message = state.message ?? fallback;

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 60,
        maxWidth: 360,
        padding: '10px 14px',
        borderRadius: 10,
        background: isError ? '#3A1D1D' : '#1D2733',
        color: '#E6EDF3',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        fontSize: 13,
        lineHeight: 1.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div>
        {state.version !== null ? `新版本 ${state.version}：` : ''}
        {message}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" style={BUTTON_STYLE} onClick={() => setDismissed(true)}>
          稍后
        </button>
        {isReady && (
          <button
            type="button"
            style={PRIMARY_BUTTON_STYLE}
            disabled={busy}
            onClick={() => void handleInstall()}
          >
            {busy ? '正在保存…' : '立即重启并安装'}
          </button>
        )}
      </div>
    </div>
  );
}