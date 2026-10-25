import path from 'node:path';
import { err, ok } from '../../shared/api-types';
import type {
  ExportKind,
  ExportProduct,
  ExportSaveParams,
  ExportType,
  Result,
} from '../../shared/api-types';
import { EXPORT_KIND_DEFS } from '../../shared/export-config';
import { writeFileAtomic } from './atomic-write';

/**
 * 导出保存服务（规格 13 + 导出中心重设计）。
 *
 * 负责"系统交互与文件事务"这一层，不含具体格式生成（那在 export-runner）：
 * - save：旧的 PNG / Markdown 直接保存（保留兼容）；
 * - chooseTarget：按产物数量弹出合适的系统对话框（单文件 / 多文件目录 / ZIP）；
 * - reveal / open：完成后"在文件夹中显示"与"打开文件"；
 * - 只允许操作本会话生成的产物路径（owns 白名单），杜绝任意路径打开。
 *
 * 本模块不 import electron（对话框与 shell 由 main 注入），可在 vitest 下测试。
 */

export interface SaveDialogOptions {
  title: string;
  defaultPath: string;
  filters: { name: string; extensions: string[] }[];
}

export interface ExportServiceOptions {
  /** 系统保存对话框；返回用户选择的绝对路径，取消返回 null。 */
  showSaveDialog(options: SaveDialogOptions): Promise<string | null>;
  /** 系统目录选择对话框（多文件时用）；取消返回 null。 */
  showDirectoryDialog?(options: { title: string; message?: string }): Promise<string | null>;
  /** 在系统文件管理器中显示；由 main 注入 shell.showItemInFolder。 */
  revealInFolder?(absPath: string): void;
  /** 用系统默认程序打开；由 main 注入 shell.openPath。返回空串表示成功。 */
  openWithSystem?(absPath: string): Promise<string>;
}

/** 导出目标：单文件（含 ZIP）或目录（多产物）。 */
export interface ExportTarget {
  path: string;
  mode: 'file' | 'directory';
}

export interface ChooseTargetInput {
  suggestedName: string;
  kinds: ExportKind[];
  zip: boolean;
}

export interface ExportService {
  save(params: ExportSaveParams): Promise<Result<{ savedPath: string } | null>>;
  /** 依据产物数量与是否 ZIP 弹出合适的系统对话框；用户取消返回 data: null。 */
  chooseTarget(input: ChooseTargetInput): Promise<Result<ExportTarget | null>>;
  /** 在系统文件管理器中显示（仅限本会话产物）。 */
  reveal(path: string): Promise<Result<null>>;
  /** 用系统默认程序打开（仅限本会话产物）。 */
  open(path: string): Promise<Result<null>>;
  /** 登记某任务产物，建立 reveal/open 白名单。 */
  remember(taskId: string, products: ExportProduct[]): void;
  /** 查询某任务产物（未完成返回空数组）。 */
  products(taskId: string): ExportProduct[];
  /** 该路径是否为本会话产物。 */
  owns(path: string): boolean;
}

/** 过滤路径分隔符与非法字符，仅保留建议文件名（不带目录）。 */
export function sanitizeExportName(name: string): string {
  const base = path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  const safe = base.replace(/[. ]+$/g, '');
  return safe.length > 0 ? safe : 'CutSpect导出';
}

function ensureExtension(name: string, type: ExportType): string {
  const lower = name.toLowerCase();
  if (type === 'png') {
    return lower.endsWith('.png') ? name : `${name}.png`;
  }
  return lower.endsWith('.md') || lower.endsWith('.markdown') ? name : `${name}.md`;
}

/** 由 data URL 解码 PNG 字节；非 PNG data URL 抛错。 */
export function decodePngDataUrl(payload: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(payload.trim());
  if (!match || match[1] === undefined) {
    throw new Error('PNG 导出内容不是有效的 image/png data URL。');
  }
  return Buffer.from(match[1], 'base64');
}

const KIND_FILTER_NAME: Record<ExportKind, string> = {
  pdf: 'PDF 文档',
  xlsx: 'Excel 工作簿',
  png: 'PNG 图片',
  json: 'JSON 数据',
  markdown: 'Markdown 笔记',
};

function filterForKind(kind: ExportKind): { name: string; extensions: string[] } {
  const def = EXPORT_KIND_DEFS.find((k) => k.id === kind);
  return { name: KIND_FILTER_NAME[kind], extensions: [def?.extension ?? 'dat'] };
}

