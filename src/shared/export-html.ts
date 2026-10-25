import type { ExportDocument, ExportCurvePoint, ExportShotRow } from './export-document';
import { EXPORT_FIELD_LABEL } from './export-config';
import type { ExportFieldId } from './api-types';
import { formatTimeMs } from './time';

/**
 * PDF 报告 / PNG 节奏谱的 HTML 生成（规格 13 重设计）。
 *
 * - 本文件只产出 HTML 字符串（含内联 SVG 曲线与内联帧图 data URL），
 *   真正的"HTML → PDF"由 main 用隐藏 BrowserWindow + printToPDF 完成，
 *   "HTML → PNG 节奏谱"由隐藏窗口 capturePage 完成；
 * - 纯字符串函数，无 DOM / Node / Electron 依赖，vitest 直接覆盖；
 * - 所有用户文本转义，避免破坏结构；
 * - 页眉/页码由 printToPDF 的模板负责，本文件只渲染正文。
 */

const FONT_STACK =
  '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

export interface ExportHtmlOptions {
  /** 生成时间（ISO）；省略则不显示。 */
  generatedAt?: string;
  /** 帧图映射：key（shot:<id> / curveNode:<timeMs> / annotation:<id>）→ data URL。 */
  images?: Record<string, string>;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function multiline(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br/>');
}

/* ------------------------------------------------------------------ */
/* 曲线 SVG                                                             */
/* ------------------------------------------------------------------ */

const PLOT_LEFT = 44;
const PLOT_RIGHT = 20;
const PLOT_TOP = 24;
const PLOT_BOTTOM = 30;

/** 坐标投影上下文：供节奏谱叠加章节分界与标注点，保证与曲线同一坐标系。 */
export interface CurvePlotContext {
  xOf(timeMs: number): number;
  yOf(value: number): number;
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
  width: number;
  height: number;
}

/** 把曲线采样点渲染为内联 SVG（横轴严格对应时间范围）。 */
export function buildCurveSvg(
  points: ExportCurvePoint[],
  range: { startMs: number; endMs: number },
  options: {
    width?: number;
    height?: number;
    color?: string;
    /** 额外叠加层（章节线/标注点等），与曲线共用同一坐标系。 */
    overlay?: (ctx: CurvePlotContext) => string;
  } = {},
): string {
  const width = options.width ?? 760;
  const height = options.height ?? 240;
  const color = options.color ?? '#E5484D';
  const plotW = Math.max(1, width - PLOT_LEFT - PLOT_RIGHT);
  const plotH = Math.max(1, height - PLOT_TOP - PLOT_BOTTOM);
  const span = Math.max(1, range.endMs - range.startMs);
  const xOf = (t: number): number => PLOT_LEFT + ((t - range.startMs) / span) * plotW;
  const yOf = (v: number): number => PLOT_TOP + (1 - Math.min(100, Math.max(0, v)) / 100) * plotH;

  const gridLines = [0, 25, 50, 75, 100]
    .map((v) => {
      const y = yOf(v);
      return `<line x1="${PLOT_LEFT}" y1="${y.toFixed(1)}" x2="${(PLOT_LEFT + plotW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#E2E5EC" stroke-width="1"/>`;
    })
    .join('');

  const path =
    points.length > 0
      ? points
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.timeMs).toFixed(1)},${yOf(p.value).toFixed(1)}`)
          .join(' ')
      : '';

  const tickCount = 6;
  const ticks = Array.from({ length: tickCount + 1 }, (_v, i) => {
    const t = range.startMs + (span * i) / tickCount;
    const x = xOf(t);
    return `<line x1="${x.toFixed(1)}" y1="${PLOT_TOP + plotH}" x2="${x.toFixed(1)}" y2="${(PLOT_TOP + plotH + 5).toFixed(1)}" stroke="#B9BFCB" stroke-width="1"/><text x="${x.toFixed(1)}" y="${height - 8}" font-size="10" fill="#7A8091" text-anchor="middle">${escapeHtml(formatTimeMs(t))}</text>`;
  }).join('');

  return `<svg class="lp-curve-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${PLOT_LEFT}" y="${PLOT_TOP}" width="${plotW}" height="${plotH}" fill="#FAFBFC" stroke="#E2E5EC"/>
  ${gridLines}
  ${options.overlay !== undefined ? options.overlay({ xOf, yOf, plotLeft: PLOT_LEFT, plotTop: PLOT_TOP, plotWidth: plotW, plotHeight: plotH, width, height }) : ''}
  ${path.length > 0 ? `<path d="${path}" fill="none" stroke="${escapeHtml(color)}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
  ${ticks}
  <text x="8" y="${PLOT_TOP + 10}" font-size="10" fill="#7A8091">高</text>
  <text x="8" y="${PLOT_TOP + plotH}" font-size="10" fill="#7A8091">低</text>
</svg>`;
}

