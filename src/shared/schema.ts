import { z } from 'zod';
import type {
  Annotation,
  Boundary,
  Curve,
  CurveHandle,
  CurveNode,
  ProjectMedia,
  ProjectSnapshot,
  ProjectView,
  Section,
  SegmentOutMode,
  StructureNode,
} from './api-types';
import { DEFAULT_STYLE } from './style';
import type { ProjectStyle } from './style';
import {
  buildLegacyStructure,
  createStructureNode,
  sortStructure,
  validateStructure,
  LEVEL_DEFAULT_COLOR,
  STRUCTURE_MAX_TAGS,
  STRUCTURE_NAME_MAX,
  STRUCTURE_NOTE_MAX,
  STRUCTURE_TAG_MAX,
} from './structure';

/**
 * project.json 的结构契约与不变量校验（规格 11.2 / 11.3）。
 *
 * 分层：
 * 1. zod schema 负责“结构与取值范围”（类型、长度上限、非负等）；
 * 2. validateProjectSnapshot 在 schema 通过后继续检查“集合级不变量”
 *    （时间单调、首尾端点、边界间隔、段落与边界一一对应、相对路径安全），
 *    zod 无法表达这类跨字段约束。
 *
 * 本模块无 Node / DOM 依赖，主进程、渲染层与 vitest 均可复用。
 * 编辑期的局部校验（如拖动节点后夹紧）在几何模块内部完成；本模块用于
 * “落盘前 / 打开前”的整体校验（规格 8.2 每次保存先通过 schema 校验）。
 */

/* ------------------------------------------------------------------ */
/* 取值范围常量（与规格一致，避免魔法数字散落）                            */
/* ------------------------------------------------------------------ */

export const SCHEMA_VERSION = 2;
export const CURVE_MIN = 0;
export const CURVE_MAX = 100;
/** 相邻节点最小时间差（规格 5.1）。 */
export const MIN_NODE_GAP_MS = 1;
/** 相邻边界最小间隔（规格 7.2）。 */
export const MIN_BOUNDARY_GAP_MS = 100;
export const ANNOTATION_TITLE_MAX = 80;
export const ANNOTATION_BODY_MAX = 5000;
export const PROJECT_NAME_MAX = 200;
/** 新建项目的默认可见窗口：只看片头，避免长视频把短段落挤成几像素（“适应全片”为独立按钮）。 */
export const DEFAULT_VIEW_WINDOW_MS = 120_000;
/** 时间线窗口迁移版本（§6.2）：标记"已按新的分钟级默认窗口处理过"。 */
export const TIMELINE_VIEW_VERSION = 1;

const FINITE = z.number().finite();
const SAFE_TIME_MS = z.number().int().nonnegative();

/* ------------------------------------------------------------------ */
/* 基础 schema                                                          */
/* ------------------------------------------------------------------ */

const frameRateSchema = z.object({
  num: z.number().int().positive(),
  den: z.number().int().positive(),
});

export const projectMediaSchema = z.object({
  id: z.string().min(1),
  originalName: z.string().min(1),
  sourcePath: z.string().min(1),
  playbackPath: z.string().min(1).nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 必须是 64 位小写十六进制'),
  sizeBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  videoCodec: z.string().min(1),
  audioCodec: z.string().min(1).nullable(),
  avgFrameRate: frameRateSchema,
  isVfr: z.boolean(),
  isHdr: z.boolean(),
});

const curveHandleSchema = z.object({
  dtMs: FINITE,
  dv: FINITE,
});

export const segmentOutModeSchema = z.enum(['linear', 'auto', 'bezier']);

export const curveNodeSchema = z.object({
  id: z.string().min(1),
  timeMs: SAFE_TIME_MS,
  value: FINITE,
  outMode: segmentOutModeSchema,
  inHandle: curveHandleSchema.nullable(),
  outHandle: curveHandleSchema.nullable(),
});

export const curveSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  nodes: z.array(curveNodeSchema).min(2),
});

export const annotationSchema = z.object({
  id: z.string().min(1),
  timeMs: SAFE_TIME_MS,
  title: z.string().max(ANNOTATION_TITLE_MAX),
  body: z.string().max(ANNOTATION_BODY_MAX),
  labelOffset: z.object({ x: FINITE, y: FINITE }),
});

export const boundarySchema = z.object({
  id: z.string().min(1),
  timeMs: SAFE_TIME_MS,
  fixed: z.boolean(),
  locked: z.boolean(),
});

