import { Workbook } from 'exceljs';
import type { Worksheet } from 'exceljs';
import { err, ok } from '../../shared/api-types';
import type { ExportFieldId, Result } from '../../shared/api-types';
import type { ExportDocument } from '../../shared/export-document';
import { EXPORT_FIELD_DEFS, EXPORT_FIELD_LABEL } from '../../shared/export-config';
import { formatTimeMs } from '../../shared/time';

/**
 * XLSX（继续整理）导出（规格 13 重设计）。
 *
 * 默认工作表：项目信息 / 分镜拉片表 / 曲线节点 / 标注列表 / 结构大纲，
 * 序列化由 main 用 exceljs 完成（Node 库，不能在 renderer 使用）。
 *
 * 关键要求：分镜表中每个镜头一行，并**直接嵌入代表画面**（不填图片路径）。
 * - 图片经 workbook.addImage({ filename }) 从抽出的 JPEG 文件嵌入；
 * - 单张画面缺失时该单元格留空，不中断整表。
 */

const SHEET_NAME_SAFE = (name: string): string => name.replace(/[\\/?*[\]:]/g, '_').slice(0, 31);

const HEADER_FILL = 'FFF1F3F6';
const BORDER_COLOR = 'FFD9DEE6';

export interface ExcelExportOptions {
  document: ExportDocument;
  /** 帧图：key → 抽帧 JPEG 绝对路径（缺失表示该画面不可用）。 */
  images: Map<string, string>;
  /** 分镜表中代表画面的显示宽度（像素）。 */
  frameDisplayWidth?: number;
}

function fieldWidth(field: ExportFieldId): number {
  return EXPORT_FIELD_DEFS.find((def) => def.id === field)?.width ?? 14;
}

