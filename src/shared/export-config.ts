import type {
  ExportFieldId,
  ExportFrameSettings,
  ExportKind,
  ExportLayoutSettings,
  ExportModuleId,
  ExportQualityId,
  ExportRequest,
  ExportScope,
  ExportScopeKind,
  ExportTableSettings,
  ExportTemplate,
  ProjectSnapshot,
} from './api-types';

/**
 * 导出配置：字段定义、模块定义、质量档、默认值与标准导出预设（纯常量 + 纯函数）。
 *
 * 设计（呼应"标准导出只让用户选两件事"）：
 * - 标准导出 = 一个预设 Request（PDF 或 Excel）+ 用户选的范围；
 * - 专业自定义 = 在预设基础上修改各维度；
 * - 本文件不依赖 DOM / Node / Electron，可在 vitest 下完整测试。
 */

/* ------------------------------------------------------------------ */
/* 输出格式                                                             */
/* ------------------------------------------------------------------ */

export interface ExportKindDef {
  id: ExportKind;
  /** 用户可见名称（使用常见格式名，不造新术语）。 */
  label: string;
  /** 用途说明。 */
  usage: string;
  extension: string;
}

export const EXPORT_KIND_DEFS: readonly ExportKindDef[] = [
  { id: 'pdf', label: 'PDF', usage: '阅读、分享和打印', extension: 'pdf' },
  { id: 'xlsx', label: 'XLSX', usage: '继续编辑和整理', extension: 'xlsx' },
  { id: 'png', label: 'PNG', usage: '导出完整节奏谱', extension: 'png' },
  { id: 'json', label: 'JSON', usage: '项目数据备份与交换', extension: 'json' },
  { id: 'markdown', label: 'Markdown', usage: '纯文本笔记，便于复制', extension: 'md' },
] as const;

export const EXPORT_KIND_LABEL: Record<ExportKind, string> = {
  pdf: 'PDF',
  xlsx: 'XLSX',
  png: 'PNG',
  json: 'JSON',
  markdown: 'Markdown',
};

/* ------------------------------------------------------------------ */
/* 内容模块                                                             */
/* ------------------------------------------------------------------ */

export interface ExportModuleDef {
  id: ExportModuleId;
  label: string;
  /** 简要说明（供专业设置提示）。 */
  hint: string;
}

export const EXPORT_MODULE_DEFS: readonly ExportModuleDef[] = [
  { id: 'projectInfo', label: '项目信息', hint: '项目名、源文件、时长、分辨率' },
  { id: 'rhythmCurve', label: '节奏曲线总览', hint: '全片节奏曲线图' },
  { id: 'outline', label: '结构大纲', hint: '章节 - 段落 - 镜头三级结构' },
  { id: 'shotTable', label: '分镜表', hint: '每个镜头一行，含时间码与代表画面' },
  { id: 'curveNodes', label: '曲线节点', hint: '曲线关键节点及其数值' },
  { id: 'annotations', label: '标注', hint: '标注列表（标题、时间、正文）' },
  { id: 'notes', label: '备注', hint: '结构单元与段落的备注' },
  { id: 'statistics', label: '统计数据', hint: '镜头数、平均镜头时长、节奏指标' },
] as const;

export const EXPORT_MODULE_LABEL: Record<ExportModuleId, string> = {
  projectInfo: '项目信息',
  rhythmCurve: '节奏曲线总览',
  outline: '结构大纲',
  shotTable: '分镜表',
  curveNodes: '曲线节点',
  annotations: '标注',
  notes: '备注',
  statistics: '统计数据',
};

/* ------------------------------------------------------------------ */
/* 分镜表字段                                                           */
/* ------------------------------------------------------------------ */

export interface ExportFieldDef {
  id: ExportFieldId;
  label: string;
  /** 建议列宽（Excel 字符宽度）。 */
  width: number;
  /** 是否图片字段（嵌入画面，不填路径）。 */
  image: boolean;
}