export const sectionSchema = z.object({
  id: z.string().min(1),
  startBoundaryId: z.string().min(1),
  name: z.string(),
  note: z.string(),
});

/* 三级结构（schemaVersion 2）。作为可选字段以兼容尚未迁移的旧项目。 */
const structureLevelSchema = z.enum(['chapter', 'section', 'shot']);
const structureSourceSchema = z.enum(['manual', 'auto']);

export const structureNodeSchema = z.object({
  id: z.string().min(1),
  level: structureLevelSchema,
  parentId: z.string().min(1).nullable(),
  name: z.string().max(STRUCTURE_NAME_MAX),
  startMs: SAFE_TIME_MS,
  note: z.string().max(STRUCTURE_NOTE_MAX),
  narrativeRole: z.string().max(32),
  tags: z.array(z.string().max(STRUCTURE_TAG_MAX)).max(STRUCTURE_MAX_TAGS),
  color: z.string().min(1),
  locked: z.boolean(),
  coverTimeMs: SAFE_TIME_MS.nullable(),
  source: structureSourceSchema,
  confidence: z.number().min(0).max(1).nullable(),
});

export const projectViewSchema = z.object({
  playheadMs: SAFE_TIME_MS,
  viewStartMs: SAFE_TIME_MS,
  viewEndMs: SAFE_TIME_MS,
  videoVisible: z.boolean(),
  videoOpacity: FINITE,
  analysisVisible: z.boolean(),
  analysisOpacity: FINITE,
  analysisLocked: z.boolean(),
  annotationsVisible: z.boolean(),
  boundariesVisible: z.boolean(),
  playbackRate: FINITE,
  volume: FINITE,
  muted: z.boolean(),
  timelineHeight: FINITE,
  inspectorWidth: FINITE.optional(),
  /* 节奏台骨架（方案 §2）：左侧镜头索引栏 / 右侧检查器是否收起。可选以兼容旧项目。 */
  railCollapsed: z.boolean().optional(),
  inspectorCollapsed: z.boolean().optional(),
  /* 视图模式（方案 §2）：谱面视图（视频与曲线分开）/ 叠加视图（曲线覆盖视频）。 */
  canvasLayout: z.enum(['overlay', 'sheet']).optional(),
  /* 时间线窗口迁移版本（时间轨修复文档 §6.2）：可选以兼容旧项目。 */
  timelineViewVersion: z.number().int().positive().optional(),
});

/* 分析监视器样式（第一阶段）。作为可选字段以兼容旧项目（缺省按默认样式解析）。 */
export const stylePresetIdSchema = z.enum(['pro', 'mono', 'contrast', 'midnight']);
export const nodeShapeSchema = z.enum(['circle', 'diamond', 'rounded', 'hexagon', 'ring']);

export const projectStyleSchema = z.object({
  preset: stylePresetIdSchema,
  curve: z.object({
    width: FINITE,
    opacity: FINITE,
    halo: FINITE,
    lockedOpacity: FINITE,
  }),
  node: z.object({
    shape: nodeShapeSchema,
    size: FINITE,
    stroke: FINITE,
    color: z.union([z.string(), z.null()]),
    endpointShape: nodeShapeSchema,
  }),
  annotation: z.object({ color: z.string() }),
  grid: z.object({ visible: z.boolean(), opacity: FINITE }),
});

export const projectSnapshotSchema = z.object({
  schemaVersion: z.number().int().positive(),
  id: z.string().min(1),
  name: z.string().min(1).max(PROJECT_NAME_MAX),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  media: projectMediaSchema,
  curve: curveSchema,
  annotations: z.array(annotationSchema),
  boundaries: z.array(boundarySchema).min(2),
  sections: z.array(sectionSchema),
  structure: z.array(structureNodeSchema).optional(),
  style: projectStyleSchema.optional(),
  view: projectViewSchema,
});

/* ------------------------------------------------------------------ */
/* 编译期类型一致性检查（schema 推断必须能赋给 api-types 契约）             */
/* ------------------------------------------------------------------ */