function styleHeader(sheet: Worksheet, columns: number): void {
  const row = sheet.getRow(1);
  row.font = { bold: true, size: 11 };
  row.height = 22;
  row.alignment = { vertical: 'middle' };
  for (let c = 1; c <= columns; c++) {
    const cell = row.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.border = {
      top: { style: 'thin', color: { argb: BORDER_COLOR } },
      left: { style: 'thin', color: { argb: BORDER_COLOR } },
      bottom: { style: 'thin', color: { argb: BORDER_COLOR } },
      right: { style: 'thin', color: { argb: BORDER_COLOR } },
    };
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function styleBody(sheet: Worksheet, rows: number, columns: number): void {
  for (let r = 2; r <= rows + 1; r++) {
    for (let c = 1; c <= columns; c++) {
      const cell = sheet.getRow(r).getCell(c);
      cell.border = {
        top: { style: 'thin', color: { argb: BORDER_COLOR } },
        left: { style: 'thin', color: { argb: BORDER_COLOR } },
        bottom: { style: 'thin', color: { argb: BORDER_COLOR } },
        right: { style: 'thin', color: { argb: BORDER_COLOR } },
      };
      cell.alignment = { vertical: 'top', wrapText: true };
    }
  }
}

function writeProjectInfoSheet(workbook: Workbook, doc: ExportDocument): void {
  const sheet = workbook.addWorksheet(SHEET_NAME_SAFE('项目信息'));
  const info = doc.info;
  const rows: [string, string | number][] = [
    ['项目名称', info.name],
    ['源文件', info.originalName],
    ['视频时长', formatTimeMs(info.durationMs, { hours: 'always' })],
    ['分辨率', `${info.width} × ${info.height}`],
    ['视频编码', info.videoCodec],
    ['音频编码', info.audioCodec ?? '无音轨'],
    ['帧率', info.frameRateLabel],
    ['文件大小', `${(info.sizeBytes / (1024 * 1024)).toFixed(1)} MB`],
    ['曲线维度', info.curveName],
    ['导出范围', doc.range.label],
    ['导出时间', new Date().toISOString()],
  ];
  sheet.columns = [
    { key: 'k', width: 18 },
    { key: 'v', width: 60 },
  ];
  for (const [k, v] of rows) {
    sheet.addRow({ k, v });
  }
  sheet.getColumn(1).font = { bold: true };
}

function writeShotSheet(workbook: Workbook, options: ExcelExportOptions): number {
  const doc = options.document;
  const fields = doc.table.fields;
  const sheet = workbook.addWorksheet(SHEET_NAME_SAFE('分镜拉片表'));
  sheet.columns = fields.map((field) => ({
    key: field,
    header: EXPORT_FIELD_LABEL[field],
    width: fieldWidth(field),
  }));
  styleHeader(sheet, fields.length);

  const aspect = doc.info.width > 0 ? doc.info.height / doc.info.width : 9 / 16;
  const displayWidth = options.frameDisplayWidth ?? 150;
  const displayHeight = Math.round(displayWidth * aspect);

  const frameCol = fields.indexOf('frame');
  let insertedImages = 0;

  doc.shots.forEach((row) => {
    const record: Record<string, string | number> = {};
    for (const field of fields) {
      switch (field) {
        case 'index':
          record[field] = row.index;
          break;
        case 'frame':
          record[field] = '';
          break;
        case 'startTime':
          record[field] = formatTimeMs(row.startMs);
          break;
        case 'endTime':
          record[field] = formatTimeMs(row.endMs);
          break;
        case 'duration':
          record[field] = formatTimeMs(row.durationMs, { hours: 'auto' });
          break;
        case 'curveStart':
          record[field] = Math.round(row.curveStart);
          break;
        case 'curvePeak':
          record[field] = Math.round(row.curvePeak);
          break;
        case 'curveEnd':
          record[field] = Math.round(row.curveEnd);
          break;
        case 'chapterName':
          record[field] = row.chapterName;
          break;
        case 'sectionName':
          record[field] = row.sectionName;
          break;
        case 'shotName':
          record[field] = row.shotName;
          break;
        case 'annotationSummary':
          record[field] = row.annotationSummary;
          break;
        case 'note':
          record[field] = row.note;
          break;
        default:
          record[field] = '';
      }
    }
    sheet.addRow(record);
  });

  // 行高 + 嵌入代表画面（不填路径）。
  doc.shots.forEach((row, i) => {
    const worksheetRow = sheet.getRow(i + 2);
    if (frameCol >= 0 && doc.frames.includeShotFrame) {
      worksheetRow.height = Math.max(worksheetRow.height ?? 15, displayHeight * 0.75 + 6);
    }
    const absPath = options.images.get(`shot:${row.shotId}`);
    if (frameCol >= 0 && absPath !== undefined) {
      const imageId = workbook.addImage({ filename: absPath, extension: 'jpeg' });
      sheet.addImage(imageId, {
        tl: { col: frameCol, row: i + 1 },
        ext: { width: displayWidth, height: displayHeight },
        editAs: 'oneCell',
      });
      insertedImages++;
    }
  });

  styleBody(sheet, doc.shots.length, fields.length);
  return insertedImages;
}

function writeCurveNodeSheet(workbook: Workbook, doc: ExportDocument): void {
  const sheet = workbook.addWorksheet(SHEET_NAME_SAFE('曲线节点'));
  sheet.columns = [
    { key: 'index', header: '#', width: 6 },
    { key: 'time', header: '时间码', width: 16 },
    { key: 'value', header: '数值', width: 10 },
    { key: 'picture', header: '画面', width: 22 },
  ];
  styleHeader(sheet, 4);
  doc.curveNodes.forEach((node) => {
    sheet.addRow({ index: node.index, time: formatTimeMs(node.timeMs), value: Math.round(node.value), picture: '' });
  });
  styleBody(sheet, doc.curveNodes.length, 4);
}

function writeAnnotationSheet(workbook: Workbook, doc: ExportDocument): void {
  const sheet = workbook.addWorksheet(SHEET_NAME_SAFE('标注列表'));
  sheet.columns = [
    { key: 'index', header: '#', width: 6 },
    { key: 'time', header: '时间码', width: 16 },
    { key: 'title', header: '标题', width: 26 },
    { key: 'chapter', header: '章', width: 16 },
    { key: 'section', header: '段落', width: 16 },
    { key: 'body', header: '正文', width: 50 },
  ];
  styleHeader(sheet, 6);
  doc.annotations.forEach((a) => {
    sheet.addRow({
      index: a.index,
      time: formatTimeMs(a.timeMs),
      title: a.title.length > 0 ? a.title : '（无标题）',
      chapter: a.chapterName,
      section: a.sectionName,
      body: a.body,
    });
  });
  styleBody(sheet, doc.annotations.length, 6);
}

function writeOutlineSheet(workbook: Workbook, doc: ExportDocument): void {
  const sheet = workbook.addWorksheet(SHEET_NAME_SAFE('结构大纲'));
  sheet.columns = [
    { key: 'number', header: '编号', width: 12 },
    { key: 'level', header: '层级', width: 8 },
    { key: 'name', header: '名称', width: 24 },
    { key: 'start', header: '开始', width: 16 },
    { key: 'end', header: '结束', width: 16 },
    { key: 'note', header: '备注', width: 40 },
  ];
  styleHeader(sheet, 6);
  doc.outline.forEach((row) => {
    sheet.addRow({
      number: row.number,
      level: row.levelLabel,
      name: row.name,
      start: formatTimeMs(row.startMs),
      end: formatTimeMs(row.endMs),
      note: row.note,
    });
  });
  styleBody(sheet, doc.outline.length, 6);
}

function writeStatisticsSheet(workbook: Workbook, doc: ExportDocument): void {
  const sheet = workbook.addWorksheet(SHEET_NAME_SAFE('统计数据'));
  const s = doc.statistics;
  sheet.columns = [
    { key: 'k', width: 18 },
    { key: 'v', width: 40 },
  ];
  const rows: [string, string | number][] = [
    ['章节数', s.chapterCount],
    ['段落数', s.sectionCount],
    ['镜头数', s.shotCount],
    ['标注数', s.annotationCount],
    ['曲线节点数', s.curveNodeCount],
    ['范围内时长', formatTimeMs(s.rangeDurationMs, { hours: 'always' })],
    ['平均镜头时长', formatTimeMs(s.avgShotMs, { hours: 'auto' })],
    ['最短镜头', formatTimeMs(s.minShotMs, { hours: 'auto' })],
    ['最长镜头', formatTimeMs(s.maxShotMs, { hours: 'auto' })],
    ['镜头密度', `${s.shotDensityPerMin.toFixed(1)} 个/分`],
    ['曲线峰值', s.peakValue],
    ['曲线低值', s.minValue],
  ];
  for (const [k, v] of rows) sheet.addRow({ k, v });
  sheet.getColumn(1).font = { bold: true };
}

/**
 * 写入 XLSX 文件。返回嵌入的代表画面数量（供日志/验收）。
 * 写文件失败返回 IO 错误（原子替换由调用方保证：先写临时文件再 rename）。
 */
export async function buildExcelExport(
  targetPath: string,
  options: ExcelExportOptions,
): Promise<Result<{ imageCount: number }>> {
  const doc = options.document;
  const workbook = new Workbook();
  workbook.creator = 'CutSpect';
  workbook.created = new Date();

  const has = (id: string): boolean => doc.modules.includes(id as never);
  let imageCount = 0;

  if (has('projectInfo')) writeProjectInfoSheet(workbook, doc);
  if (has('shotTable')) imageCount += writeShotSheet(workbook, options);
  if (has('curveNodes')) writeCurveNodeSheet(workbook, doc);
  if (has('annotations')) writeAnnotationSheet(workbook, doc);
  if (has('outline')) writeOutlineSheet(workbook, doc);
  if (has('statistics')) writeStatisticsSheet(workbook, doc);

  if (workbook.worksheets.length === 0) {
    // 未选任何模块时至少写入分镜表，避免产出空工作簿。
    writeShotSheet(workbook, options);
  }

  try {
    await workbook.xlsx.writeFile(targetPath);
  } catch (error) {
    return err('IO', `写入 XLSX 失败：${(error as Error).message}`, true);
  }
  return ok({ imageCount });
}