export const EXPORT_FIELD_DEFS: readonly ExportFieldDef[] = [
  { id: 'index', label: '镜头编号', width: 10, image: false },
  { id: 'frame', label: '代表画面', width: 22, image: true },
  { id: 'chapterName', label: '章', width: 16, image: false },
  { id: 'sectionName', label: '节', width: 16, image: false },
  { id: 'shotName', label: '镜头名称', width: 18, image: false },
  { id: 'startTime', label: '开始时间码', width: 15, image: false },
  { id: 'endTime', label: '结束时间码', width: 15, image: false },
  { id: 'duration', label: '持续时长', width: 12, image: false },
  { id: 'curveStart', label: '曲线起始值', width: 12, image: false },
  { id: 'curvePeak', label: '峰值', width: 10, image: false },
  { id: 'curveEnd', label: '结束值', width: 10, image: false },
  { id: 'annotationSummary', label: '标注摘要', width: 30, image: false },
  { id: 'note', label: '备注', width: 30, image: false },
] as const;

export const EXPORT_FIELD_LABEL: Record<ExportFieldId, string> = Object.fromEntries(
  EXPORT_FIELD_DEFS.map((def) => [def.id, def.label]),
) as Record<ExportFieldId, string>;

/** 分镜表默认字段顺序（含全部字段）。 */
export const DEFAULT_TABLE_FIELDS: ExportFieldId[] = EXPORT_FIELD_DEFS.map((def) => def.id);

/* ------------------------------------------------------------------ */
/* 画面质量                                                             */
/* ------------------------------------------------------------------ */

/** 质量档 → 期望最大宽度（再与源视频宽度取小）。 */
export const EXPORT_QUALITY_WIDTH: Record<ExportQualityId, number> = {
  standard: 960,
  high: 1920,
  max: 4096,
};

export const EXPORT_QUALITY_LABEL: Record<ExportQualityId, string> = {
  standard: '标准（约 960px 宽）',
  high: '高清（约 1920px 宽）',
  max: '最高（不高于源视频分辨率）',
};

/**
 * 解析代表画面输出宽度：质量档期望值 → 用户自选上限 → 源视频宽度，三者取最小。
 * maxWidth <= 0 表示"跟随质量档 / 源视频最高分辨率"。
 */
export function resolveFrameWidth(
  quality: ExportQualityId,
  maxWidth: number,
  sourceWidth: number,
): number {
  const source = sourceWidth > 0 ? sourceWidth : 1920;
  const byQuality = EXPORT_QUALITY_WIDTH[quality] ?? EXPORT_QUALITY_WIDTH.standard;
  const byChoice = maxWidth > 0 ? maxWidth : source;
  return Math.max(160, Math.min(byQuality, byChoice, source));
}

/* ------------------------------------------------------------------ */
/* 默认值                                                               */
/* ------------------------------------------------------------------ */

export const DEFAULT_FRAME_SETTINGS: ExportFrameSettings = {
  includeShotFrame: true,
  framePosition: 'middle',
  includeAnnotationFrames: false,
  includeCurveNodeFrames: false,
  quality: 'standard',
  // 0 = 跟随质量档与源视频宽度上限（即"支持导入视频最高分辨率"）。
  maxWidth: 0,
};

export const DEFAULT_TABLE_SETTINGS: ExportTableSettings = {
  fields: [...DEFAULT_TABLE_FIELDS],
};

export const DEFAULT_LAYOUT_SETTINGS: ExportLayoutSettings = {
  template: 'table',
  orientation: 'portrait',
  showHeader: true,
  showPageNumber: true,
  showProjectName: true,
};

export const DEFAULT_EXPORT_MODULES: ExportModuleId[] = [
  'projectInfo',
  'rhythmCurve',
  'outline',
  'shotTable',
  'curveNodes',
  'annotations',
  'notes',
  'statistics',
];

/* ------------------------------------------------------------------ */
/* 标准导出预设                                                          */
/* ------------------------------------------------------------------ */

/**
 * 标准导出之「阅读与分享（PDF）」：一份排版完整、可直接阅读/发送/打印的报告。
 * 包含项目信息、全片节奏曲线、三级结构、每镜头代表画面、时间码、标注与备注、
 * 重要曲线节点及对应画面。
 */
export const STANDARD_PDF_MODULES: ExportModuleId[] = [
  'projectInfo',
  'rhythmCurve',
  'outline',
  'shotTable',
  'curveNodes',
  'annotations',
  'notes',
];

