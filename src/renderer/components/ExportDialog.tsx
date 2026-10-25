import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ExportEstimate,
  ExportFieldId,
  ExportFrameSettings,
  ExportKind,
  ExportLayoutSettings,
  ExportModuleId,
  ExportProduct,
  ExportRequest,
  ExportScope,
  ExportTemplate,
  ExportTableSettings,
  ProjectSnapshot,
} from '@shared/api-types';
import {
  DEFAULT_EXPORT_MODULES,
  DEFAULT_FRAME_SETTINGS,
  DEFAULT_LAYOUT_SETTINGS,
  DEFAULT_TABLE_FIELDS,
  EXPORT_FIELD_LABEL,
  EXPORT_KIND_DEFS,
  EXPORT_KIND_LABEL,
  EXPORT_MODULE_DEFS,
  EXPORT_SCOPE_LABEL,
  applyTemplate,
  buildStandardRequest,
  toTemplate,
} from '@shared/export-config';
import { estimateExport } from '@shared/export-estimate';
import { findNode, resolveNodeAt } from '@shared/structure';
import { Icon } from './Icons';
import { currentAdapter } from '../../platform/common';

const PLATFORM = currentAdapter();

/**
 * 导出中心对话框（规格 13 重设计）。
 *
 * 交互（三层，普通用户三步完成）：
 *   1. 标准导出：只选「阅读与分享（PDF）」或「继续整理（Excel）」+ 范围；
 *   2. 专业自定义：作为次级入口，折叠展开后可调范围 / 模块 / 画面 / 字段 / 排版 / 输出格式；
 *   3. 导出过程：进度 + 当前步骤 + 取消；完成后可「打开文件」「在文件夹中显示」。
 *
 * 只调用 window.laipian 的 exports.* 与 tasks.*；浏览器预览模式（无 api）禁用导出。
 */

export interface ExportDialogSelection {
  /** 当前选中的三级结构节点 id（章节/段落/镜头）。 */
  structureId: string | null;
  /** 当前选中的旧分段 id（无三级结构选中时的兜底）。 */
  sectionId: string | null;
  playheadMs: number;
}

export interface ExportDialogProps {
  isOpen: boolean;
  snapshot: ProjectSnapshot;
  selection: ExportDialogSelection;
  /** window.laipian 是否存在（浏览器预览模式为 false）。 */
  hasApi: boolean;
  onClose: () => void;
  /** 导出前先等待项目保存完成。 */
  onSaveRequested?: () => Promise<void> | void;
}

interface CustomState {
  kinds: ExportKind[];
  scopeKind: ExportScope['kind'];
  timeStartMs: number;
  timeEndMs: number;
  modules: ExportModuleId[];
  frames: ExportFrameSettings;
  table: ExportTableSettings;
  layout: ExportLayoutSettings;
  zip: boolean;
}

const CUSTOM_KINDS_DEFAULT: ExportKind[] = ['pdf'];

