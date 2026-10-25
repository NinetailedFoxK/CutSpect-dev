import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { err, ok } from '../../shared/api-types';
import type { ExportKind, ExportProduct, ExportRequest, TaskProgress, Result } from '../../shared/api-types';
import type { MediaContext } from './project-service';
import { buildExportDocument } from '../../shared/export-document';
import type { ExportDocument } from '../../shared/export-document';
import { buildMarkdownExport } from '../../shared/export-markdown';
import { buildChartHtml, buildReportHtml } from '../../shared/export-html';
import { EXPORT_KIND_DEFS, resolveFrameWidth } from '../../shared/export-config';
import { extractFrames, type ExportFrameRequest } from './export-frames';
import { buildExcelExport } from './export-excel';
import { renderHtmlToPdf, renderHtmlToPng } from './export-render';
import { zipFiles } from './export-archive';
import type { ExportTarget } from './export-service';

/**
 * 导出编排（批次 A-4 / B / C）：把一次导出请求完整执行到磁盘产物。
 *
 * 步骤（进度经 ctx 上报，可取消）：
 *   1. 构建导出文档（与当前曲线/标注/三级结构一致）；
 *   2. 抽取代表画面（高清、避让硬切、单帧失败降级）；
 *   3. 按输出格式生成：PDF / XLSX / PNG / JSON / Markdown；
 *   4. 多产物且选择 ZIP 时打包为压缩文件；
 *   5. 返回产物列表（路径 + 类型 + 大小）。
 *
 * 本模块依赖 electron 渲染（PDF/PNG），需真实运行环境；纯内容由 shared 覆盖单测。
 */

export interface ExportTaskContext {
  readonly signal: AbortSignal;
  report(progress: TaskProgress): void;
  reportStep(step: string): void;
}

export interface RunExportParams {
  request: ExportRequest;
  target: ExportTarget;
  media: MediaContext;
  ctx: ExportTaskContext;
  /** 生成时间（ISO）；缺省用当前时间。 */
  generatedAt?: string;
}

const KIND_LABEL: Record<ExportKind, string> = {
  pdf: 'PDF 报告',
  xlsx: 'XLSX 表格',
  png: 'PNG 节奏谱',
  json: 'JSON 数据',
  markdown: 'Markdown 笔记',
};

function extensionFor(kind: ExportKind): string {
  return EXPORT_KIND_DEFS.find((k) => k.id === kind)?.extension ?? 'dat';
}

function collectFrameRequests(doc: ExportDocument): ExportFrameRequest[] {
  const requests: ExportFrameRequest[] = [];
  if (doc.frames.includeShotFrame) {
    for (const shot of doc.shots) {
      if (shot.frameTimeMs !== null) {
        requests.push({ key: `shot:${shot.shotId}`, timeMs: shot.frameTimeMs });
      }
    }
  }
  if (doc.frames.includeCurveNodeFrames) {
    for (const node of doc.curveNodes) {
      requests.push({ key: `curveNode:${node.timeMs}`, timeMs: node.timeMs });
    }
  }
  if (doc.frames.includeAnnotationFrames) {
    for (const annotation of doc.annotations) {
      requests.push({ key: `annotation:${annotation.index}`, timeMs: annotation.timeMs });
    }
  }
  return requests;
}

interface PlannedFile {
  kind: ExportKind;
  /** 写入的绝对路径。 */
  path: string;
  /** ZIP 内部名字（不压缩时为 undefined）。 */
  zipName?: string;
}

function planFiles(target: ExportTarget, request: ExportRequest, base: string): PlannedFile[] {
  const kinds = request.kinds;
  if (request.zip && kinds.length > 1) {
    return kinds.map((kind) => ({ kind, path: '', zipName: `${base}.${extensionFor(kind)}` }));
  }
  if (target.mode === 'directory') {
    return kinds.map((kind) => ({ kind, path: path.join(target.path, `${base}.${extensionFor(kind)}`) }));
  }
  // 单文件：target.path 即完整文件路径。
  const only = kinds[0];
  return only === undefined ? [] : [{ kind: only, path: target.path }];
}

async function fileSize(absPath: string): Promise<number> {
  try {
    return (await stat(absPath)).size;
  } catch {
    return 0;
  }
}

