import type { ExportEstimate, ExportEstimateParams, ExportRequest } from './api-types';
import { buildExportDocument } from './export-document';
import { EXPORT_QUALITY_WIDTH, resolveFrameWidth } from './export-config';

/**
 * 导出前预览估算（规格 13 交互要求：导出前提供内容预览与预计页数或文件大小）。
 *
 * 纯函数：基于导出文档的统计做粗略估算，数量级正确即可，不追求精确。
 * - frameCount：预计会抽取/嵌入的画面数量；
 * - pages：预计 PDF 页数；
 * - bytes：预计总大小；
 * - fileCount：产物文件数。
 */

/** 单张 JPEG 的粗略字节（按像素面积 × 每像素字节）。 */
function estimateFrameBytes(width: number): number {
  const px = width * (width * 9) / 16;
  // JPEG 在 q≈3-4 下约 0.3 字节/像素；标准档更高压缩，最高档略高。
  const perPixel = width >= 1600 ? 0.4 : 0.32;
  return Math.round(px * perPixel);
}

export function estimateExport(params: ExportEstimateParams): ExportEstimate {
  const doc = buildExportDocument({
    ...params,
    projectId: 'estimate',
    zip: false,
    suggestedName: 'estimate',
  } as ExportRequest);

  const shotFrames = params.frames.includeShotFrame ? doc.shots.length : 0;
  const nodeFrames = params.frames.includeCurveNodeFrames ? doc.curveNodes.length : 0;
  const annotationFrames = params.frames.includeAnnotationFrames ? doc.annotations.length : 0;
  const frameCount = shotFrames + nodeFrames + annotationFrames;

  const sourceWidth = doc.info.width > 0 ? doc.info.width : 1920;
  const frameWidth = resolveFrameWidth(params.frames.quality, params.frames.maxWidth, sourceWidth);
  const frameBytes = estimateFrameBytes(frameWidth);

  const kinds = params.kinds;
  const has = (id: string): boolean => kinds.includes(id as never);

  /* PDF 页数估算：正文块页 + 分镜行页。 */
  let pages = 0;
  if (has('pdf')) {
    const fixedBlocks = params.modules.filter((m) => m === 'projectInfo' || m === 'statistics').length;
    pages += fixedBlocks;
    if (params.modules.includes('rhythmCurve')) pages += 1;
    if (params.modules.includes('outline')) pages += Math.max(1, Math.ceil(doc.outline.length / 40));
    if (params.modules.includes('shotTable')) {
      const perPage = params.layout.template === 'compact' ? 8 : params.layout.template === 'gallery' ? 4 : 6;
      pages += Math.max(1, Math.ceil(doc.shots.length / perPage));
    }
    if (params.modules.includes('curveNodes')) pages += Math.max(0, Math.ceil(doc.curveNodes.length / 30));
    if (params.modules.includes('annotations')) pages += Math.max(0, Math.ceil(doc.annotations.length / 8));
    if (params.modules.includes('notes')) pages += Math.max(0, Math.ceil(doc.notes.length / 12));
    pages = Math.max(1, pages);
  }

  /* 大小估算：图片是大头，另加文本与表格开销。 */
  const frameTotal = frameCount * frameBytes;
  const textBytes = (doc.shots.length + doc.annotations.length + doc.outline.length + doc.notes.length) * 140;
  const perFileOverhead = 24 * 1024;
  let bytes = 0;
  if (has('pdf')) bytes += frameTotal + textBytes + 200 * 1024;
  if (has('xlsx')) bytes += frameTotal + textBytes + doc.shots.length * 90 + 120 * 1024;
  if (has('png')) bytes += estimateFrameBytes(EXPORT_QUALITY_WIDTH.high) * 0 + 900 * 1024;
  if (has('json')) bytes += 400 * 1024;
  if (has('markdown')) bytes += textBytes + 40 * 1024;
  bytes += kinds.length * perFileOverhead;

  return {
    pages,
    bytes,
    fileCount: params.kinds.length,
    frameCount,
  };
}