function initialCustom(snapshot: ProjectSnapshot): CustomState {
  return {
    kinds: [...CUSTOM_KINDS_DEFAULT],
    scopeKind: 'project',
    timeStartMs: 0,
    timeEndMs: snapshot.media.durationMs,
    modules: [...DEFAULT_EXPORT_MODULES],
    frames: { ...DEFAULT_FRAME_SETTINGS, includeShotFrame: true, includeCurveNodeFrames: true },
    table: { fields: [...DEFAULT_TABLE_FIELDS] },
    layout: { ...DEFAULT_LAYOUT_SETTINGS },
    zip: false,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${Math.max(0, Math.round(bytes))} B`;
}

export function ExportDialog(props: ExportDialogProps): React.ReactElement | null {
  const { isOpen, snapshot, selection, hasApi, onClose, onSaveRequested } = props;
  const structure = snapshot.structure ?? [];

  const [standardKind, setStandardKind] = useState<'pdf' | 'xlsx'>('pdf');
  const [standardScope, setStandardScope] = useState<'project' | 'section'>('project');
  const [showCustom, setShowCustom] = useState(false);
  const [custom, setCustom] = useState<CustomState>(() => initialCustom(snapshot));
  const [templates, setTemplates] = useState<ExportTemplate[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error' | 'cancelled'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [step, setStep] = useState<string>('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [products, setProducts] = useState<ExportProduct[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  /* ---- 当前章 / 当前段落的解析（用于范围选项） ---- */
  const structureId = selection.structureId;
  const currentChapterId = useMemo(() => {
    if (structureId !== null) {
      const node = findNode(structure, structureId);
      if (node !== undefined) {
        if (node.level === 'chapter') return node.id;
        if (node.level === 'section') return node.parentId;
        if (node.level === 'shot') {
          const section = node.parentId !== null ? findNode(structure, node.parentId) : undefined;
          return section?.parentId ?? null;
        }
      }
    }
    return resolveNodeAt(structure, 'chapter', selection.playheadMs, snapshot.media.durationMs)?.id ?? null;
  }, [structure, structureId, selection.playheadMs, snapshot.media.durationMs]);

  const currentSectionId = useMemo(() => {
    if (structureId !== null) {
      const node = findNode(structure, structureId);
      if (node !== undefined) {
        if (node.level === 'section') return node.id;
        if (node.level === 'shot') return node.parentId;
      }
    }
    return resolveNodeAt(structure, 'section', selection.playheadMs, snapshot.media.durationMs)?.id ?? null;
  }, [structure, structureId, selection.playheadMs, snapshot.media.durationMs]);

  const currentShotId = useMemo(() => {
    if (structureId === null) return null;
    return findNode(structure, structureId)?.level === 'shot' ? structureId : null;
  }, [structure, structureId]);

  const buildScope = useCallback(
    (kind: ExportScope['kind']): ExportScope => {
      switch (kind) {
        case 'chapter':
          return currentChapterId !== null ? { kind, nodeIds: [currentChapterId] } : { kind: 'project' };
        case 'section':
          return currentSectionId !== null ? { kind, nodeIds: [currentSectionId] } : { kind: 'project' };
        case 'shots':
          return currentShotId !== null ? { kind, nodeIds: [currentShotId] } : { kind: 'project' };
        case 'timeRange':
          return { kind, startMs: custom.timeStartMs, endMs: custom.timeEndMs };
        case 'project':
        default:
          return { kind: 'project' };
      }
    },
    [currentChapterId, currentSectionId, currentShotId, custom.timeStartMs, custom.timeEndMs],
  );

  /* ---- 当前生效的导出请求（用于预览与执行） ---- */
  const activeRequest: ExportRequest = useMemo(() => {
    const name = snapshot.name;
    if (!showCustom) {
      const scope: ExportScope =
        standardScope === 'section' && currentSectionId !== null
          ? { kind: 'section', nodeIds: [currentSectionId] }
          : { kind: 'project' };
      return buildStandardRequest(
        {
          projectId: snapshot.id,
          snapshot,
          suggestedName: standardKind === 'pdf' ? `${name}-拉片报告` : `${name}-拉片表格`,
          scope,
        },
        standardKind,
      );
    }
    return {
      projectId: snapshot.id,
      snapshot,
      kinds: custom.kinds.length > 0 ? custom.kinds : ['pdf'],
      scope: buildScope(custom.scopeKind),
      modules: custom.modules.length > 0 ? custom.modules : ['shotTable'],
      frames: custom.frames,
      table: custom.table,
      layout: custom.layout,
      zip: custom.zip && custom.kinds.length > 1,
      suggestedName: `${name}-导出`,
    };
  }, [showCustom, standardKind, standardScope, currentSectionId, custom, buildScope, snapshot]);

  const estimate: ExportEstimate | null = useMemo(() => {
    if (!isOpen) return null;
    try {
      return estimateExport({
        snapshot: activeRequest.snapshot,
        kinds: activeRequest.kinds,
        scope: activeRequest.scope,
        modules: activeRequest.modules,
        frames: activeRequest.frames,
        table: activeRequest.table,
        layout: activeRequest.layout,
      });
    } catch {
      return null;
    }
  }, [isOpen, activeRequest]);

  /* ---- 打开时加载模板 + 重置状态 ---- */
  useEffect(() => {
    if (!isOpen) return undefined;
    setStatus('idle');
    setMessage(null);
    setTaskId(null);
    setProducts([]);
    setStep('');
    setCustom(initialCustom(snapshot));
    const api = window.laipian;
    if (!api) return undefined;
    let alive = true;
    void api.settings.get().then((res) => {
      if (alive && res.ok) {
        setTemplates(res.data.exportTemplates ?? []);
      }
    });
    return () => {
      alive = false;
    };
  }, [isOpen, snapshot]);

  /* ---- 订阅任务事件（进度 / 终态） ---- */
  useEffect(() => {
    if (taskId === null) return undefined;
    const api = window.laipian;
    if (!api) return undefined;
    let alive = true;
    const unsubscribe = api.tasks.subscribe((event) => {
      if (!alive || event.taskId !== taskId) return;
      if (event.progress?.kind === 'step') setStep(event.progress.step);
      if (event.status === 'succeeded') {
        setStatus('done');
        setMessage(null);
        void api.exports.products({ taskId }).then((res) => {
          if (alive && res.ok) setProducts(res.data);
        });
      } else if (event.status === 'failed') {
        setStatus('error');
        setMessage(event.message ?? '导出失败。');
      } else if (event.status === 'cancelled') {
        setStatus('cancelled');
        setMessage('导出已取消。');
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [taskId]);

  const runExport = useCallback(async () => {
    const api = window.laipian;
    if (!api) {
      setStatus('error');
      setMessage('浏览器预览模式不支持导出（需要桌面运行环境）。');
      return;
    }
    setStatus('running');
    setMessage(null);
    setStep('准备导出');
    setProducts([]);
    // 规格 13.2：导出前先等待项目保存完成，保证内容与当前一致。
    await Promise.resolve(onSaveRequested?.());
    const result = await api.exports.start(activeRequest);
    if (!result.ok) {
      setStatus('error');
      setMessage(`导出失败：${result.error.message}`);
      return;
    }
    if (result.data === null) {
      setStatus('idle');
      setMessage('已取消导出。');
      return;
    }
    setTaskId(result.data.taskId);
  }, [activeRequest, onSaveRequested]);

  const cancelExport = useCallback(() => {
    const api = window.laipian;
    if (api && taskId !== null) {
      void api.tasks.cancel({ taskId });
    }
  }, [taskId]);

  const openProduct = useCallback((product: ExportProduct) => {
    void window.laipian?.exports.open({ path: product.path });
  }, []);

  const revealProduct = useCallback((product: ExportProduct) => {
    void window.laipian?.exports.reveal({ path: product.path });
  }, []);

  const saveTemplate = useCallback(async () => {
    const api = window.laipian;
    const name = templateName.trim();
    if (!api || name.length === 0) return;
    const current = await api.settings.get();
    if (!current.ok) return;
    const tpl = toTemplate(activeRequest, name, `tpl-${Date.now()}`);
    const next = [...(current.data.exportTemplates ?? []).filter((t) => t.name !== name), tpl];
    const written = await api.settings.set({
      settings: { keymap: current.data.keymap, exportTemplates: next },
    });
    if (written.ok) {
      setTemplates(written.data.exportTemplates ?? next);
      setTemplateName('');
    }
  }, [templateName, activeRequest]);

  const removeTemplate = useCallback(async (id: string) => {
    const api = window.laipian;
    if (!api) return;
    const current = await api.settings.get();
    if (!current.ok) return;
    const next = (current.data.exportTemplates ?? []).filter((t) => t.id !== id);
    const written = await api.settings.set({
      settings: { keymap: current.data.keymap, exportTemplates: next },
    });
    if (written.ok) setTemplates(written.data.exportTemplates ?? next);
  }, []);

  const applySavedTemplate = useCallback(
    (template: ExportTemplate) => {
      const request = applyTemplate(activeRequest, template);
      setShowCustom(true);
      setCustom({
        kinds: request.kinds,
        scopeKind: request.scope.kind,
        timeStartMs: custom.timeStartMs,
        timeEndMs: custom.timeEndMs,
        modules: request.modules,
        frames: request.frames,
        table: request.table,
        layout: request.layout,
        zip: request.zip,
      });
    },
    [activeRequest, custom.timeStartMs, custom.timeEndMs],
  );

  const toggleKind = useCallback((kind: ExportKind) => {
    setCustom((prev) => {
      const has = prev.kinds.includes(kind);
      const kinds = has ? prev.kinds.filter((k) => k !== kind) : [...prev.kinds, kind];
      return { ...prev, kinds, zip: kinds.length > 1 ? prev.zip : false };
    });
  }, []);

  const toggleModule = useCallback((module: ExportModuleId) => {
    setCustom((prev) => {
      const has = prev.modules.includes(module);
      return {
        ...prev,
        modules: has ? prev.modules.filter((m) => m !== module) : [...prev.modules, module],
      };
    });
  }, []);

  const moveField = useCallback((from: number, to: number) => {
    setCustom((prev) => {
      const fields = [...prev.table.fields];
      const [moved] = fields.splice(from, 1);
      if (moved === undefined) return prev;
      fields.splice(to, 0, moved);
      return { ...prev, table: { fields } };
    });
  }, []);

  const toggleField = useCallback((field: ExportFieldId) => {
    setCustom((prev) => {
      const has = prev.table.fields.includes(field);
      return {
        ...prev,
        table: {
          fields: has
            ? prev.table.fields.filter((f) => f !== field)
            : [...prev.table.fields, field],
        },
      };
    });
  }, []);

  if (!isOpen) return null;

  const availableFields: ExportFieldId[] = DEFAULT_TABLE_FIELDS;

  /* ---- 运行中视图 ---- */
  if (status === 'running') {
    return (
      <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) cancelExport(); }}>
        <div className="dialog lp-export-dialog" role="dialog" aria-modal="true" aria-label="导出进度">
          <h2 className="lp-export-title">正在导出</h2>
          <p className="lp-export-progress-step">{step}</p>
          <div className="lp-export-progress-track"><div className="lp-export-progress-bar" /></div>
          <p className="lp-export-hint">导出在本地完成，不上传视频或画面。可随时取消。</p>
          <div className="dialog-actions">
            <button type="button" className="dialog-button-secondary" onClick={cancelExport}>取消</button>
          </div>
        </div>
      </div>
    );
  }

  /* ---- 完成视图 ---- */
  if (status === 'done') {
    return (
      <div className="dialog-backdrop">
        <div className="dialog lp-export-dialog" role="dialog" aria-modal="true" aria-label="导出完成">
          <h2 className="lp-export-title">导出完成</h2>
          {products.length === 0 ? (
            <p className="lp-export-hint">已生成导出文件。</p>
          ) : (
            <ul className="lp-export-products">
              {products.map((product) => (
                <li key={product.path} className="lp-export-product">
                  <Icon name={product.kind === 'pdf' ? 'file-pdf' : product.kind === 'xlsx' ? 'file-xlsx' : product.kind === 'png' ? 'file-png' : product.kind === 'json' ? 'file-json' : 'file-markdown'} size={16} />
                  <div className="lp-export-product-info">
                    <span className="lp-export-product-name">{product.path.split(/[\\/]/).pop() ?? product.path}</span>
                    <span className="lp-export-product-meta">{EXPORT_KIND_LABEL[product.kind]} · {formatBytes(product.sizeBytes)}</span>
                  </div>
                  <button type="button" className="lp-export-product-action" onClick={() => openProduct(product)}>打开文件</button>
                  <button type="button" className="lp-export-product-action" onClick={() => revealProduct(product)}>{PLATFORM.revealLabel}</button>
                </li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            <button type="button" className="dialog-button-secondary" onClick={() => { setStatus('idle'); setProducts([]); }}>再导出一次</button>
            <button type="button" className="dialog-button-primary" onClick={onClose}>完成</button>
          </div>
        </div>
      </div>
    );
  }

  /* ---- 配置视图（标准 + 专业自定义） ---- */
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog lp-export-dialog" role="dialog" aria-modal="true" aria-label="导出">
        <header className="lp-export-header">
          <h2 className="lp-export-title">导出</h2>
          <button type="button" className="lp-export-close" onClick={onClose} aria-label="关闭">✕</button>
        </header>

        {!showCustom && (
          <div className="lp-export-standard">
            <p className="lp-export-lead">选择一种用途，其他设置已用合理默认值。</p>
            <div className="lp-export-choices">
              <button
                type="button"
                className={`lp-export-choice${standardKind === 'pdf' ? ' is-active' : ''}`}
                onClick={() => setStandardKind('pdf')}
              >
                <Icon name="file-pdf" size={22} />
                <span className="lp-export-choice-title">阅读与分享</span>
                <span className="lp-export-choice-desc">PDF 报告：项目信息、节奏曲线、章-节-镜头结构、代表画面、时间码、标注与备注，可直接阅读、发送、打印。</span>
              </button>
              <button
                type="button"
                className={`lp-export-choice${standardKind === 'xlsx' ? ' is-active' : ''}`}
                onClick={() => setStandardKind('xlsx')}
              >
                <Icon name="file-xlsx" size={22} />
                <span className="lp-export-choice-title">继续整理</span>
                <span className="lp-export-choice-desc">Excel 表格：分镜拉片表（每镜头一行并内嵌画面）、曲线节点、标注列表、结构大纲，可继续编辑整理。</span>
              </button>
            </div>

            <div className="lp-export-field">
              <span className="lp-export-field-label">导出范围</span>
              <div className="lp-export-radio-row">
                <label className="lp-export-radio">
                  <input type="radio" name="std-scope" checked={standardScope === 'project'} onChange={() => setStandardScope('project')} />
                  整个项目
                </label>
                <label className={`lp-export-radio${currentSectionId === null ? ' is-disabled' : ''}`}>
                  <input type="radio" name="std-scope" disabled={currentSectionId === null} checked={standardScope === 'section'} onChange={() => setStandardScope('section')} />
                  当前选中段落{currentSectionId === null ? '（未选中）' : ''}
                </label>
              </div>
            </div>
          </div>
        )}

        {showCustom && (
          <div className="lp-export-custom">
            {/* 范围 */}
            <section className="lp-export-section">
              <h3>导出范围</h3>
              <div className="lp-export-radio-row">
                {(['project', 'chapter', 'section', 'shots', 'timeRange'] as const).map((kind) => {
                  const disabled =
                    (kind === 'chapter' && currentChapterId === null) ||
                    (kind === 'section' && currentSectionId === null) ||
                    (kind === 'shots' && currentShotId === null);
                  return (
                    <label key={kind} className={`lp-export-radio${disabled ? ' is-disabled' : ''}`}>
                      <input type="radio" name="cust-scope" disabled={disabled} checked={custom.scopeKind === kind} onChange={() => setCustom((p) => ({ ...p, scopeKind: kind }))} />
                      {EXPORT_SCOPE_LABEL[kind]}
                    </label>
                  );
                })}
              </div>
              {custom.scopeKind === 'timeRange' && (
                <div className="lp-export-time-range">
                  <label>开始（秒）<input type="number" min={0} step={0.1} value={(custom.timeStartMs / 1000).toFixed(1)} onChange={(e) => setCustom((p) => ({ ...p, timeStartMs: Math.max(0, Number(e.target.value) * 1000) }))} /></label>
                  <label>结束（秒）<input type="number" min={0} step={0.1} value={(custom.timeEndMs / 1000).toFixed(1)} onChange={(e) => setCustom((p) => ({ ...p, timeEndMs: Math.max(0, Number(e.target.value) * 1000) }))} /></label>
                </div>
              )}
            </section>

            {/* 内容模块 */}
            <section className="lp-export-section">
              <h3>内容模块</h3>
              <div className="lp-export-chips">
                {EXPORT_MODULE_DEFS.map((module) => (
                  <label key={module.id} className={`lp-export-chip${custom.modules.includes(module.id) ? ' is-on' : ''}`} title={module.hint}>
                    <input type="checkbox" checked={custom.modules.includes(module.id)} onChange={() => toggleModule(module.id)} />
                    {module.label}
                  </label>
                ))}
              </div>
            </section>

            {/* 画面设置 */}
            <section className="lp-export-section">
              <h3>画面设置</h3>
              <label className="lp-export-check"><input type="checkbox" checked={custom.frames.includeShotFrame} onChange={(e) => setCustom((p) => ({ ...p, frames: { ...p.frames, includeShotFrame: e.target.checked } }))} />每个镜头一张代表画面</label>
              <label className="lp-export-check"><input type="checkbox" checked={custom.frames.includeCurveNodeFrames} onChange={(e) => setCustom((p) => ({ ...p, frames: { ...p.frames, includeCurveNodeFrames: e.target.checked } }))} />曲线节点对应画面</label>
              <label className="lp-export-check"><input type="checkbox" checked={custom.frames.includeAnnotationFrames} onChange={(e) => setCustom((p) => ({ ...p, frames: { ...p.frames, includeAnnotationFrames: e.target.checked } }))} />标注时间点画面</label>
              <div className="lp-export-inline">
                <label>取样位置
                  <select value={custom.frames.framePosition} onChange={(e) => setCustom((p) => ({ ...p, frames: { ...p.frames, framePosition: e.target.value as ExportFrameSettings['framePosition'] } }))}>
                    <option value="middle">中间帧</option>
                    <option value="first">首帧</option>
                    <option value="last">尾帧</option>
                    <option value="cover">封面帧</option>
                  </select>
                </label>
                <label>质量
                  <select value={custom.frames.quality} onChange={(e) => setCustom((p) => ({ ...p, frames: { ...p.frames, quality: e.target.value as ExportFrameSettings['quality'] } }))}>
                    <option value="standard">标准</option>
                    <option value="high">高清</option>
                    <option value="max">最高（源分辨率）</option>
                  </select>
                </label>
                <label>最大宽度
                  <input type="number" min={0} max={snapshot.media.width} step={80} value={custom.frames.maxWidth} onChange={(e) => setCustom((p) => ({ ...p, frames: { ...p.frames, maxWidth: Math.max(0, Math.min(snapshot.media.width, Number(e.target.value))) } }))} title={`不超过源视频宽度 ${snapshot.media.width}px；0 表示跟随质量档`} />
                </label>
              </div>
              <p className="lp-export-hint">代表画面会避开硬切瞬间；个别画面提取失败不会导致整份导出失败。</p>
            </section>

            {/* 表格字段（可拖拽排序） */}
            <section className="lp-export-section">
              <h3>表格字段（拖拽调整顺序）</h3>
              <ul className="lp-export-fields">
                {custom.table.fields.map((field, index) => (
                  <li
                    key={field}
                    className={`lp-export-field-item${dragIndex === index ? ' is-dragging' : ''}`}
                    draggable
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => { if (dragIndex !== null && dragIndex !== index) moveField(dragIndex, index); setDragIndex(null); }}
                    onDragEnd={() => setDragIndex(null)}
                  >
                    <span className="lp-export-drag">⠿</span>
                    <span className="lp-export-field-name">{EXPORT_FIELD_LABEL[field]}</span>
                    <button type="button" className="lp-export-field-remove" onClick={() => toggleField(field)} aria-label={`移除 ${EXPORT_FIELD_LABEL[field]}`}>移除</button>
                  </li>
                ))}
              </ul>
              <div className="lp-export-chips">
                {availableFields.filter((f) => !custom.table.fields.includes(f)).map((field) => (
                  <button key={field} type="button" className="lp-export-chip" onClick={() => toggleField(field)}>＋ {EXPORT_FIELD_LABEL[field]}</button>
                ))}
              </div>
            </section>

            {/* 排版 */}
            <section className="lp-export-section">
              <h3>排版方式</h3>
              <div className="lp-export-inline">
                <label>样式
                  <select value={custom.layout.template} onChange={(e) => setCustom((p) => ({ ...p, layout: { ...p.layout, template: e.target.value as ExportLayoutSettings['template'] } }))}>
                    <option value="table">标准表格式</option>
                    <option value="gallery">图片展示式</option>
                    <option value="compact">紧凑打印式</option>
                  </select>
                </label>
                <label>方向
                  <select value={custom.layout.orientation} onChange={(e) => setCustom((p) => ({ ...p, layout: { ...p.layout, orientation: e.target.value as ExportLayoutSettings['orientation'] } }))}>
                    <option value="portrait">纵向</option>
                    <option value="landscape">横向</option>
                  </select>
                </label>
              </div>
              <label className="lp-export-check"><input type="checkbox" checked={custom.layout.showHeader} onChange={(e) => setCustom((p) => ({ ...p, layout: { ...p.layout, showHeader: e.target.checked } }))} />显示页眉</label>
              <label className="lp-export-check"><input type="checkbox" checked={custom.layout.showPageNumber} onChange={(e) => setCustom((p) => ({ ...p, layout: { ...p.layout, showPageNumber: e.target.checked } }))} />显示页码</label>
              <label className="lp-export-check"><input type="checkbox" checked={custom.layout.showProjectName} onChange={(e) => setCustom((p) => ({ ...p, layout: { ...p.layout, showProjectName: e.target.checked } }))} />显示项目名称</label>
            </section>

            {/* 输出格式 */}
            <section className="lp-export-section">
              <h3>输出格式</h3>
              <div className="lp-export-chips">
                {EXPORT_KIND_DEFS.map((kind) => (
                  <label key={kind.id} className={`lp-export-chip${custom.kinds.includes(kind.id) ? ' is-on' : ''}`} title={kind.usage}>
                    <input type="checkbox" checked={custom.kinds.includes(kind.id)} onChange={() => toggleKind(kind.id)} />
                    {kind.label}
                    <span className="lp-export-chip-usage">{kind.usage}</span>
                  </label>
                ))}
              </div>
              {custom.kinds.length > 1 && (
                <label className="lp-export-check lp-export-zip">
                  <input type="checkbox" checked={custom.zip} onChange={(e) => setCustom((p) => ({ ...p, zip: e.target.checked }))} />
                  合并为 ZIP 压缩文件（默认逐个保存到所选文件夹）
                </label>
              )}
            </section>

            {/* 模板 */}
            <section className="lp-export-section">
              <h3>个人模板</h3>
              <div className="lp-export-inline">
                <input type="text" placeholder="模板名称" value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
                <button type="button" className="lp-export-chip" onClick={() => void saveTemplate()} disabled={templateName.trim().length === 0}>保存为模板</button>
              </div>
              {templates.length > 0 && (
                <ul className="lp-export-template-list">
                  {templates.map((template) => (
                    <li key={template.id} className="lp-export-template-item">
                      <button type="button" className="lp-export-template-apply" onClick={() => applySavedTemplate(template)}>{template.name}</button>
                      <button type="button" className="lp-export-field-remove" onClick={() => void removeTemplate(template.id)}>删除</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        <div className="lp-export-preview">
          {estimate !== null ? (
            <>
              {estimate.pages > 0 && <span>预计约 {estimate.pages} 页</span>}
              <span>约 {formatBytes(estimate.bytes)}</span>
              <span>含 {estimate.frameCount} 张画面</span>
              <span>{estimate.fileCount} 个文件</span>
            </>
          ) : (
            <span>预览估算不可用</span>
          )}
        </div>

        {message !== null && (
          <p className={`lp-export-message${status === 'error' ? ' is-error' : ''}`} role="status">{message}</p>
        )}

        <div className="dialog-actions lp-export-actions">
          <button type="button" className="lp-export-custom-toggle" onClick={() => setShowCustom((v) => !v)}>
            {showCustom ? '返回标准导出' : '专业自定义'}
          </button>
          <span className="lp-export-actions-spacer" />
          <button type="button" className="dialog-button-secondary" onClick={onClose}>取消</button>
          <button type="button" className="dialog-button-primary" disabled={!hasApi} onClick={() => void runExport()} data-tip={hasApi ? undefined : '浏览器预览模式不支持导出'}>
            <Icon name="export" size={16} />
            导出
          </button>
        </div>
      </div>
    </div>
  );
}