import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Annotation, Curve, StructureNode } from '@shared/api-types';
import { formatTimeMs } from '@shared/time';
import { createCurveEvaluator } from '@shared/geometry';
import {
  ancestorsOf,
  buildNumbering,
  childrenOf,
  deriveRanges,
  findNode,
  formatNumber,
  levelLabel,
  NARRATIVE_ROLES,
  updateStructureNode,
} from '@shared/structure';
import {
  Icon,
  IconChevronDown,
  IconChevronRight,
  IconLock,
  IconSplit,
} from './Icons';

/**
 * 结构大纲 + 结构检查器（规格 4.2 / 4.3 / 5）。
 *
 * 以 snapshot.structure 为唯一真值（三级：章节/段落/镜头）。
 * 所有编辑通过 onCommit({ structure }) 提交，自动进入撤销历史与保存。
 */

export interface StructurePanelProps {
  structure: readonly StructureNode[];
  durationMs: number;
  annotations: readonly Annotation[];
  curve: Curve;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onCommit(patch: { structure: StructureNode[] }, coalesceKey?: string): void;
  onSplit(id: string): void;
  onMerge(id: string): void;
  onCoverAtPlayhead(id: string): void;
  onNotice(message: string): void;
  onSeek(timeMs: number): void;
  /** 对选中章节/段落运行“智能分镜此段”（局部硬切识别）。 */
  onRunShotDetect?(id: string): void;
  /** 是否正在识别中（禁用按钮并显示状态）。 */
  shotRunning?: boolean;
}

interface CurveStat {
  average: number;
  min: number;
  max: number;
}

function sampleCurveStats(curve: Curve, startMs: number, endMs: number): CurveStat {
  const evaluator = createCurveEvaluator(curve.nodes);
  const span = Math.max(0, endMs - startMs);
  const step = Math.max(1, Math.floor(span / 200) || 1);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let count = 0;
  for (let t = startMs; t <= endMs; t += step) {
    const value = evaluator.at(t);
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
    count += 1;
  }
  if (count === 0) {
    const value = evaluator.at(startMs);
    return { average: value, min: value, max: value };
  }
  return { average: sum / count, min, max };
}

/** 段落「曲线印记」微型折线尺寸（方案 §3 小特色）。 */
const SPARK_WIDTH = 44;
const SPARK_HEIGHT = 14;

/**
 * 段落「曲线印记」：把该段落范围内的曲线采样为一条微型折线。
 * 直接取自用户画出的曲线，无需新增分析；用于在大纲中快速辨认某段的节奏起伏。
 */
