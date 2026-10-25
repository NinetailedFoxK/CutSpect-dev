import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { COMMANDS, isValidBinding } from '../../shared/keymap';
import type {
  AppSettings,
  ExportFieldId,
  ExportFramePosition,
  ExportFrameSettings,
  ExportKind,
  ExportLayoutSettings,
  ExportLayoutTemplate,
  ExportModuleId,
  ExportOrientation,
  ExportQualityId,
  ExportScopeKind,
  ExportTableSettings,
  ExportTemplate,
} from '../../shared/api-types';
import { EXPORT_KIND_DEFS, EXPORT_MODULE_DEFS, EXPORT_FIELD_DEFS } from '../../shared/export-config';
import { writeFileAtomic } from './atomic-write';

/**
 * 应用级设置存储（v1.1 快捷键自定义）：userData/settings.json，全局跨项目。
 *
 * - 读取时对键位做强校验：未知命令、非法键位一律丢弃（不信任磁盘/渲染层输入）。
 * - 写入走原子替换（复用 writeFileAtomic），避免半写坏文件。
 * - 文件缺失或损坏回落为默认设置（keymap 为空 = 全部使用默认键位）。
 */

export const SETTINGS_FILE_NAME = 'settings.json';

const COMMAND_IDS = new Set<string>(COMMANDS.map((command) => command.id));

export interface SettingsService {
  read(): Promise<AppSettings>;
  write(settings: AppSettings): Promise<AppSettings>;
}

function sanitizeKeymap(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object') {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!COMMAND_IDS.has(id) || typeof value !== 'string' || !isValidBinding(value)) {
      continue;
    }
    result[id] = value;
  }
  return result;
}

/** 对外暴露的校验入口（测试可直接断言）。 */
export function sanitizeSettings(raw: unknown): AppSettings {
  if (raw === null || typeof raw !== 'object') {
    return { keymap: {} };
  }
  const obj = raw as Record<string, unknown>;
  const result: AppSettings = { keymap: sanitizeKeymap(obj.keymap) };
  // 导出模板为可选项：仅当磁盘上存在数组时才保留（不新增空数组键，兼容旧断言）。
  if (Array.isArray(obj.exportTemplates)) {
    result.exportTemplates = sanitizeExportTemplates(obj.exportTemplates);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 导出模板清洗（不信任磁盘/渲染层输入）                                  */
/* ------------------------------------------------------------------ */

const EXPORT_KIND_SET = new Set<ExportKind>(EXPORT_KIND_DEFS.map((k) => k.id));
const EXPORT_MODULE_SET = new Set<ExportModuleId>(EXPORT_MODULE_DEFS.map((m) => m.id));
const EXPORT_FIELD_SET = new Set<ExportFieldId>(EXPORT_FIELD_DEFS.map((f) => f.id));
const SCOPE_KIND_SET = new Set<ExportScopeKind>(['project', 'chapter', 'section', 'shots', 'timeRange']);
const QUALITY_SET = new Set<ExportQualityId>(['standard', 'high', 'max']);
const FRAME_POSITION_SET = new Set<ExportFramePosition>(['cover', 'first', 'middle', 'last']);
const LAYOUT_TEMPLATE_SET = new Set<ExportLayoutTemplate>(['table', 'gallery', 'compact']);
const ORIENTATION_SET = new Set<ExportOrientation>(['portrait', 'landscape']);

function pickEnum<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value as T) ? (value as T) : fallback;
}

function sanitizeFrames(raw: unknown): ExportFrameSettings {
  const obj = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const maxWidth = typeof obj.maxWidth === 'number' && Number.isFinite(obj.maxWidth) ? Math.max(0, obj.maxWidth) : 0;
  return {
    includeShotFrame: obj.includeShotFrame !== false,
    framePosition: pickEnum(obj.framePosition, FRAME_POSITION_SET, 'middle'),
    includeAnnotationFrames: obj.includeAnnotationFrames === true,
    includeCurveNodeFrames: obj.includeCurveNodeFrames === true,
    quality: pickEnum(obj.quality, QUALITY_SET, 'standard'),
    maxWidth,
  };
}

function sanitizeTable(raw: unknown): ExportTableSettings {
  const obj = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fields = Array.isArray(obj.fields)
    ? obj.fields.filter((f): f is ExportFieldId => typeof f === 'string' && EXPORT_FIELD_SET.has(f as ExportFieldId))
    : [];
  return { fields: fields.length > 0 ? fields : ['index', 'frame', 'shotName', 'startTime', 'endTime', 'duration'] };
}

function sanitizeLayout(raw: unknown): ExportLayoutSettings {
  const obj = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    template: pickEnum(obj.template, LAYOUT_TEMPLATE_SET, 'table'),
    orientation: pickEnum(obj.orientation, ORIENTATION_SET, 'portrait'),
    showHeader: obj.showHeader !== false,
    showPageNumber: obj.showPageNumber !== false,
    showProjectName: obj.showProjectName !== false,
  };
}

function sanitizeTemplate(raw: unknown): ExportTemplate | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) return null;
  if (typeof obj.name !== 'string' || obj.name.trim().length === 0) return null;
  const kinds = Array.isArray(obj.kinds)
    ? obj.kinds.filter((k): k is ExportKind => typeof k === 'string' && EXPORT_KIND_SET.has(k as ExportKind))
    : [];
  const modules = Array.isArray(obj.modules)
    ? obj.modules.filter((m): m is ExportModuleId => typeof m === 'string' && EXPORT_MODULE_SET.has(m as ExportModuleId))
    : [];
  return {
    id: obj.id.slice(0, 64),
    name: obj.name.slice(0, 60),
    kinds: kinds.length > 0 ? kinds : ['pdf'],
    scopeKind: pickEnum(obj.scopeKind, SCOPE_KIND_SET, 'project'),
    modules: modules.length > 0 ? modules : ['shotTable'],
    frames: sanitizeFrames(obj.frames),
    table: sanitizeTable(obj.table),
    layout: sanitizeLayout(obj.layout),
    zip: obj.zip === true,
  };
}

export function sanitizeExportTemplates(raw: unknown): ExportTemplate[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: ExportTemplate[] = [];
  for (const entry of raw.slice(0, 50)) {
    const template = sanitizeTemplate(entry);
    if (template === null || seen.has(template.id)) continue;
    seen.add(template.id);
    result.push(template);
  }
  return result;
}

export function createSettingsService(options: { userDataDir: string }): SettingsService {
  const filePath = path.join(options.userDataDir, SETTINGS_FILE_NAME);
  return {
    async read(): Promise<AppSettings> {
      try {
        const text = await readFile(filePath, 'utf8');
        return sanitizeSettings(JSON.parse(text));
      } catch {
        return { keymap: {} };
      }
    },
    async write(settings: AppSettings): Promise<AppSettings> {
      const clean = sanitizeSettings(settings);
      await writeFileAtomic(filePath, `${JSON.stringify(clean, null, 2)}\n`);
      return clean;
    },
  };
}