const _mediaTypeCheck: ProjectMedia = {} as z.infer<typeof projectMediaSchema>;
const _curveNodeTypeCheck: CurveNode = {} as z.infer<typeof curveNodeSchema>;
const _handleTypeCheck: CurveHandle = {} as z.infer<typeof curveHandleSchema>;
const _outModeTypeCheck: SegmentOutMode = {} as z.infer<typeof segmentOutModeSchema>;
const _curveTypeCheck: Curve = {} as z.infer<typeof curveSchema>;
const _annotationTypeCheck: Annotation = {} as z.infer<typeof annotationSchema>;
const _boundaryTypeCheck: Boundary = {} as z.infer<typeof boundarySchema>;
const _sectionTypeCheck: Section = {} as z.infer<typeof sectionSchema>;
const _structureTypeCheck: StructureNode = {} as z.infer<typeof structureNodeSchema>;
const _viewTypeCheck: ProjectView = {} as z.infer<typeof projectViewSchema>;
const _styleTypeCheck: ProjectStyle = {} as z.infer<typeof projectStyleSchema>;
const _snapshotTypeCheck: ProjectSnapshot = {} as z.infer<typeof projectSnapshotSchema>;
void [
  _mediaTypeCheck,
  _curveNodeTypeCheck,
  _handleTypeCheck,
  _outModeTypeCheck,
  _curveTypeCheck,
  _annotationTypeCheck,
  _boundaryTypeCheck,
  _sectionTypeCheck,
  _structureTypeCheck,
  _viewTypeCheck,
  _styleTypeCheck,
  _snapshotTypeCheck,
];

/* ------------------------------------------------------------------ */
/* 路径安全（规格 11.3 / 9.2：解析后仍在项目根目录内）                     */
/* ------------------------------------------------------------------ */

/**
 * 校验“相对路径”不含穿越与绝对路径成分：
 * - 拒绝绝对路径（POSIX `/` 开头、Windows 盘符、UNC `\\`）；
 * - 拒绝 `..` 段（无论 `/` 或 `\` 分隔）；
 * - 允许 `media/source.mp4` 这类正斜杠相对路径（规格 9.2 统一 `/`）。
 */
export function isSafeProjectRelativePath(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(value) || value.startsWith('/') || value.startsWith('\\')) {
    return false;
  }
  const segments = value.split(/[\\/]+/);
  return segments.every((segment) => segment !== '..' && segment !== '');
}

/* ------------------------------------------------------------------ */
/* 不变量校验                                                           */
/* ------------------------------------------------------------------ */

export type ValidationResult =
  | { ok: true; snapshot: ProjectSnapshot }
  | { ok: false; issues: string[] };

function uniqueIds(prefix: string, ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      issues.push(`${prefix} ID 重复：${id}`);
    }
    seen.add(id);
  }
  return issues;
}

function includesId(ids: readonly string[], id: string): boolean {
  return ids.includes(id);
}

/**
 * 整体校验：结构（zod）→ 集合级不变量。
 * 返回 issues 列表供用户可见提示与测试断言；issues 为空即通过。
 */