function curveSparklinePoints(curve: Curve, startMs: number, endMs: number): string {
  const evaluator = createCurveEvaluator(curve.nodes);
  const span = endMs - startMs;
  if (!(span > 0)) {
    const y = SPARK_HEIGHT / 2;
    return `0,${y} ${SPARK_WIDTH},${y}`;
  }
  const samples = 18;
  const points: string[] = [];
  for (let i = 0; i < samples; i++) {
    const t = startMs + (span * i) / (samples - 1);
    const value = Math.max(0, Math.min(100, evaluator.at(t)));
    const x = (i / (samples - 1)) * SPARK_WIDTH;
    const y = SPARK_HEIGHT - (value / 100) * SPARK_HEIGHT;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return points.join(' ');
}

function countAnnotations(
  annotations: readonly Annotation[],
  startMs: number,
  endMs: number,
): number {
  return annotations.filter((a) => a.timeMs >= startMs && a.timeMs < endMs).length;
}

/** 名称/标签/备注是否命中搜索。 */
function matchesQuery(node: StructureNode, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  return (
    node.name.toLowerCase().includes(query) ||
    node.note.toLowerCase().includes(query) ||
    node.tags.some((tag) => tag.toLowerCase().includes(query))
  );
}

export function StructurePanel({
  structure,
  durationMs,
  annotations,
  curve,
  selectedId,
  onSelect,
  onCommit,
  onSplit,
  onMerge,
  onCoverAtPlayhead,
  onNotice,
  onSeek,
  onRunShotDetect,
  shotRunning = false,
}: StructurePanelProps) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);

  const numbering = useMemo(() => buildNumbering(structure), [structure]);
  const ranges = useMemo(() => deriveRanges(structure, durationMs), [structure, durationMs]);

  const keyword = query.trim().toLowerCase();
  // 命中集合 + 其祖先（搜索时保持命中路径可见）。
  const visibleIds = useMemo(() => {
    if (keyword.length === 0) {
      return null;
    }
    const ids = new Set<string>();
    for (const node of structure) {
      if (matchesQuery(node, keyword)) {
        ids.add(node.id);
        for (const parent of ancestorsOf(structure, node.id)) {
          ids.add(parent.id);
        }
      }
    }
    return ids;
  }, [structure, keyword]);

  const selected = selectedId !== null ? findNode(structure, selectedId) ?? null : null;


  const commitNode = (id: string, patch: Parameters<typeof updateStructureNode>[2], coalesceKey?: string): void => {
    const result = updateStructureNode(structure, id, patch);
    if (!result.ok) {
      onNotice(result.message ?? '无法修改该结构。');
      return;
    }
    onCommit({ structure: result.structure }, coalesceKey);
  };

  const renderNode = (node: StructureNode, depth: number): ReactNode[] => {
    if (visibleIds !== null && !visibleIds.has(node.id)) {
      return [];
    }
    const range = ranges.get(node.id) ?? { startMs: node.startMs, endMs: node.startMs };
    const childLevel = node.level === 'chapter' ? 'section' : node.level === 'section' ? 'shot' : null;
    const children = childLevel !== null ? childrenOf(structure, node.id, childLevel) : [];
    const isCollapsed = collapsed.has(node.id) && keyword.length === 0;
    const isSelected = selectedId === node.id;
    const number = numbering.get(node.id);
    const rows: ReactNode[] = [];
    rows.push(
      <div
        key={node.id}
        className={`lp-structure-row is-${node.level}${isSelected ? ' is-selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={children.length > 0 ? !isCollapsed : undefined}
      >
        {children.length > 0 ? (
          <button
            type="button"
            className="lp-structure-twisty"
            aria-label={isCollapsed ? '展开' : '折叠'}
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(node.id)) {
                  next.delete(node.id);
                } else {
                  next.add(node.id);
                }
                return next;
              });
            }}
          >
            {isCollapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
          </button>
        ) : (
          <span className="lp-structure-twisty is-empty" aria-hidden="true" />
        )}
        {renaming === node.id ? (
          <input
            className="lp-structure-rename"
            autoFocus
            defaultValue={node.name}
            onBlur={(e) => {
              commitNode(node.id, { name: e.target.value }, `structure-name-${node.id}`);
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                setRenaming(null);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <button
            type="button"
            className="lp-structure-label"
            title={`${levelLabel(node.level)} · ${formatTimeMs(range.startMs)} — ${formatTimeMs(range.endMs)}`}
            onClick={() => {
              onSelect(node.id);
              onSeek(range.startMs);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenaming(node.id);
            }}
          >
            <span className="lp-structure-no">{number !== undefined ? formatNumber(number) : ''}</span>
            <span className="lp-structure-name">{node.name || `（未命名${levelLabel(node.level)}）`}</span>
            {node.level === 'section' && (
              <span className="lp-structure-spark" aria-hidden="true">
                <svg
                  width={SPARK_WIDTH}
                  height={SPARK_HEIGHT}
                  viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
                  preserveAspectRatio="none"
                >
                  <polyline
                    className="lp-spark-line"
                    points={curveSparklinePoints(curve, range.startMs, range.endMs)}
                  />
                </svg>
              </span>
            )}
            {node.locked && <IconLock className="lp-structure-lock" aria-label="已锁定" />}
            <span className="lp-structure-time">{formatTimeMs(range.startMs)}</span>
          </button>
        )}
      </div>,
    );
    if (!isCollapsed) {
      for (const child of children) {
        rows.push(...renderNode(child, depth + 1));
      }
    }
    return rows;
  };

  const chapters = childrenOf(structure, null, 'chapter');
  const selectedRange = selected !== null ? ranges.get(selected.id) : undefined;
  const selectedChildren =
    selected === null || selected.level === 'shot'
      ? 0
      : childrenOf(structure, selected.id, selected.level === 'chapter' ? 'section' : 'shot').length;
  const roleIsPreset = selected !== null && (NARRATIVE_ROLES as readonly string[]).includes(selected.narrativeRole);
  const selectedAnnotations =
    selectedRange !== undefined ? countAnnotations(annotations, selectedRange.startMs, selectedRange.endMs) : 0;
  const stats =
    selectedRange !== undefined ? sampleCurveStats(curve, selectedRange.startMs, selectedRange.endMs) : null;

  return (
    <div className="lp-structure-panel">
      <div className="lp-structure-outline" role="tree" aria-label="结构大纲">
        <div className="lp-structure-search">
          <input
            type="search"
            className="lp-structure-search-input"
            placeholder="搜索名称 / 标签 / 备注"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索结构"
          />
        </div>
        {chapters.length === 0 ? (
          <p className="lp-props-empty">没有结构数据。</p>
        ) : (
          chapters.flatMap((chapter) => renderNode(chapter, 0))
        )}
      </div>

      {selected === null || selectedRange === undefined ? (
        <div className="lp-structure-inspector">
          <p className="lp-props-empty">在结构大纲或时间线中选择章节 / 段落 / 镜头。</p>
        </div>
      ) : (
        <div className="lp-structure-inspector">
          <div className="lp-structure-breadcrumb">
            {ancestorsOf(structure, selected.id)
              .reverse()
              .map((parent) => (
                <span key={parent.id}>
                  <button type="button" className="lp-structure-crumb" onClick={() => onSelect(parent.id)}>
                    {parent.name}
                  </button>
                  <span className="lp-structure-crumb-sep">/</span>
                </span>
              ))}
            <span className="lp-structure-crumb is-current">{selected.name}</span>
          </div>

          <p className="lp-structure-heading">
            {levelLabel(selected.level)}
            {numbering.get(selected.id) !== undefined
              ? ` ${formatNumber(numbering.get(selected.id)!)}`
              : ''}
            {' · '}
            {formatTimeMs(selectedRange.startMs)} — {formatTimeMs(selectedRange.endMs)}
            {' · '}
            时长 {formatTimeMs(selectedRange.endMs - selectedRange.startMs)}
          </p>

          <label className="lp-field">
            <span className="lp-field-label">名称</span>
            <input
              className="lp-field-input"
              value={selected.name}
              onChange={(e) => commitNode(selected.id, { name: e.target.value }, `structure-name-${selected.id}`)}
            />
          </label>

          <div className="lp-structure-meta">
            <span>父级：{ancestorsOf(structure, selected.id)[0]?.name ?? '（顶层）'}</span>
            <span>包含{selected.level === 'shot' ? '标注' : '子级'}：{selectedChildren}</span>
            <span>标注数：{selectedAnnotations}</span>
          </div>

          {stats !== null && (
            <div className="lp-structure-meta">
              <span>曲线 平均 {stats.average.toFixed(0)}</span>
              <span>最高 {stats.max.toFixed(0)}</span>
              <span>最低 {stats.min.toFixed(0)}</span>
            </div>
          )}

          <label className="lp-field">
            <span className="lp-field-label">叙事作用</span>
            <select
              className="lp-field-input"
              value={roleIsPreset ? selected.narrativeRole : selected.narrativeRole.length > 0 ? '自定义' : ''}
              onChange={(e) => {
                const value = e.target.value;
                commitNode(selected.id, { narrativeRole: value === '自定义' ? '' : value });
              }}
            >
              <option value="">（未设置）</option>
              {NARRATIVE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>

          {selected.narrativeRole.length > 0 && !roleIsPreset && (
            <label className="lp-field">
              <span className="lp-field-label">自定义作用</span>
              <input
                className="lp-field-input"
                value={selected.narrativeRole}
                onChange={(e) => commitNode(selected.id, { narrativeRole: e.target.value }, `structure-role-${selected.id}`)}
              />
            </label>
          )}

          <label className="lp-field">
            <span className="lp-field-label">标签</span>
            <input
              className="lp-field-input"
              value={selected.tags.join(', ')}
              placeholder="用逗号分隔"
              onChange={(e) =>
                commitNode(
                  selected.id,
                  { tags: e.target.value.split(',').map((t) => t.trim()).filter((t) => t.length > 0) },
                  `structure-tags-${selected.id}`,
                )
              }
            />
          </label>

          <label className="lp-field">
            <span className="lp-field-label">备注</span>
            <textarea
              className="lp-field-textarea"
              value={selected.note}
              rows={3}
              onChange={(e) => commitNode(selected.id, { note: e.target.value }, `structure-note-${selected.id}`)}
            />
          </label>

          <label className="lp-field">
            <span className="lp-field-label">代表帧</span>
            <span className="lp-structure-meta">
              <span>
                {selected.coverTimeMs !== null ? formatTimeMs(selected.coverTimeMs) : '按镜头中点自动推导'}
              </span>
              <button
                type="button"
                className="lp-section-button"
                onClick={() => onCoverAtPlayhead(selected.id)}
              >
                <Icon name="playhead" />
                <span>用当前播放头</span>
              </button>
              {selected.coverTimeMs !== null && (
                <button
                  type="button"
                  className="lp-section-button"
                  onClick={() => commitNode(selected.id, { coverTimeMs: null })}
                >
                  <Icon name="trash" />
                  <span>清除</span>
                </button>
              )}
            </span>
          </label>

          <label className="lp-field-inline">
            <input
              type="checkbox"
              checked={selected.locked}
              onChange={(e) => commitNode(selected.id, { locked: e.target.checked })}
            />
            锁定（禁止改变时间与父级）
          </label>

          <div className="lp-structure-actions">
            <button type="button" className="lp-section-button" onClick={() => onSplit(selected.id)}>
              <IconSplit />
              <span>在播放头拆分</span>
            </button>
            <button type="button" className="lp-section-button" onClick={() => onMerge(selected.id)}>
              <Icon name="merge-left" />
              <span>合并到左侧</span>
            </button>
            <button type="button" className="lp-section-button" onClick={() => onSeek(selectedRange.startMs)}>
              <Icon name="arrow-right" />
              <span>跳转</span>
            </button>
          </div>

          {onRunShotDetect !== undefined && selected.level !== 'shot' && (
            <div className="lp-structure-actions lp-structure-actions--shot">
              <button
                type="button"
                className="lp-section-button is-primary"
                disabled={shotRunning}
                title={
                  shotRunning
                    ? '正在识别中…'
                    : `只分析「${selected.name || levelLabel(selected.level)}」范围，生成镜头 1、镜头 2…`
                }
                onClick={() => onRunShotDetect(selected.id)}
              >
                {shotRunning ? (
                  <>
                    <Icon name="smart-shot" />
                    <span>正在识别…</span>
                  </>
                ) : (
                  <>
                    <Icon name="detect-range" />
                    <span>智能分镜此段</span>
                  </>
                )}
              </button>
              <span className="lp-structure-shot-target">
                {selected.name || levelLabel(selected.level)} · {formatTimeMs(selectedRange.startMs)} —{' '}
                {formatTimeMs(selectedRange.endMs)}
              </span>
            </div>
          )}
          {onRunShotDetect !== undefined && selected.level === 'shot' && (
            <p className="lp-props-hint">
              当前选中的是单个镜头；如需在镜头内部重新分镜，请先选择所属段落或章节。
            </p>
          )}
        </div>
      )}
    </div>
  );
}