/* ------------------------------------------------------------------ */
/* 片段渲染                                                             */
/* ------------------------------------------------------------------ */

function frameImg(images: Record<string, string>, key: string, width: number, alt: string): string {
  const src = images[key];
  if (src === undefined || src.length === 0) {
    return `<span class="lp-frame-missing" style="width:${width}px">画面不可用</span>`;
  }
  return `<img class="lp-frame" style="width:${width}px" src="${src}" alt="${escapeHtml(alt)}"/>`;
}

function cellValue(row: ExportShotRow, field: ExportFieldId, images: Record<string, string>, imgWidth: number): string {
  switch (field) {
    case 'index':
      return String(row.index);
    case 'frame':
      return frameImg(images, `shot:${row.shotId}`, imgWidth, row.shotName);
    case 'chapterName':
      return escapeHtml(row.chapterName);
    case 'sectionName':
      return escapeHtml(row.sectionName);
    case 'shotName':
      return escapeHtml(row.shotName);
    case 'startTime':
      return escapeHtml(formatTimeMs(row.startMs));
    case 'endTime':
      return escapeHtml(formatTimeMs(row.endMs));
    case 'duration':
      return escapeHtml(formatTimeMs(row.durationMs, { hours: 'auto' }));
    case 'curveStart':
      return row.curveStart.toFixed(0);
    case 'curvePeak':
      return row.curvePeak.toFixed(0);
    case 'curveEnd':
      return row.curveEnd.toFixed(0);
    case 'annotationSummary':
      return multiline(row.annotationSummary);
    case 'note':
      return multiline(row.note);
    default:
      return '';
  }
}

function renderProjectInfo(doc: ExportDocument): string {
  const info = doc.info;
  const rows: [string, string][] = [
    ['项目名称', info.name],
    ['源文件', info.originalName],
    ['视频时长', formatTimeMs(info.durationMs, { hours: 'always' })],
    ['分辨率', `${info.width} × ${info.height}`],
    ['视频 / 音频编码', `${info.videoCodec} / ${info.audioCodec ?? '无音轨'}`],
    ['帧率', info.frameRateLabel],
    ['文件大小', `${(info.sizeBytes / (1024 * 1024)).toFixed(1)} MB`],
    ['曲线维度', info.curveName],
    ['导出范围', doc.range.label],
  ];
  return `<section class="lp-section">
    <h2>项目信息</h2>
    <table class="lp-kv"><tbody>${rows
      .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
      .join('')}</tbody></table>
  </section>`;
}

function renderStatistics(doc: ExportDocument): string {
  const s = doc.statistics;
  const cells: [string, string][] = [
    ['章节数', String(s.chapterCount)],
    ['段落数', String(s.sectionCount)],
    ['镜头数', String(s.shotCount)],
    ['标注数', String(s.annotationCount)],
    ['曲线节点数', String(s.curveNodeCount)],
    ['范围内时长', formatTimeMs(s.rangeDurationMs, { hours: 'always' })],
    ['平均镜头时长', formatTimeMs(s.avgShotMs, { hours: 'auto' })],
    ['最短镜头', formatTimeMs(s.minShotMs, { hours: 'auto' })],
    ['最长镜头', formatTimeMs(s.maxShotMs, { hours: 'auto' })],
    ['镜头密度', `${s.shotDensityPerMin.toFixed(1)} 个/分`],
    ['曲线峰值', String(s.peakValue)],
    ['曲线低值', String(s.minValue)],
  ];
  return `<section class="lp-section">
    <h2>统计数据</h2>
    <table class="lp-kv"><tbody>${cells
      .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
      .join('')}</tbody></table>
  </section>`;
}

function renderRhythm(doc: ExportDocument): string {
  return `<section class="lp-section">
    <h2>节奏曲线总览</h2>
    ${buildCurveSvg(doc.curvePoints, doc.range, { color: doc.info.curveColor })}
  </section>`;
}