export const STANDARD_PDF_FRAMES: ExportFrameSettings = {
  ...DEFAULT_FRAME_SETTINGS,
  includeShotFrame: true,
  includeCurveNodeFrames: true,
};

export const STANDARD_PDF_LAYOUT: ExportLayoutSettings = {
  ...DEFAULT_LAYOUT_SETTINGS,
  template: 'table',
  orientation: 'portrait',
};

/**
 * 标准导出之「继续整理（Excel）」：可继续编辑的 XLSX，默认含项目信息、
 * 分镜拉片表（每镜头一行并内嵌代表画面）、曲线节点、标注列表、结构大纲。
 */
export const STANDARD_XLSX_MODULES: ExportModuleId[] = [
  'projectInfo',
  'shotTable',
  'curveNodes',
  'annotations',
  'outline',
];

export const STANDARD_XLSX_FRAMES: ExportFrameSettings = {
  ...DEFAULT_FRAME_SETTINGS,
  includeShotFrame: true,
  includeCurveNodeFrames: false,
};

export const STANDARD_XLSX_LAYOUT: ExportLayoutSettings = {
  ...DEFAULT_LAYOUT_SETTINGS,
  template: 'table',
  orientation: 'landscape',
};

/** 构造一个标准导出请求（renderer 在用户点"阅读与分享"/"继续整理"后调用）。 */
export function buildStandardRequest(
  base: { projectId: string; snapshot: ProjectSnapshot; suggestedName: string; scope: ExportScope },
  kind: 'pdf' | 'xlsx',
): ExportRequest {
  const isPdf = kind === 'pdf';
  return {
    projectId: base.projectId,
    snapshot: base.snapshot,
    kinds: [kind],
    scope: base.scope,
    modules: isPdf ? [...STANDARD_PDF_MODULES] : [...STANDARD_XLSX_MODULES],
    frames: isPdf ? { ...STANDARD_PDF_FRAMES } : { ...STANDARD_XLSX_FRAMES },
    table: { fields: [...DEFAULT_TABLE_FIELDS] },
    layout: isPdf ? { ...STANDARD_PDF_LAYOUT } : { ...STANDARD_XLSX_LAYOUT },
    zip: false,
    suggestedName: base.suggestedName,
  };
}

/** 构造默认的"专业自定义"起点（以标准 PDF 为基础，便于继续微调）。 */
export function buildDefaultCustomRequest(
  base: { projectId: string; snapshot: ProjectSnapshot; suggestedName: string; scope: ExportScope },
): ExportRequest {
  return {
    ...buildStandardRequest(base, 'pdf'),
    modules: [...DEFAULT_EXPORT_MODULES],
    frames: { ...DEFAULT_FRAME_SETTINGS, includeShotFrame: true, includeCurveNodeFrames: true },
  };
}

/* ------------------------------------------------------------------ */
/* 范围与模板                                                           */
/* ------------------------------------------------------------------ */

/** 范围类型 → 中文名称（统一术语）。 */
export const EXPORT_SCOPE_LABEL: Record<ExportScopeKind, string> = {
  project: '整个项目',
  chapter: '当前章',
  section: '当前段落',
  shots: '选中镜头',
  timeRange: '自定义时间范围',
};

export function scopeKindOf(scope: ExportScope): ExportScopeKind {
  return scope.kind;
}

/** 从导出请求抽取可复用的个人模板（不含项目相关字段）。 */
export function toTemplate(
  request: ExportRequest,
  name: string,
  id: string,
): ExportTemplate {
  return {
    id,
    name,
    kinds: [...request.kinds],
    scopeKind: request.scope.kind,
    modules: [...request.modules],
    frames: { ...request.frames },
    table: { fields: [...request.table.fields] },
    layout: { ...request.layout },
    zip: request.zip,
  };
}

/** 应用模板到当前请求（范围具体节点保持当前会话的选择，不覆盖）。 */
export function applyTemplate(request: ExportRequest, template: ExportTemplate): ExportRequest {
  return {
    ...request,
    kinds: [...template.kinds],
    modules: [...template.modules],
    frames: { ...template.frames },
    table: { fields: [...template.table.fields] },
    layout: { ...template.layout },
    zip: template.zip,
    scope: { ...request.scope, kind: template.scopeKind },
  };
}