import type { ProjectSnapshot } from '@shared/api-types';
import { buildPngExport, type PngExportOptions } from '@shared/export-png';
import { formatTimeMs } from '@shared/time';

/**
 * PNG 分析图光栅化（规格 13.1）：在 renderer 用 Canvas 按导出模型绘制，
 * 产出 PNG data URL 交主进程保存。使用独立导出坐标（不截取窗口），
 * 不含选择框/控制柄/播放头；中文字体走系统中文字体后备。
 *
 * 注意：本函数依赖 DOM Canvas，无法在 node 测试环境单测；其坐标与内容
 * 由 shared/export-png.ts 的模型测试覆盖，真实光栅化需在窗口内验证。
 */

const FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

const BG = '#15171C';
const TEXT = '#E8EAF0';
const TEXT_DIM = '#9BA3B4';
const GRID = '#3A3F4D';
const BOUNDARY = '#8A93A6';
const NOTE = '#F5BA42';

export function renderPngDataUrl(snapshot: ProjectSnapshot, options: PngExportOptions = {}): string {
  const model = buildPngExport(snapshot, options);
  const canvas = document.createElement('canvas');
  canvas.width = model.width;
  canvas.height = model.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法获取 2D 绘图上下文。');
  }

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, model.width, model.height);

  // 标题与副标题（规格 13.1：含项目名、曲线名）。
  ctx.fillStyle = TEXT;
  ctx.font = `bold 34px ${FONT_STACK}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(model.title, model.plot.left, 56);
  ctx.fillStyle = TEXT_DIM;
  ctx.font = `18px ${FONT_STACK}`;
  ctx.fillText(
    `曲线：${model.curveName}　时长：${formatTimeMs(snapshot.media.durationMs, { hours: 'always' })}`,
    model.plot.left,
    86,
  );

  // 纵轴轻网格与「低—高」（规格 3.1：仅编辑坐标，不暗示测量值）。
  for (const value of [0, 50, 100]) {
    const y = model.plot.top + (1 - value / 100) * model.plot.height;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(model.plot.left, y);
    ctx.lineTo(model.plot.left + model.plot.width, y);
    ctx.stroke();
  }
  ctx.fillStyle = TEXT_DIM;
  ctx.font = `14px ${FONT_STACK}`;
  ctx.fillText('高', model.plot.left - 30, model.plot.top + 6);
  ctx.fillText('低', model.plot.left - 30, model.plot.top + model.plot.height);

  // 绘图区边框。
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.strokeRect(model.plot.left, model.plot.top, model.plot.width, model.plot.height);

  // 时间刻度与标签。
  ctx.fillStyle = TEXT_DIM;
  ctx.font = `14px ${FONT_STACK}`;
  for (const tick of model.ticks) {
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(tick.x, model.plot.top + model.plot.height);
    ctx.lineTo(tick.x, model.plot.top + model.plot.height + 6);
    ctx.stroke();
    ctx.fillText(tick.label, tick.x, model.labelsY + 4);
  }

  // 分界线。
  for (const boundary of model.boundaries) {
    ctx.save();
    ctx.strokeStyle = boundary.locked ? NOTE : BOUNDARY;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(boundary.x, model.plot.top);
    ctx.lineTo(boundary.x, model.plot.top + model.plot.height);
    ctx.stroke();
    ctx.restore();
  }

  // 段落名：居中于两边界之间的区间（与编辑器一致）。
  ctx.fillStyle = TEXT_DIM;
  ctx.font = `14px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  for (const label of model.sectionLabels) {
    if (label.name.length > 0) {
      ctx.fillText(label.name.slice(0, 20), label.x, model.plot.top + 16);
    }
  }
  ctx.textAlign = 'left';

  // 曲线（导出不画节点/控制柄）。
  ctx.strokeStyle = model.color;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  model.curvePoints.forEach((p, i) => {
    if (i === 0) {
      ctx.moveTo(p.x, p.y);
    } else {
      ctx.lineTo(p.x, p.y);
    }
  });
  ctx.stroke();

  // 标注点与编号。
  ctx.font = `bold 13px ${FONT_STACK}`;
  for (const mark of model.annotations) {
    ctx.fillStyle = NOTE;
    ctx.beginPath();
    ctx.arc(mark.x, mark.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = BG;
    ctx.fillText(String(mark.index), mark.x + 10, mark.y - 8);
    if (mark.title.length > 0) {
      ctx.fillStyle = NOTE;
      ctx.font = `14px ${FONT_STACK}`;
      const label = mark.title.length > 12 ? `${mark.title.slice(0, 12)}…` : mark.title;
      const labelX = Math.min(mark.x + 14, model.width - 140);
      ctx.fillText(label, labelX, mark.y + 4);
      ctx.font = `bold 13px ${FONT_STACK}`;
    }
  }

  // 底部编号与标题索引（规格 13.1）。
  ctx.fillStyle = TEXT;
  ctx.font = `bold 22px ${FONT_STACK}`;
  ctx.fillText('编号与标题索引', model.plot.left, model.indexHeaderY);
  ctx.fillStyle = TEXT_DIM;
  ctx.font = `16px ${FONT_STACK}`;
  for (const entry of model.indexEntries) {
    entry.lines.forEach((line, lineIndex) => {
      const prefix = lineIndex === 0 ? `${entry.index}. [${entry.timeLabel}] ` : '    ';
      ctx.fillText(prefix + line, model.plot.left, entry.y + lineIndex * 22);
    });
  }
  if (model.indexTruncated) {
    const lastY = model.indexEntries.length > 0
      ? (model.indexEntries[model.indexEntries.length - 1]?.y ?? model.indexHeaderY) + 30
      : model.indexHeaderY + 30;
    ctx.fillStyle = NOTE;
    ctx.fillText(
      `（共 ${model.totalAnnotations} 条标注，PNG 仅含前 ${model.indexEntries.length} 条编号；完整文字见 Markdown 笔记。）`,
      model.plot.left,
      lastY,
    );
  }

  return canvas.toDataURL('image/png');
}