async function toDataUrl(absPath: string): Promise<string> {
  const bytes = await readFile(absPath);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

export async function runExport(params: RunExportParams): Promise<Result<ExportProduct[]>> {
  const { request, target, media, ctx } = params;
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const cancelled = (): Result<never> => err('CANCELLED', '导出已取消。');

  /* 1. 构建导出文档 */
  ctx.reportStep('准备导出内容');
  const doc = buildExportDocument(request);

  /* 2. 抽取代表画面（仅当所选格式需要画面时） */
  const images = new Map<string, string>();
  const dataUrls: Record<string, string> = {};
  const needsFrames =
    (doc.frames.includeShotFrame || doc.frames.includeCurveNodeFrames || doc.frames.includeAnnotationFrames) &&
    request.kinds.some((k) => k === 'pdf' || k === 'xlsx');
  if (needsFrames) {
    const requests = collectFrameRequests(doc);
    if (requests.length > 0) {
      const width = resolveFrameWidth(request.frames.quality, request.frames.maxWidth, media.media.width);
      ctx.report({ kind: 'step', step: `抽取画面 0/${requests.length}` });
      const extracted = await extractFrames({
        projectFolder: media.folder,
        sourceAbsPath: media.sourceAbsPath,
        media: media.media,
        requests,
        width,
        quality: request.frames.quality === 'standard' ? 4 : 3,
        cancelSignal: ctx.signal,
        onProgress: (done, total) => ctx.report({ kind: 'step', step: `抽取画面 ${done}/${total}` }),
      });
      if (!extracted.ok) {
        return extracted;
      }
      for (const [key, absPath] of extracted.data.frames) {
        images.set(key, absPath);
      }
      // PDF 报告把画面内联为 data URL（避免隐藏窗口跨协议取图）。
      if (request.kinds.includes('pdf')) {
        for (const [key, absPath] of images) {
          try {
            dataUrls[key] = await toDataUrl(absPath);
          } catch {
            // 单张画面读取失败不影响整体（占位显示）。
          }
        }
      }
    }
  }

  const base = request.suggestedName.trim().length > 0 ? request.suggestedName : doc.info.name;
  const files = planFiles(target, request, base);
  const useZip = request.zip && request.kinds.length > 1;

  const products: ExportProduct[] = [];
  let tempDir: string | null = null;

  try {
    // 目录模式：确保目标目录存在（用户在对话框选定的目录通常已存在，这里兜底）。
    if (target.mode === 'directory' && !useZip) {
      await mkdir(target.path, { recursive: true });
    }
    for (let i = 0; i < files.length; i++) {
      if (ctx.signal.aborted) return cancelled();
      const file = files[i];
      if (file === undefined) continue;
      const writePath =
        useZip && file.zipName !== undefined
          ? (tempDir ??= await mkdtemp(path.join(tmpdir(), 'laipian-export-')))
          : file.path;
      const outPath =
        useZip && file.zipName !== undefined ? path.join(writePath, file.zipName) : file.path;

      ctx.reportStep(`生成 ${KIND_LABEL[file.kind]}（${i + 1}/${files.length}）`);
      const written = await generateOne(file.kind, outPath, doc, request, images, dataUrls, generatedAt, ctx);
      if (!written.ok) {
        return written;
      }
    }

    if (useZip && tempDir !== null) {
      if (ctx.signal.aborted) return cancelled();
      ctx.reportStep('打包 ZIP');
      const entries = files
        .filter((f) => f.zipName !== undefined)
        .map((f) => ({ path: path.join(tempDir as string, f.zipName as string), name: f.zipName as string }));
      const size = await zipFiles(target.path, entries);
      products.push({ path: target.path, kind: 'json', sizeBytes: size });
      return ok(products);
    }

    for (const file of files) {
      products.push({ path: file.path, kind: file.kind, sizeBytes: await fileSize(file.path) });
    }
    return ok(products);
  } finally {
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function generateOne(
  kind: ExportKind,
  outPath: string,
  doc: ExportDocument,
  request: ExportRequest,
  images: Map<string, string>,
  dataUrls: Record<string, string>,
  generatedAt: string,
  ctx: ExportTaskContext,
): Promise<Result<null>> {
  try {
    switch (kind) {
      case 'pdf': {
        const html = buildReportHtml(doc, { images: dataUrls, generatedAt });
        await renderHtmlToPdf(html, outPath, {
          landscape: doc.layout.orientation === 'landscape',
          showHeader: doc.layout.showHeader,
          showPageNumber: doc.layout.showPageNumber,
          projectName: doc.info.name,
          generatedAt,
        });
        return ok(null);
      }
      case 'png': {
        const html = buildChartHtml(doc, { generatedAt });
        await renderHtmlToPng(html, outPath);
        return ok(null);
      }
      case 'xlsx': {
        const result = await buildExcelExport(outPath, { document: doc, images });
        return result.ok ? ok(null) : result;
      }
      case 'json': {
        await writeFile(outPath, `${JSON.stringify(request.snapshot, null, 2)}\n`, 'utf8');
        return ok(null);
      }
      case 'markdown': {
        await writeFile(outPath, buildMarkdownExport(request.snapshot, { generatedAt }), 'utf8');
        return ok(null);
      }
      default:
        return err('INVALID_PARAMS', `不支持的导出格式：${String(kind)}。`);
    }
  } catch (error) {
    void ctx;
    return err('IO', `生成 ${KIND_LABEL[kind]} 失败：${(error as Error).message}`, true);
  }
}