export function validateProjectSnapshot(input: unknown): ValidationResult {
  const parsed = projectSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    });
    return { ok: false, issues };
  }
  const snapshot = parsed.data;
  const issues: string[] = [];

  const { media, curve, annotations, boundaries, sections, view } = snapshot;

  issues.push(...uniqueIds('曲线节点', curve.nodes.map((n) => n.id)));
  issues.push(...uniqueIds('标注', annotations.map((a) => a.id)));
  issues.push(...uniqueIds('边界', boundaries.map((b) => b.id)));
  issues.push(...uniqueIds('段落', sections.map((s) => s.id)));

  // —— 三级结构（存在时校验不变量；缺失表示尚未迁移的旧项目）——
  if (snapshot.structure !== undefined) {
    issues.push(...validateStructure(snapshot.structure, media.durationMs));
  }

  // —— 曲线：首尾时间、严格递增、值域、控制柄方向 ——
  const nodes = curve.nodes;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first !== undefined && first.timeMs !== 0) {
    issues.push('曲线首节点时间必须为 0。');
  }
  if (last !== undefined && last.timeMs !== media.durationMs) {
    issues.push('曲线末节点时间必须等于视频时长。');
  }
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node === undefined) {
      continue;
    }
    if (node.value < CURVE_MIN || node.value > CURVE_MAX) {
      issues.push(`节点 ${node.id} 的值超出 0—100。`);
    }
    if (node.outMode === 'bezier' && (node.outHandle === null || node.outHandle.dtMs < 0)) {
      issues.push(`节点 ${node.id} 为贝塞尔段但缺少有效出柄（dtMs ≥ 0）。`);
    }
    if (node.inHandle !== null && node.inHandle.dtMs > 0) {
      issues.push(`节点 ${node.id} 的入柄 dtMs 必须 ≤ 0。`);
    }
    const prev = nodes[i - 1];
    if (prev !== undefined) {
      const gap = node.timeMs - prev.timeMs;
      if (gap < MIN_NODE_GAP_MS) {
        issues.push(`节点 ${prev.id} 与 ${node.id} 的时间差不小于 ${MIN_NODE_GAP_MS}ms（实际 ${gap}）。`);
      }
    }
    // 控制点横向顺序：保证段内时间单调（规格 5.3 x0 ≤ c1x ≤ c2x ≤ x1）。
    if (node.outMode === 'bezier' && node.outHandle !== null) {
      const next = nodes[i + 1];
      const c1x = node.timeMs + node.outHandle.dtMs;
      const c2x = next !== undefined && next.inHandle !== null ? next.timeMs + next.inHandle.dtMs : c1x;
      if (c1x > c2x) {
        issues.push(`段 ${node.id} 的控制点横向顺序不单调（c1x > c2x）。`);
      }
    }
  }

  // —— 标注：时间在范围内且不重复 ——
  const annotationTimes = new Set<number>();
  for (const annotation of annotations) {
    if (annotation.timeMs > media.durationMs) {
      issues.push(`标注 ${annotation.id} 的时间超出视频时长。`);
    }
    if (annotationTimes.has(annotation.timeMs)) {
      issues.push(`同一毫秒只允许一个标注（${annotation.timeMs}ms 重复）。`);
    }
    annotationTimes.add(annotation.timeMs);
  }

  // —— 边界：固定首尾唯一、内部间隔、时间范围 ——
  const fixedBoundaries = boundaries.filter((b) => b.fixed);
  if (fixedBoundaries.length !== 2) {
    issues.push('边界必须且仅包含一个固定起点与一个固定终点。');
  }
  const startBoundary = boundaries.find((b) => b.fixed && b.timeMs === 0);
  const endBoundary = boundaries.find((b) => b.fixed && b.timeMs === media.durationMs);
  if (!startBoundary) {
    issues.push('缺少固定起点边界（timeMs = 0）。');
  }
  if (!endBoundary) {
    issues.push('缺少固定终点边界（timeMs = durationMs）。');
  }
  const sortedBoundaries = [...boundaries].sort((a, b) => a.timeMs - b.timeMs);
  for (let i = 1; i < sortedBoundaries.length; i++) {
    const prev = sortedBoundaries[i - 1];
    const curr = sortedBoundaries[i];
    if (prev === undefined || curr === undefined) {
      continue;
    }
    const gap = curr.timeMs - prev.timeMs;
    // 全片不足 100ms 时仅首尾边界可低于最小间隔（规格 11.3）。
    if (gap < MIN_BOUNDARY_GAP_MS && media.durationMs >= MIN_BOUNDARY_GAP_MS) {
      issues.push(`相邻边界间隔不小于 ${MIN_BOUNDARY_GAP_MS}ms（${prev.id} → ${curr.id} 为 ${gap}ms）。`);
    }
    if (gap <= 0) {
      issues.push(`边界 ${prev.id} 与 ${curr.id} 时间未严格递增。`);
    }
  }
  for (const boundary of boundaries) {
    if (boundary.timeMs > media.durationMs) {
      issues.push(`边界 ${boundary.id} 的时间超出视频时长。`);
    }
  }

  // —— 段落：与非终点边界一一对应，引用有效 ——
  const boundaryIds = boundaries.map((b) => b.id);
  const nonEndBoundaryIds = sortedBoundaries
    .filter((b) => b.id !== endBoundary?.id)
    .map((b) => b.id);
  const sectionStartIds = sections.map((s) => s.startBoundaryId);
  for (const section of sections) {
    if (!includesId(boundaryIds, section.startBoundaryId)) {
      issues.push(`段落 ${section.id} 引用了不存在的边界 ${section.startBoundaryId}。`);
    }
  }
  if (nonEndBoundaryIds.length !== sectionStartIds.length) {
    issues.push(
      `段落数（${sectionStartIds.length}）必须与“非终点边界”数（${nonEndBoundaryIds.length}）一致。`,
    );
  }
  for (const boundaryId of nonEndBoundaryIds) {
    if (!sectionStartIds.includes(boundaryId)) {
      issues.push(`边界 ${boundaryId} 缺少对应段落。`);
    }
  }

  // —— 相对路径安全 ——
  const paths: Array<[string, string]> = [['sourcePath', media.sourcePath]];
  if (media.playbackPath !== null) {
    paths.push(['playbackPath', media.playbackPath]);
  }
  for (const [label, value] of paths) {
    if (!isSafeProjectRelativePath(value)) {
      issues.push(`${label} 不是安全的项目内相对路径：${value}`);
    }
  }

  // —— view：可见区间与时长一致 ——
  if (view.viewStartMs >= view.viewEndMs) {
    issues.push('view.viewStartMs 必须小于 viewEndMs。');
  }
  if (view.viewEndMs > media.durationMs) {
    issues.push('view.viewEndMs 不得超出视频时长。');
  }
  if (view.videoOpacity < 0 || view.videoOpacity > 1) {
    issues.push('view.videoOpacity 必须在 0—1。');
  }
  if (view.analysisOpacity < 0 || view.analysisOpacity > 1) {
    issues.push('view.analysisOpacity 必须在 0—1。');
  }
  if (view.volume < 0 || view.volume > 1) {
    issues.push('view.volume 必须在 0—1。');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, snapshot };
}

