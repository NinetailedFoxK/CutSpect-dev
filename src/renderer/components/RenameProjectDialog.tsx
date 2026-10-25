import { useEffect, useRef, useState } from 'react';
import type { ProjectSummary } from '@shared/api-types';

/**
 * 重命名弹窗（规格 2.2 卡片操作）：单字段输入新项目名。
 * 提交调用 window.laipian.projects.rename()；成功后由父级刷新列表，
 * Result 错误以中文提示显示在弹窗内。
 */

export interface RenameProjectDialogProps {
  /** 目标项目；null 时不渲染。 */
  project: ProjectSummary | null;
  hasApi: boolean;
  onClose: () => void;
  /** 重命名成功（main 已确认）。 */
  onRenamed: (projectId: string, name: string) => void;
}

export function RenameProjectDialog({
  project,
  hasApi,
  onClose,
  onRenamed,
}: RenameProjectDialogProps) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 切换目标项目时带入当前名称并聚焦全选输入框。
  useEffect(() => {
    if (project !== null) {
      setName(project.name);
      setFormError(null);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [project]);

  // Esc 关闭（无未保存风险：重命名未提交即丢弃）。
  useEffect(() => {
    if (project === null) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [project, onClose]);

  if (project === null) {
    return null;
  }

  const submit = async (): Promise<void> => {
    const api = window.laipian;
    if (!api) {
      return;
    }
    const newName = name.trim();
    if (newName.length === 0 || newName === project.name) {
      // 未修改直接关闭，不发起 IPC 调用。
      onClose();
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await api.projects.rename({ projectId: project.projectId, name: newName });
      if (!result.ok) {
        setFormError(`重命名失败：${result.error.message}`);
        return;
      }
      onRenamed(project.projectId, newName);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="dialog dialog--rename"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-dialog-title"
      >
        <h2 id="rename-dialog-title">重命名项目</h2>
        <p className="dialog-hint">「{project.name}」· 项目名可以重复（磁盘文件夹名不受影响）。</p>
        <div className="dialog-field">
          <label className="dialog-field-label" htmlFor="rename-dialog-input">
            新名称
          </label>
          <input
            ref={inputRef}
            id="rename-dialog-input"
            className="dialog-field-input"
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </div>
        {formError !== null && (
          <p className="dialog-error" role="alert">
            {formError}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="dialog-button-secondary" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!hasApi || submitting || name.trim().length === 0}
            title={hasApi ? undefined : '需要桌面运行环境'}
            onClick={() => void submit()}
          >
            {submitting ? '正在保存…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}