function renderOutline(doc: ExportDocument): string {
  if (doc.outline.length === 0) {
    return `<section class="lp-section"><h2>结构大纲</h2><p class="lp-empty">（无结构数据）</p></section>`;
  }
  return `<section class="lp-section">
    <h2>结构大纲</h2>
    <table class="lp-table"><thead><tr><th>编号</th><th>层级</th><th>名称</th><th>开始</th><th>结束</th></tr></thead>
    <tbody>${doc.outline
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.number)}</td><td>${escapeHtml(row.levelLabel)}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(formatTimeMs(row.startMs))}</td><td>${escapeHtml(formatTimeMs(row.endMs))}</td></tr>`,
      )
      .join('')}</tbody></table>
  </section>`;
}

function renderShotTable(doc: ExportDocument, images: Record<string, string>): string {
  if (doc.shots.length === 0) {
    return `<section class="lp-section"><h2>分镜表</h2><p class="lp-empty">（范围内没有镜头）</p></section>`;
  }
  const fields = doc.table.fields;
  const imgWidth = doc.layout.template === 'compact' ? 120 : doc.layout.template === 'gallery' ? 300 : 180;
  const header = fields.map((f) => `<th>${escapeHtml(EXPORT_FIELD_LABEL[f])}</th>`).join('');
  const body = doc.shots
    .map((row) => `<tr>${fields.map((f) => `<td>${cellValue(row, f, images, imgWidth)}</td>`).join('')}</tr>`)
    .join('');
  return `<section class="lp-section">
    <h2>分镜表</h2>
    <table class="lp-table lp-shot-table is-${escapeHtml(doc.layout.template)}"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>
  </section>`;
}

function renderGallery(doc: ExportDocument, images: Record<string, string>): string {
  if (doc.shots.length === 0) {
    return `<section class="lp-section"><h2>分镜展示</h2><p class="lp-empty">（范围内没有镜头）</p></section>`;
  }
  const cards = doc.shots
    .map(
      (row) => `<figure class="lp-card">
      ${frameImg(images, `shot:${row.shotId}`, 320, row.shotName)}
      <figcaption>
        <strong>${row.index}. ${escapeHtml(row.shotName)}</strong>
        <div class="lp-card-meta">${escapeHtml(formatTimeMs(row.startMs))} — ${escapeHtml(formatTimeMs(row.endMs))}（${escapeHtml(formatTimeMs(row.durationMs, { hours: 'auto' }))}）</div>
        <div class="lp-card-meta">${escapeHtml(row.chapterName)} / ${escapeHtml(row.sectionName)}</div>
        ${row.note.trim().length > 0 ? `<p class="lp-card-note">${multiline(row.note)}</p>` : ''}
      </figcaption>
    </figure>`,
    )
    .join('');
  return `<section class="lp-section"><h2>分镜展示</h2><div class="lp-gallery">${cards}</div></section>`;
}

function renderCurveNodes(doc: ExportDocument, images: Record<string, string>): string {
  if (doc.curveNodes.length === 0) {
    return `<section class="lp-section"><h2>曲线节点</h2><p class="lp-empty">（范围内没有曲线节点）</p></section>`;
  }
  const rows = doc.curveNodes
    .map(
      (node) => `<tr>
      ${doc.frames.includeCurveNodeFrames ? `<td>${frameImg(images, `curveNode:${node.timeMs}`, 140, '节点画面')}</td>` : ''}
      <td>${node.index}</td><td>${escapeHtml(formatTimeMs(node.timeMs))}</td><td>${node.value.toFixed(0)}</td></tr>`,
    )
    .join('');
  const head = `${doc.frames.includeCurveNodeFrames ? '<th>画面</th>' : ''}<th>#</th><th>时间</th><th>数值</th>`;
  return `<section class="lp-section"><h2>曲线节点</h2>
    <table class="lp-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></section>`;
}

function renderAnnotations(doc: ExportDocument, images: Record<string, string>): string {
  if (doc.annotations.length === 0) {
    return `<section class="lp-section"><h2>标注</h2><p class="lp-empty">（范围内没有标注）</p></section>`;
  }
  const items = doc.annotations
    .map(
      (a) => `<div class="lp-annotation">
      ${a.frameTimeMs !== null ? frameImg(images, `annotation:${a.index}`, 200, a.title) : ''}
      <div class="lp-annotation-body">
        <div class="lp-annotation-title">${a.index}. ${escapeHtml(a.title.length > 0 ? a.title : '（无标题）')} · ${escapeHtml(formatTimeMs(a.timeMs))}</div>
        <div class="lp-annotation-where">${escapeHtml(a.chapterName)} / ${escapeHtml(a.sectionName)}</div>
        ${a.body.trim().length > 0 ? `<p class="lp-annotation-text">${multiline(a.body)}</p>` : ''}
      </div>
    </div>`,
    )
    .join('');
  return `<section class="lp-section"><h2>标注</h2>${items}</section>`;
}

