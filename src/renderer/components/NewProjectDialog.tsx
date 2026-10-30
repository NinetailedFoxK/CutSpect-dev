import { useEffect, useRef, useState } from 'react';
import type { FileSelectionToken, VideoPickResult } from '@shared/api-types';
import { formatTimeMs } from '@shared/time';
import { feedbackStore } from '../feedback/instance';
import {
  formatAspectRatio,
  formatBytes,
  formatResolution,
  stripExtension,
} from '../lib/format';

/**
 * 新建项目弹窗（规格 2.3）：视频文件 / 项目名称 / 保存位置 三字段。
 *
 * 数据与降级约定：
 * - 选择按钮调用 window.laipian.dialog.pickVideoFile() / pickProjectDir()，
 *   返回一次性 FileSelectionToken（opaque）。当前 main 侧令牌是纯 UUID，
 *   不携带文件名；因此“选中后显示文件名 / 名称自动带入”在拿不到文件名时
 *   降级为“已选择（文件名待主进程返回）”，绝不显示编造的文件名或数字。
 * - extractPickMeta() 以运行时类型守卫兼容两种形态：纯字符串令牌（现状）
 *   与 { token, fileName } 对象（集成阶段 main 扩展 pick* 返回值后的契约，
 *   也是 dev demo 注入演示“名称自动带入”的形态）。
 * - 源文件大小 / 目标可用空间由 main 返回（当前契约未包含），统一显示 “—”。
 * - “保存位置记住最近选择”由 main 侧文件选择器实现（renderer 永远不接触
 *   真实路径，且令牌一次性不可复用），renderer 不预填、不用 localStorage。
 *
 * 生命周期：父组件始终渲染本组件（isOpen 控制显隐），isOpen=false 时返回
 * null 但组件实例不卸载——表单内容暂存内存（规格：Esc 关闭无未保存损失风险）。
 * 令牌 TTL 15 分钟（main 侧约定），过期后 create 会返回真实错误。
 */