/* ------------------------------------------------------------------ */
/* 初始快照工厂（新建项目时使用，规格 5.1 / 7.1 / 11.2）                   */
/* ------------------------------------------------------------------ */

export interface CreateInitialSnapshotInput {
  projectId: string;
  name: string;
  media: ProjectMedia;
  /** 曲线维度名，默认“情绪强度”（规格 5.1）。 */
  curveName?: string;
  now?: string;
}

const DEFAULT_CURVE_COLOR = '#F04B50';

/**
 * 构造默认快照：
 * - 曲线两个值为 50 的端点（0 / durationMs，水平线，outMode 'auto'）；
 * - 首尾固定边界 + 一个覆盖全片的默认段落；
 * - view 默认显示片头窗口（DEFAULT_VIEW_WINDOW_MS）、谱面视图、两层 100% 显示。
 * 返回未设置 revision 的结构由调用方决定（新建为 1）。
 */
export function createInitialSnapshot(input: CreateInitialSnapshotInput): ProjectSnapshot {
  const { projectId, name, media } = input;
  const now = input.now ?? new Date().toISOString();
  const durationMs = media.durationMs;

  const startNodeId = `${projectId}-node-start`;
  const endNodeId = `${projectId}-node-end`;
  const startBoundaryId = `${projectId}-boundary-start`;
  const endBoundaryId = `${projectId}-boundary-end`;
  const chapterId = `${projectId}-chapter-1`;
  const sectionId = `${projectId}-section-1`;

  const structure = sortStructure([
    createStructureNode({
      id: chapterId,
      level: 'chapter',
      parentId: null,
      name: '完整视频',
      startMs: 0,
      color: LEVEL_DEFAULT_COLOR.chapter,
    }),
    createStructureNode({
      id: sectionId,
      level: 'section',
      parentId: chapterId,
      name: '段落 1',
      startMs: 0,
      color: LEVEL_DEFAULT_COLOR.section,
    }),
    createStructureNode({
      id: `${sectionId}-shot-1`,
      level: 'shot',
      parentId: sectionId,
      name: '未划分镜头',
      startMs: 0,
      color: LEVEL_DEFAULT_COLOR.shot,
    }),
  ]);

  const view: ProjectView = {
    playheadMs: 0,
    viewStartMs: 0,
    // 默认只显示片头一段窗口（见 DEFAULT_VIEW_WINDOW_MS），短段落不再被挤成几像素。
    viewEndMs: Math.min(durationMs, DEFAULT_VIEW_WINDOW_MS),
    videoVisible: true,
    videoOpacity: 1,
    analysisVisible: true,
    analysisOpacity: 1,
    analysisLocked: false,
    annotationsVisible: true,
    boundariesVisible: true,
    playbackRate: 1,
    volume: 1,
    muted: false,
    timelineHeight: 350,
    /* 新建项目默认谱面视图（视频与曲线分开），视频保持干净。 */
    canvasLayout: 'sheet',
    /* 新项目窗口已按 DEFAULT_VIEW_WINDOW_MS 生成，标记为当前迁移版本（§6.2）。 */
    timelineViewVersion: TIMELINE_VIEW_VERSION,
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    id: projectId,
    name,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    media,
    curve: {
      id: `${projectId}-curve`,
      name: input.curveName ?? '情绪强度',
      color: DEFAULT_CURVE_COLOR,
      nodes: [
        { id: startNodeId, timeMs: 0, value: 50, outMode: 'auto', inHandle: null, outHandle: null },
        {
          id: endNodeId,
          timeMs: durationMs,
          value: 50,
          outMode: 'auto',
          inHandle: null,
          outHandle: null,
        },
      ],
    },
    annotations: [],
    boundaries: [
      { id: startBoundaryId, timeMs: 0, fixed: true, locked: true },
      { id: endBoundaryId, timeMs: durationMs, fixed: true, locked: true },
    ],
    sections: [{ id: `${projectId}-section-1`, startBoundaryId, name: '段落 1', note: '' }],
    structure,
    style: DEFAULT_STYLE,
    view,
  };
}