export function createExportService(options: ExportServiceOptions): ExportService {
  const owned = new Set<string>();
  const byTask = new Map<string, ExportProduct[]>();

  return {
    async save(params) {
      const name = ensureExtension(sanitizeExportName(params.suggestedName), params.type);
      const filters =
        params.type === 'png'
          ? [{ name: 'PNG 图片', extensions: ['png'] }]
          : [{ name: 'Markdown 笔记', extensions: ['md', 'markdown'] }];
      let targetPath: string | null;
      try {
        targetPath = await options.showSaveDialog({
          title: params.type === 'png' ? '导出分析图（PNG）' : '导出分析笔记（Markdown）',
          defaultPath: name,
          filters,
        });
      } catch (error) {
        return err('IO', `打开保存对话框失败：${(error as Error).message}`, true);
      }
      if (targetPath === null || targetPath.length === 0) {
        return ok(null); // 用户取消：静默返回。
      }

      try {
        if (params.type === 'png') {
          const bytes = decodePngDataUrl(params.payload);
          if (bytes.length === 0) {
            return err('INVALID_PARAMS', 'PNG 导出内容为空。');
          }
          await writeFileAtomic(targetPath, bytes);
        } else {
          await writeFileAtomic(targetPath, params.payload);
        }
      } catch (error) {
        return err('IO', `写入失败，原有文件未被替换：${(error as Error).message}`, true);
      }
      owned.add(targetPath);
      return ok({ savedPath: targetPath });
    },

    async chooseTarget(input) {
      const base = sanitizeExportName(input.suggestedName);
      const count = input.kinds.length;
      try {
        // 多个文件且选择 ZIP → 直接保存一个 .zip。
        if (input.zip && count > 1) {
          const target = await options.showSaveDialog({
            title: '导出（合并为 ZIP）',
            defaultPath: `${base}.zip`,
            filters: [{ name: 'ZIP 压缩文件', extensions: ['zip'] }],
          });
          return ok(target === null || target.length === 0 ? null : { path: target, mode: 'file' });
        }
        // 单个文件 → 保存对话框（带该格式筛选）。
        if (count === 1) {
          const kind = input.kinds[0] ?? 'pdf';
          const def = EXPORT_KIND_DEFS.find((k) => k.id === kind);
          const target = await options.showSaveDialog({
            title: '导出',
            defaultPath: `${base}.${def?.extension ?? 'dat'}`,
            filters: [filterForKind(kind)],
          });
          return ok(target === null || target.length === 0 ? null : { path: target, mode: 'file' });
        }
        // 多个文件且不压缩 → 选目录，逐个写入。
        if (options.showDirectoryDialog === undefined) {
          return err('INTERNAL', '多文件导出需要目录选择对话框。');
        }
        const dir = await options.showDirectoryDialog({
          title: '选择导出位置',
          message: `将导出 ${count} 个文件到所选文件夹。`,
        });
        return ok(dir === null || dir.length === 0 ? null : { path: dir, mode: 'directory' });
      } catch (error) {
        return err('IO', `打开保存对话框失败：${(error as Error).message}`, true);
      }
    },

    async reveal(targetPath) {
      if (!owned.has(targetPath)) {
        return err('INVALID_PARAMS', '只能显示本次导出的文件。');
      }
      if (options.revealInFolder === undefined) {
        return err('INTERNAL', '当前环境不支持在文件夹中显示。');
      }
      options.revealInFolder(targetPath);
      return ok(null);
    },

    async open(targetPath) {
      if (!owned.has(targetPath)) {
        return err('INVALID_PARAMS', '只能打开本次导出的文件。');
      }
      if (options.openWithSystem === undefined) {
        return err('INTERNAL', '当前环境不支持打开文件。');
      }
      const message = await options.openWithSystem(targetPath);
      if (message.length > 0) {
        return err('IO', `打开文件失败：${message}`, true);
      }
      return ok(null);
    },

    remember(taskId, products) {
      for (const product of products) {
        owned.add(product.path);
      }
      byTask.set(taskId, products);
    },

    products(taskId) {
      return byTask.get(taskId) ?? [];
    },

    owns(targetPath) {
      return owned.has(targetPath);
    },
  };
}

export type { ExportKind };