/** 新建项目成功后带出的源视频元信息（供导入页预览）。 */
export interface ImportSourceMeta {
  fileName: string;
  sizeBytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

export interface NewProjectCreatedInfo {
  projectId: string;
  projectName: string;
  /** 源视频元信息；未能读取时为 null。 */
  source: ImportSourceMeta | null;
}

/** 系统「打开方式」带入新建弹窗的视频。version 每来一次新文件就加一。 */
export interface ExternalVideoSeed {
  version: number;
  video: VideoPickResult;
}

export interface NewProjectDialogProps {
  isOpen: boolean;
  /** window.laipian 是否存在（浏览器预览模式为 false，全部选择按钮禁用）。 */
  hasApi: boolean;
  onClose: () => void;
  /** projects.create 成功：切换到导入页。 */
  onCreated: (info: NewProjectCreatedInfo) => void;
  /**
   * 系统「打开方式」已选好的视频。seedVersion 变化时预填，
   * 等同用户刚在选择器里选中该文件（仍需确认保存位置）。
   */
  seedVideo?: VideoPickResult | null;
  seedVersion?: number;
}

interface PickedSelection {
  token: FileSelectionToken;
  /** 展示名（文件名 / 目录名）；主进程未返回时为 null，UI 降级显示。 */
  label: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 从 pick* 返回值提取令牌与可选展示名。
 * @param raw 契约声明为 VideoPickResult；运行时防御性兼容纯字符串令牌
 *            （旧契约）与对象形态，供集成阶段与 dev demo 注入。
 */
function extractPickMeta(raw: unknown): PickedSelection {
  if (typeof raw === 'object' && raw !== null && 'token' in raw) {
    const obj = raw as Partial<VideoPickResult> & { token?: unknown; fileName?: unknown };
    if (typeof obj.token === 'string' && obj.token.length > 0) {
      return {
        token: obj.token as FileSelectionToken,
        label: typeof obj.fileName === 'string' && obj.fileName.length > 0 ? obj.fileName : null,
        sizeBytes: numberOrNull(obj.sizeBytes),
        durationMs: numberOrNull(obj.durationMs),
        width: numberOrNull(obj.width),
        height: numberOrNull(obj.height),
      };
    }
  }
  if (typeof raw === 'string' && raw.length > 0) {
    return emptySelection(raw as FileSelectionToken);
  }
  return emptySelection('' as FileSelectionToken);
}

function emptySelection(token: FileSelectionToken): PickedSelection {
  return { token, label: null, sizeBytes: null, durationMs: null, width: null, height: null };
}

export function NewProjectDialog({
  isOpen,
  hasApi,
  onClose,
  onCreated,
  seedVideo = null,
  seedVersion = 0,
}: NewProjectDialogProps) {
  const [source, setSource] = useState<PickedSelection | null>(null);
  const [destination, setDestination] = useState<PickedSelection | null>(null);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [picking, setPicking] = useState<'video' | 'dir' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const videoButtonRef = useRef<HTMLButtonElement | null>(null);

  // Esc 关闭弹窗（规格 14“取消手势或草稿”：表单仅暂存内存，无损失风险）。
  useEffect(() => {
    if (!isOpen) {
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
  }, [isOpen, onClose]);

  // 打开时把焦点移到第一个控件（可访问性：可见焦点 + 键盘可达）。
  useEffect(() => {
    if (isOpen) {
      videoButtonRef.current?.focus();
    }
  }, [isOpen]);

  // 系统「打开方式」：预填视频与项目名，保存位置仍由用户确认。
  useEffect(() => {
    if (seedVersion === 0 || seedVideo === null) {
      return;
    }
    const meta = extractPickMeta(seedVideo);
    setSource(meta);
    setNameTouched(false);
    setFormError(null);
    setName(meta.label !== null ? stripExtension(meta.label) : '');
  }, [seedVersion, seedVideo]);

  const pickVideoFile = async (): Promise<void> => {
    const api = window.laipian;
    if (!api) {
      return;
    }
    setPicking('video');
    setFormError(null);
    try {
      const result = await api.dialog.pickVideoFile();
      if (!result.ok) {
        setFormError(`选择视频失败：${result.error.message}`);
        return;
      }
      if (result.data === null) {
        return; // 用户在系统选择器中取消，静默返回（不算错误）。
      }
      const meta = extractPickMeta(result.data);
      setSource(meta);
      // 名称自动带入去扩展名的文件名（规格 2.3）；用户已手动改过则不覆盖。
      if (!nameTouched && meta.label !== null) {
        setName(stripExtension(meta.label));
      }
    } finally {
      setPicking(null);
    }
  };

  const pickProjectDir = async (): Promise<void> => {
    const api = window.laipian;
    if (!api) {
      return;
    }
    setPicking('dir');
    setFormError(null);
    try {
      const result = await api.dialog.pickProjectDir();
      if (!result.ok) {
        setFormError(`选择保存位置失败：${result.error.message}`);
        return;
      }
      if (result.data === null) {
        return;
      }
      setDestination(extractPickMeta(result.data));
    } finally {
      setPicking(null);
    }
  };

  const trimmedName = name.trim();
  const canSubmit =
    hasApi && source !== null && destination !== null && trimmedName.length > 0 && !submitting;

  const submit = async (): Promise<void> => {
    const api = window.laipian;
    if (!api || source === null || destination === null) {
      return;
    }
    const projectName = trimmedName;
    if (projectName.length === 0) {
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      // 重复导入预检（规格 2）：命中已有项目时先确认，再带 allowDuplicate 提交。
      let allowDuplicate = false;
      if (source.label !== null && source.sizeBytes !== null) {
        const check = await api.projects.checkDuplicate({
          fileName: source.label,
          sizeBytes: source.sizeBytes,
        });
        if (check.ok && check.data.duplicate !== null) {
          const confirmed = await feedbackStore.confirm({
            title: '这个视频已经导入过了',
            message: `「${source.label}」已导入为项目「${check.data.duplicate.name}」。`,
            impact: '继续会再次复制同一份视频到新项目文件夹，额外占用磁盘空间；已有项目不受影响。',
            confirmLabel: '仍要新建',
            cancelLabel: '取消',
          });
          if (!confirmed) {
            return;
          }
          allowDuplicate = true;
        }
      }
      const result = await api.projects.create({
        sourceSelectionToken: source.token,
        name: projectName,
        destinationSelectionToken: destination.token,
        ...(allowDuplicate ? { allowDuplicate: true } : {}),
      });
      if (!result.ok) {
        // Result 错误已是面向创作者的中文提示（规格 15）。
        setFormError(`创建项目失败：${result.error.message}`);
        return;
      }
      onCreated({
        projectId: result.data.projectId,
        projectName,
        source:
          source.label === null
            ? null
            : {
                fileName: source.label,
                sizeBytes: source.sizeBytes,
                durationMs: source.durationMs,
                width: source.width,
                height: source.height,
              },
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) {
    return null;
  }


  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        // 点击遮罩空白处关闭；面板内部点击不触发（规格 14：Esc 亦可关闭）。
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="dialog dialog--new-project"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-dialog-title"
      >
        <h2 id="new-project-dialog-title">新建项目</h2>

        <div className="dialog-field">
          <span className="dialog-field-label" id="new-project-video-label">
            视频文件
          </span>
          <button
            ref={videoButtonRef}
            type="button"
            className="dialog-field-button"
            aria-labelledby="new-project-video-label"
            disabled={!hasApi || picking !== null}
            title={hasApi ? undefined : '需要桌面运行环境（浏览器预览模式无文件选择器）'}
            onClick={() => void pickVideoFile()}
          >
            {picking === 'video'
              ? '正在打开系统选择器…（读取视频信息中）'
              : source === null
                ? '选择视频文件…'
                : (source.label ?? '已选择（未能读取文件名）')}
          </button>
        </div>

        <div className="dialog-field">
          <label className="dialog-field-label" htmlFor="new-project-name-input">
            项目名称
          </label>
          <input
            id="new-project-name-input"
            className="dialog-field-input"
            type="text"
            value={name}
            placeholder={source?.label !== null && source?.label !== undefined
              ? `默认使用视频文件名（如 ${stripExtension(source.label ?? '')}）`
              : '选择视频后自动带入，也可直接输入'}
            onChange={(event) => {
              setNameTouched(true);
              setName(event.target.value);
            }}
          />
        </div>

        <div className="dialog-field">
          <span className="dialog-field-label" id="new-project-dir-label">
            保存位置
          </span>
          <button
            type="button"
            className="dialog-field-button"
            aria-labelledby="new-project-dir-label"
            disabled={!hasApi || picking !== null}
            title={hasApi ? undefined : '需要桌面运行环境（浏览器预览模式无目录选择器）'}
            onClick={() => void pickProjectDir()}
          >
            {picking === 'dir'
              ? '正在打开系统选择器…'
              : destination === null
                ? '选择保存位置…'
                : destination.label !== null
                  ? destination.label
                  : '已选择（位置信息待主进程返回）'}
          </button>
        </div>

        <dl className="dialog-meta">
          <div className="dialog-meta-row">
            <dt>视频名称</dt>
            <dd title={source?.label ?? undefined}>{source?.label ?? '—'}</dd>
          </div>
          <div className="dialog-meta-row">
            <dt>大小</dt>
            <dd>{formatBytes(source?.sizeBytes ?? null)}</dd>
          </div>
          <div className="dialog-meta-row">
            <dt>时长</dt>
            <dd>
              {source?.durationMs !== null && source?.durationMs !== undefined
                ? formatTimeMs(source.durationMs)
                : '—'}
            </dd>
          </div>
          <div className="dialog-meta-row">
            <dt>画面比例</dt>
            <dd>
              {source !== null && source.width !== null && source.height !== null
                ? `${formatResolution(source.width, source.height)} · ${formatAspectRatio(source.width, source.height)}`
                : '—'}
            </dd>
          </div>
        </dl>

        <p className="dialog-hint">视频将复制到项目文件夹，原文件保持不变。</p>

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
            disabled={!canSubmit}
            title={
              hasApi
                ? undefined
                : '需要桌面运行环境（浏览器预览模式无法创建项目）'
            }
            onClick={() => void submit()}
          >
            {submitting ? '正在创建…' : '创建并导入'}
          </button>
        </div>
      </div>
    </div>
  );
}