function renderNotes(doc: ExportDocument): string {
  if (doc.notes.length === 0) {
    return `<section class="lp-section"><h2>备注</h2><p class="lp-empty">（没有备注）</p></section>`;
  }
  const items = doc.notes
    .map(
      (note) => `<div class="lp-note">
      <div class="lp-note-head">${escapeHtml(note.levelLabel)}${note.number.length > 0 ? ` ${escapeHtml(note.number)}` : ''} · ${escapeHtml(note.name)} <span class="lp-note-time">${escapeHtml(formatTimeMs(note.startMs))} — ${escapeHtml(formatTimeMs(note.endMs))}</span></div>
      <div class="lp-note-text">${multiline(note.note)}</div>
    </div>`,
    )
    .join('');
  return `<section class="lp-section"><h2>备注</h2>${items}</section>`;
}

/* ------------------------------------------------------------------ */
/* 报告页面（PDF）                                                       */
/* ------------------------------------------------------------------ */

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { font-family: ${FONT_STACK}; color: #1C1F26; background: #FFFFFF; margin: 0; padding: 0; }
  .lp-report { padding: 24px 28px 32px; }
  .lp-report-title { font-size: 26px; font-weight: 700; margin: 0 0 2px; }
  .lp-report-sub { color: #6B7280; font-size: 12px; margin: 0 0 18px; }
  h2 { font-size: 16px; font-weight: 700; margin: 22px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #E2E5EC; }
  .lp-section { margin-bottom: 14px; }
  section { break-inside: auto; }
  h2 { break-after: avoid; }
  .lp-kv { border-collapse: collapse; width: 100%; font-size: 12px; }
  .lp-kv th { text-align: left; color: #6B7280; font-weight: 500; width: 34%; padding: 4px 8px; border-bottom: 1px solid #EEF0F4; }
  .lp-kv td { padding: 4px 8px; border-bottom: 1px solid #EEF0F4; }
  .lp-table { border-collapse: collapse; width: 100%; font-size: 11px; }
  .lp-table th { background: #F4F6F9; text-align: left; padding: 6px 7px; border: 1px solid #E2E5EC; font-weight: 600; }
  .lp-table td { padding: 5px 7px; border: 1px solid #E2E5EC; vertical-align: top; }
  .lp-shot-table tr { break-inside: avoid; }
  .lp-frame { display: block; border-radius: 4px; border: 1px solid #E2E5EC; }
  .lp-frame-missing { display: inline-block; padding: 18px 6px; text-align: center; color: #9AA1AF; background: #F4F6F9; border: 1px dashed #D3D8E0; font-size: 10px; }
  .lp-gallery { display: flex; flex-wrap: wrap; gap: 12px; }
  .lp-card { width: 340px; margin: 0; border: 1px solid #E2E5EC; border-radius: 6px; padding: 8px; break-inside: avoid; }
  .lp-card figcaption { font-size: 11px; margin-top: 6px; }
  .lp-card-meta { color: #6B7280; font-size: 10px; }
  .lp-card-note { margin: 4px 0 0; color: #333; }
  .lp-annotation { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid #EEF0F4; break-inside: avoid; }
  .lp-annotation-title { font-weight: 600; font-size: 12px; }
  .lp-annotation-where { color: #6B7280; font-size: 10px; margin: 2px 0; }
  .lp-annotation-text { margin: 3px 0 0; font-size: 11px; white-space: pre-wrap; }
  .lp-note { padding: 7px 0; border-bottom: 1px solid #EEF0F4; break-inside: avoid; }
  .lp-note-head { font-weight: 600; font-size: 12px; }
  .lp-note-time { color: #6B7280; font-weight: 400; font-size: 10px; }
  .lp-note-text { font-size: 11px; white-space: pre-wrap; margin-top: 3px; }
  .lp-empty { color: #9AA1AF; font-size: 12px; }
  .lp-compact .lp-table { font-size: 9px; }
  .lp-compact .lp-table td, .lp-compact .lp-table th { padding: 3px 4px; }
`;

export function buildReportHtml(doc: ExportDocument, options: ExportHtmlOptions = {}): string {
  const images = options.images ?? {};
  const parts: string[] = [];
  const showProjectName = doc.layout.showProjectName;
  const compact = doc.layout.template === 'compact';

  const modules = doc.modules;
  const has = (id: string): boolean => modules.includes(id as never);

  if (has('projectInfo')) parts.push(renderProjectInfo(doc));
  if (has('statistics')) parts.push(renderStatistics(doc));
  if (has('rhythmCurve')) parts.push(renderRhythm(doc));
  if (has('outline')) parts.push(renderOutline(doc));
  if (has('shotTable')) {
    parts.push(compact ? renderShotTable(doc, images) : doc.layout.template === 'gallery' ? renderGallery(doc, images) : renderShotTable(doc, images));
  }
  if (has('curveNodes')) parts.push(renderCurveNodes(doc, images));
  if (has('annotations')) parts.push(renderAnnotations(doc, images));
  if (has('notes')) parts.push(renderNotes(doc));

  const sub = [
    escapeHtml(doc.info.originalName),
    `时长 ${formatTimeMs(doc.info.durationMs, { hours: 'always' })}`,
    escapeHtml(doc.range.label),
    options.generatedAt !== undefined ? `导出时间 ${escapeHtml(options.generatedAt)}` : '',
  ]
    .filter((s) => s.length > 0)
    .join('　·　');

  const pageSize = doc.layout.orientation === 'landscape' ? 'A4 landscape' : 'A4 portrait';

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${escapeHtml(doc.info.name)} · 拉片报告</title>
<style>@page { size: ${pageSize}; margin: 14mm; }
${BASE_CSS}</style></head>
<body><main class="lp-report${compact ? ' lp-compact' : ''}">
${showProjectName ? `<h1 class="lp-report-title">${escapeHtml(doc.info.name)}　拉片报告</h1>` : ''}
<p class="lp-report-sub">${sub}</p>
${parts.join('\n')}
</main></body></html>`;
}

/* ------------------------------------------------------------------ */
/* 节奏谱页面（PNG）                                                     */
/* ------------------------------------------------------------------ */

/** 生成"完整节奏谱"页面，供隐藏窗口整页截图导出 PNG。 */
export function buildChartHtml(doc: ExportDocument, options: ExportHtmlOptions = {}): string {
  const width = 2000;
  const svgWidth = width - 80;
  const svgHeight = 560;
  const svg = buildCurveSvg(doc.curvePoints, doc.range, {
    width: svgWidth,
    height: svgHeight,
    color: doc.info.curveColor,
    overlay: ({ xOf, plotTop, plotHeight }) => {
      const chapterLines = doc.outline
        .filter((row) => row.level === 'chapter' && row.startMs > doc.range.startMs)
        .map((row) => {
          const x = xOf(row.startMs);
          return `<line x1="${x.toFixed(1)}" y1="${plotTop}" x2="${x.toFixed(1)}" y2="${(plotTop + plotHeight).toFixed(1)}" stroke="#8A93A6" stroke-dasharray="6 5"/><text x="${x.toFixed(1)}" y="${(plotTop - 6).toFixed(1)}" font-size="13" fill="#4B5160" text-anchor="middle">${escapeHtml(row.name)}</text>`;
        })
        .join('');
      const shotLines = doc.shots
        .filter((s) => s.index > 1)
        .map((s) => {
          const x = xOf(s.startMs);
          return `<line x1="${x.toFixed(1)}" y1="${(plotTop + plotHeight).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(plotTop + plotHeight + 8).toFixed(1)}" stroke="#C4CAD6"/>`;
        })
        .join('');
      const dots = doc.annotations
        .map((a) => {
          const x = xOf(a.timeMs);
          return `<circle cx="${x.toFixed(1)}" cy="${(plotTop + plotHeight + 16).toFixed(1)}" r="4" fill="#F5BA42"/>`;
        })
        .join('');
      return `${chapterLines}${shotLines}${dots}`;
    },
  });

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${escapeHtml(doc.info.name)} · 节奏谱</title>
<style>@page { size: ${width}px ${svgHeight + 130}px; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; width: ${width}px; background: #15171C; color: #E8EAF0; font-family: ${FONT_STACK}; }
.lp-chart { padding: 22px 40px 30px; }
.lp-chart h1 { font-size: 26px; margin: 0 0 4px; }
.lp-chart .sub { color: #9BA3B4; font-size: 15px; margin-bottom: 12px; }
.lp-curve-svg { display: block; }
</style></head>
<body><div class="lp-chart">
<h1>${escapeHtml(doc.info.name)} · 节奏谱</h1>
<div class="sub">${escapeHtml(doc.range.label)}　·　${escapeHtml(formatTimeMs(doc.range.startMs))} — ${escapeHtml(formatTimeMs(doc.range.endMs))}　·　${doc.shots.length} 个镜头${options.generatedAt !== undefined ? `　·　导出时间 ${escapeHtml(options.generatedAt)}` : ''}</div>
${svg}
</div></body></html>`;
}