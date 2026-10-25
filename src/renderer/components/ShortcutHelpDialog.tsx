import { useCallback, useEffect, useState } from 'react';
import {
  COMMANDS,
  DEFAULT_KEYMAP,
  bindingOwner,
  commandMeta,
  eventToBinding,
  formatBinding,
  wheelToBinding,
} from '@shared/keymap';
import type { CommandCategory, CommandId, KeyConflict } from '@shared/keymap';

/**
 * 快捷键速查面板（v1.1 需求 6.3）+ 自定义改键入口。
 *
 * - 按类别展示全部命令的当前键位（按平台显示 Command / Ctrl）。
 * - 点击某行键位进入录制态，按下新键即改绑；冲突、非法键位就地提示。
 * - 支持单项重置与全部恢复默认；Esc 关闭。
 * - 面板打开期间在捕获阶段拦截键盘事件，避免触发编辑器全局快捷键。
 */

const CATEGORY_LABELS: Readonly<Record<CommandCategory, string>> = {
  general: '通用剪辑操作',
  leftHand: 'CutSpect 左手快速操作',
};

const CATEGORY_ORDER: readonly CommandCategory[] = ['general', 'leftHand'];

export interface ShortcutHelpDialogProps {
  keymap: Record<CommandId, string>;
  isMac: boolean;
  conflicts: readonly KeyConflict[];
  onRebind(id: CommandId, binding: string): void;
  onResetCommand(id: CommandId): void;
  onResetAll(): void;
  onClose(): void;
}

export function ShortcutHelpDialog(props: ShortcutHelpDialogProps) {
  const { keymap, isMac, conflicts, onRebind, onResetCommand, onResetAll, onClose } = props;
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const conflictedIds = new Set<string>();
  for (const conflict of conflicts) {
    for (const id of conflict.commandIds) {
      conflictedIds.add(id);
    }
  }

  /** 统一应用一个键位（键盘与滚轮录制共用）。 */
  const applyBinding = useCallback(
    (binding: string): void => {
      if (recording === null) {
        return;
      }
      if (binding === keymap[recording]) {
        setRecording(null);
        setMessage(null);
        return;
      }
      const owner = bindingOwner(keymap, binding, recording);
      if (owner !== null) {
        const label = commandMeta(owner)?.label ?? owner;
        setMessage(`该组合已被「${label}」占用，请换一个。`);
        return;
      }
      onRebind(recording, binding);
      setMessage(`已把「${commandMeta(recording)?.label ?? recording}」改为 ${formatBinding(binding, isMac)}。`);
      setRecording(null);
    },
    [recording, isMac, keymap, onRebind],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (recording !== null) {
        event.preventDefault();
        // 录制态：Esc 取消录制（优先于把 Esc 绑给自己）。
        if (event.key === 'Escape') {
          setRecording(null);
          setMessage('已取消改键。');
          return;
        }
        const binding = eventToBinding(event, isMac);
        if (binding === null) {
          setMessage('请按下字母/数字/方向键，或滚动滚轮（可加 Command / Ctrl / Shift / Alt）。');
          return;
        }
        applyBinding(binding);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    },
    [recording, isMac, applyBinding, onClose],
  );

  // 录制态额外捕获滚轮（wheel 非 passive，才能 preventDefault 阻止页面缩放）。
  useEffect(() => {
    if (recording === null) {
      return undefined;
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const binding = wheelToBinding(event, isMac);
      if (binding !== null) {
        applyBinding(binding);
      }
    };
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => window.removeEventListener('wheel', onWheel, { capture: true });
  }, [recording, isMac, applyBinding]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [handleKeyDown]);

  const startRecording = useCallback((id: CommandId) => {
    setRecording(id);
    setMessage('按下新的快捷键，或滚动滚轮（中键滚动同样有效）…按 Esc 取消。');
  }, []);

  return (
    <div className="lp-shortcut-overlay" role="presentation" onPointerDown={() => setRecording(null)}>
      <div
        className="lp-shortcut-panel"
        role="dialog"
        aria-modal="true"
        aria-label="快捷键"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="lp-shortcut-header">
          <h2>快捷键</h2>
          <p className="lp-shortcut-hint">
            点击右侧键位后按下新组合即可修改；冲突会即时提示。{isMac ? '⌘ = Command' : 'Ctrl = Control'}
          </p>
        </header>

        <div className="lp-shortcut-body">
          {CATEGORY_ORDER.map((category) => (
            <section key={category} className="lp-shortcut-section">
              <h3>{CATEGORY_LABELS[category]}</h3>
              <ul>
                {COMMANDS.filter((command) => command.category === category).map((command) => {
                  const customized = keymap[command.id] !== DEFAULT_KEYMAP[command.id];
                  const conflict = conflictedIds.has(command.id);
                  return (
                    <li
                      key={command.id}
                      className={`lp-shortcut-row${conflict ? ' is-conflict' : ''}`}
                    >
                      <span className="lp-shortcut-label" title={command.description}>
                        {command.label}
                      </span>
                      <button
                        type="button"
                        className={`lp-shortcut-key${recording === command.id ? ' is-recording' : ''}`}
                        onClick={() => startRecording(command.id)}
                        title={conflict ? '键位冲突，点击修改' : '点击修改'}
                      >
                        {recording === command.id ? '按下新键…' : formatBinding(keymap[command.id], isMac)}
                      </button>
                      <button
                        type="button"
                        className="lp-shortcut-reset"
                        disabled={!customized}
                        onClick={() => {
                          onResetCommand(command.id);
                          setMessage(null);
                        }}
                        title="恢复该命令的默认键位"
                      >
                        重置
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>

        <footer className="lp-shortcut-footer">
          <span className="lp-shortcut-message" role="status">
            {message ?? (conflicts.length > 0 ? '存在键位冲突，请调整标红的项。' : '')}
          </span>
          <button type="button" className="lp-shortcut-action" onClick={onResetAll}>
            恢复全部默认
          </button>
          <button type="button" className="lp-shortcut-action is-primary" onClick={onClose}>
            关闭（Esc）
          </button>
        </footer>
      </div>
    </div>
  );
}