/* ------------------------------------------------------------------ */
/* schema 迁移（规格 3.3）                                               */
/* ------------------------------------------------------------------ */

/**
 * 是否需要把快照迁移到当前 schema 版本（缺三级结构或版本落后）。
 * 已含 structure 且版本不低于当前的快照为 false，保证“重复打开不会重复迁移”。
 */
export function needsStructureMigration(input: unknown): boolean {
  const candidate = input as { schemaVersion?: unknown; structure?: unknown };
  if (candidate.structure === undefined) {
    return true;
  }
  return typeof candidate.schemaVersion !== 'number' || candidate.schemaVersion < SCHEMA_VERSION;
}

/**
 * 迁移到当前版本：
 * - 已含三级结构且版本不落后 → 原样返回（幂等，不重复迁移）；
 * - 旧单层项目 → 生成三级结构（章节“完整视频” + 旧分段为段落 + 每段“未划分镜头”）；
 * - 曲线、标注、边界、视图与样式一律保持不变。
 */
export function migrateProjectSnapshot(snapshot: ProjectSnapshot): ProjectSnapshot {
  if (!needsStructureMigration(snapshot)) {
    return snapshot;
  }
  const structure =
    snapshot.structure ??
    buildLegacyStructure({
      projectId: snapshot.id,
      durationMs: snapshot.media.durationMs,
      boundaries: snapshot.boundaries,
      sections: snapshot.sections,
    });
  return { ...snapshot, schemaVersion: SCHEMA_VERSION, structure };
}
/* ------------------------------------------------------------------ */
/* 时间线视图窗口一次性迁移（时间轨修复文档 §6.2）                          */
/* ------------------------------------------------------------------ */

/**
 * 是否需要把"接近全片"的旧视图一次性迁移到以播放头为中心的 120 秒窗口。
 * 条件：无迁移版本 + 片长超过默认窗口 + 当前跨度接近完整时长（≥95%）。
 */
export function needsTimelineViewMigration(view: ProjectView, durationMs: number): boolean {
  if (view.timelineViewVersion !== undefined) {
    return false;
  }
  if (!(durationMs > DEFAULT_VIEW_WINDOW_MS)) {
    return false;
  }
  return view.viewEndMs - view.viewStartMs >= durationMs * 0.95;
}

/**
 * 迁移时间线窗口（幂等，只迁移一次）：
 * - 满足迁移条件：改为以已保存播放头为中心的 120 秒窗口，并写入迁移版本；
 * - 无需迁移（已有自定义缩放 / 短片）：仅补写迁移版本，窗口范围保持原样。
 */
export function migrateTimelineView(view: ProjectView, durationMs: number): ProjectView {
  if (!needsTimelineViewMigration(view, durationMs)) {
    return view.timelineViewVersion === undefined
      ? { ...view, timelineViewVersion: TIMELINE_VIEW_VERSION }
      : view;
  }
  const windowMs = DEFAULT_VIEW_WINDOW_MS;
  const maxStart = Math.max(0, durationMs - windowMs);
  const center = Math.min(Math.max(view.playheadMs, 0), durationMs);
  const start = Math.min(maxStart, Math.max(0, Math.round(center - windowMs / 2)));
  const end = Math.min(durationMs, start + windowMs);
  return { ...view, viewStartMs: start, viewEndMs: end, timelineViewVersion: TIMELINE_VIEW_VERSION };
}
