/**
 * 拉片台 renderer ↔ main 类型化 IPC 契约（规格 12.4 / 11.2）。
 *
 * 这是阶段 A 骨架最重要的产物：main 服务、renderer 页面、preload 桥三个方向
 * 的并行工程师都只依赖本文件（以及 ipc-channels.ts 的通道常量）。
 *
 * 约定：
 * - 所有 invoke 调用统一返回 `Result<T>`（ok/data 或 ok:false/error）。
 * - 文件与目录的真实路径永远不进入 renderer；系统选择器返回
 *   `FileSelectionToken`（opaque 字符串），由 main 侧令牌注册表兑换真实路径。
 * - 大视频与图片不通过 IPC 以完整 Base64 来回复制（规格 12.4）；
 *   媒体读取走 laipian-media: 自定义协议（阶段 A 后续实现）。
 */

import type { ProjectStyle } from './style';

/* ------------------------------------------------------------------ */
/* 统一返回类型                                                         */
/* ------------------------------------------------------------------ */

/** 面向创作者的错误信息：code 供程序分支，message 为人类可读中文，不暴露堆栈。 */
export interface LaipianError {
  code: string;
  message: string;
  /** true 表示调用方可以安全重试（如磁盘暂时占用）。 */
  retryable?: boolean;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: LaipianError };

/** 常用错误码。各服务可按需追加，但必须保持全局唯一与稳定。 */
export const ERROR_CODES = {
  /** 通道属于后续阶段交付，骨架占位实现。 */
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  /** renderer 传入的参数未通过 zod 校验。 */
  INVALID_PARAMS: 'INVALID_PARAMS',
  /** 用户主动取消（不算错误时优先返回 data: null，此码保留给强制中断场景）。 */
  CANCELLED: 'CANCELLED',
  /** main 内部未分类异常。 */
  INTERNAL: 'INTERNAL',
  /** 令牌无效、过期或已被消费。 */
  INVALID_TOKEN: 'INVALID_TOKEN',
  /** 该源视频此前已导入过（按源文件名 + 大小匹配），需要用户确认是否仍要新建。 */
  DUPLICATE_SOURCE: 'DUPLICATE_SOURCE',
} as const;

/** 运行时构造辅助：main handler 与 renderer 侧测试共用。 */
export const ok = <T>(data: T): Result<T> => ({ ok: true, data });

/** 运行时构造辅助：见 ERROR_CODES。 */
export const err = (
  code: string,
  message: string,
  retryable = false,
): Result<never> => ({ ok: false, error: { code, message, retryable } });

/* ------------------------------------------------------------------ */
/* 文件选择令牌（opaque）                                                */
/* ------------------------------------------------------------------ */

/**
 * 不透明令牌：由 main 的系统文件选择器（dialog）或已验证的拖入入口生成。
 * renderer 传来的任意字符串路径不自动获得访问权限（规格 12.4）。
 * 编译期 brand 防止把普通 string 误传给需要令牌的接口。
 */
declare const fileSelectionTokenBrand: unique symbol;
export type FileSelectionToken = string & {
  readonly [fileSelectionTokenBrand]: 'FileSelectionToken';
};

/** 令牌对应的入口类型，main 兑换时会校验 kind 匹配，防止视频令牌挪用作目录。 */
export type FileSelectionKind =
  | 'video-file'
  | 'project-dir'
  | 'open-project-folder';

/**
 * 选择视频的返回体（规格 2.3 步骤 1—2）：除一次性令牌外，附带供新建弹窗
 * 直接展示的视频元信息，避免用户"选完才知道是什么文件"。
 * 时长/画面比例来自 ffprobe（best-effort）：读取失败时为 null，UI 显示"—"，
 * 不阻断选择——真正导入时 main 会再次完整探测并给出明确错误。
 */
export interface VideoPickResult {
  token: FileSelectionToken;
  /** 源文件展示名（不含路径）。 */
  fileName: string;
  /** 源文件字节数；stat 失败时为 null。 */
  sizeBytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

/* ------------------------------------------------------------------ */
/* project.json 结构契约（规格 11.2）                                    */
/* ------------------------------------------------------------------ */

/** 相对项目的持久路径统一用 '/' 分隔（规格 9.2），读取时按宿主系统解析。 */
export type ProjectRelativePath = string;

/** 有理数帧率，如 30000/1001。den 必须为正整数。 */
export interface FrameRate {
  num: number;
  den: number;
}

/** 素材信息（project.json 的 media 字段）。 */
export interface ProjectMedia {
  id: string;
  /** 用户导入时的原始文件名（展示用，不含路径）。 */
  originalName: string;
  /** 项目内原片副本相对路径，如 "media/source.mp4"。 */
  sourcePath: ProjectRelativePath;
  /** 兼容副本相对路径（playback.webm）；未生成时为 null。 */
  playbackPath: ProjectRelativePath | null;
  /** 复制时后台流式计算的完整 SHA-256（十六进制小写）。 */
  sha256: string;
  sizeBytes: number;
  /** 标准视频时长（整数毫秒），是全项目唯一时间域。 */
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string;
  /** 无音频轨时为 null；不做假音轨（规格 10.2）。 */
  audioCodec: string | null;
  avgFrameRate: FrameRate;
  isVfr: boolean;
  isHdr: boolean;
}

/** 相对节点的时间/数值偏移。入柄 dtMs ≤ 0，出柄 dtMs ≥ 0（规格 11.2）。 */
export interface CurveHandle {
  dtMs: number;
  dv: number;
}

/** 段 [node[i], node[i+1]] 的模式由左节点 outMode 决定（规格 11.2）。 */
export type SegmentOutMode = 'linear' | 'auto' | 'bezier';

/** 曲线节点。timeMs 在曲线内严格递增；value ∈ [0,100]。 */
export interface CurveNode {
  id: string;
  timeMs: number;
  value: number;
  outMode: SegmentOutMode;
  inHandle: CurveHandle | null;
  outHandle: CurveHandle | null;
}

/** 唯一红色分析曲线（一个项目一条，规格 1.2）。 */
export interface Curve {
  id: string;
  name: string;
  color: string;
  nodes: CurveNode[];
}

/** 黄色标注点。纵向位置由曲线在该时间的值推导，不存高度（规格 6）。 */
export interface Annotation {
  id: string;
  timeMs: number;
  title: string;
  body: string;
  /** 标签在画布中的偏移（CSS 像素），重排时夹紧在画布内。 */
  labelOffset: { x: number; y: number };
}

/* ------------------------------------------------------------------ */
/* 三级结构（章节 / 段落 / 镜头，schemaVersion 2）                        */
/* ------------------------------------------------------------------ */

/** 固定三级层级（不做无限嵌套）。 */
export type StructureLevel = 'chapter' | 'section' | 'shot';

/** 创建来源：手动编辑或自动识别（硬切检测）。 */
export type StructureSource = 'manual' | 'auto';

/**
 * 结构单元（章节 / 段落 / 镜头统一表示）。
 *
 * 时间模型（共享边界，单一真值）：
 * - 只保存 startMs（唯一时间真值），endMs 由“下一个同级兄弟的 startMs”派生，
 *   最后一个兄弟的 end 等于其父级 end（顶层最后一个章节的 end 等于视频时长）；
 * - 相邻同级结构因此共享同一边界值，天然无缝隙、无重叠；
 * - 子级（段落/镜头）必须连续覆盖其父级范围（首个子 start = 父 start，
 *   末个子 end = 父 end），保证没有未覆盖空洞。
 */
export interface StructureNode {
  id: string;
  level: StructureLevel;
  /** 章节为 null；段落为所属 chapterId；镜头为所属 sectionId。 */
  parentId: string | null;
  name: string;
  /** 唯一时间真值（整数毫秒）。 */
  startMs: number;
  note: string;
  /** 叙事作用：钩子/交代/铺垫/冲突/转折/高潮/解释/收束/自定义，或空串。 */
  narrativeRole: string;
  tags: string[];
  /** 显示颜色（CSS 颜色字符串）。 */
  color: string;
  /** 锁定后禁止改变时间与父级，但仍可查看。 */
  locked: boolean;
  /** 代表帧时间（毫秒）；null 表示未指定，按导出规则推导。 */
  coverTimeMs: number | null;
  source: StructureSource;
  /** 自动识别置信度（0—1）；手动创建为 null。 */
  confidence: number | null;
}

/** 分段边界。首尾两个边界 fixed 且不可删除（规格 7）。 */
export interface Boundary {
  id: string;
  timeMs: number;
  /** 首尾边界为 true。端点身份由时间与顺序推导（规格 11.2）。 */
  fixed: boolean;
  locked: boolean;
}

/** 段落身份绑定起点边界 ID；终点由下一个边界推导（规格 11.2）。 */
export interface Section {
  id: string;
  startBoundaryId: string;
  name: string;
  note: string;
}

/** 项目视图状态：保存但不进入撤销历史（规格 12.3 第 2 层）。 */
export interface ProjectView {
  playheadMs: number;
  viewStartMs: number;
  viewEndMs: number;
  videoVisible: boolean;
  videoOpacity: number;
  analysisVisible: boolean;
  analysisOpacity: number;
  analysisLocked: boolean;
  annotationsVisible: boolean;
  boundariesVisible: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
  timelineHeight: number;
  /** 右侧检查器宽度（像素，方案 §4：默认 320 / 280–440）。旧项目缺省时按默认解析。 */
  inspectorWidth?: number;
  /** 节奏台骨架（方案 §2）：左侧镜头索引栏是否收起。旧项目缺省视为展开。 */
  railCollapsed?: boolean;
  /** 节奏台骨架（方案 §2）：右侧检查器是否收起。旧项目缺省视为展开。 */
  inspectorCollapsed?: boolean;
  /**
   * 视图模式（方案 §2）：
   * - overlay：曲线覆盖视频（直观分析）。
   * - sheet：视频与曲线分开的谱面视图（精细编辑）。
   * 两种视图共用同一套数据与选中状态，切换只改变显示方式。缺省视为 overlay。
   */
  canvasLayout?: ViewCanvasLayout;
}

/** 分析监视器视图模式（方案 §2）。 */
export type ViewCanvasLayout = 'overlay' | 'sheet';

/** project.json 的完整结构（规格 11.2）。schemaVersion 当前为 2。 */
export interface ProjectSnapshot {
  schemaVersion: number;
  id: string;
  name: string;
  revision: number;
  /** 带时区的 ISO 8601。 */
  createdAt: string;
  updatedAt: string;
  media: ProjectMedia;
  curve: Curve;
  annotations: Annotation[];
  boundaries: Boundary[];
  sections: Section[];
  /**
   * 三级结构（章节/段落/镜头）。schemaVersion 2 起必带；旧项目缺省时在打开链路
   * 迁移补齐。曲/标注/视图与既有 boundaries/sections 保持不变。
   */
  structure?: StructureNode[];
  /** 分析监视器样式（第一阶段）。旧项目缺省时按默认样式解析（规格：resolveStyle）。 */
  style?: ProjectStyle;
  view: ProjectView;
}

/* ------------------------------------------------------------------ */
/* 项目库 / 备份 / 任务 / 导出                                           */
/* ------------------------------------------------------------------ */

/**
 * 项目库卡片摘要（规格 2.2）。状态由素材检查结果推导（规格 2.4）：
 * - ready：可正常打开编辑。
 * - pending-compatible：原片已完整保存，等待兼容副本处理。
 * - missing：项目位置消失/素材缺失，提供重新定位或移除。
 */
export type ProjectCardStatus = 'ready' | 'pending-compatible' | 'missing';

export interface ProjectSummary {
  projectId: string;
  name: string;
  /** 源视频文件名（originalName）。 */
  sourceOriginalName: string;
  durationMs: number | null;
  /** 最近编辑时间（ISO 8601）。列表默认按此降序。 */
  lastEditedAt: string;
  status: ProjectCardStatus;
  /** laipian-media: 协议封面 URL；封面缺失时为 null。 */
  coverMediaUrl: string | null;
}

/** 备份条目（backups/project-r000120-时间.json，保留最近 5 份，规格 8.3）。 */
export interface BackupSummary {
  backupId: string;
  revision: number;
  createdAt: string;
  sizeBytes: number;
}

/** 后台任务种类（规格 10.4：复制/校验/探测/缩略图/转码/导出）。 */
export type TaskKind =
  | 'copy'
  | 'hash'
  | 'probe'
  | 'convert'
  | 'thumbnails'
  | 'shot-detect'
  | 'export';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * 进度来自真实输出，不做假倒计时（规格 10.4）：
 * - bytes：复制/哈希等有总量的任务（total 未知时为 null）。
 * - step：探测/试播等无可靠百分比时显示当前步骤名。
 */
export type TaskProgress =
  | { kind: 'bytes'; completedBytes: number; totalBytes: number | null }
  | { kind: 'step'; step: string };

/** main → renderer 的任务事件（经 tasks.subscribe 订阅）。 */
export interface TaskEvent {
  taskId: string;
  kind: TaskKind;
  status: TaskStatus;
  /** 任务不属于任何项目时为 null。 */
  projectId: string | null;
  progress: TaskProgress | null;
  /** 失败原因等人类可读信息；成功/运行中可为 null。 */
  message: string | null;
  /** ISO 8601。 */
  updatedAt: string;
}

export type ExportType = 'png' | 'markdown';

/**
 * 时间线帧带用的一张缩略图（规格 4）：时间点与受控媒体 URL。
 * 图片经 laipian-media: 协议读取，URL 只含 projectId/mediaId/文件名，不含真实路径。
 */
export interface TimelineThumbnail {
  timeMs: number;
  mediaUrl: string;
  width: number;
  height: number;
}

/**
 * 曲线节点对应的精确画面（规格 5.5）。
 * - requestedTimeMs：请求时间（clamp 到 [0, durationMs] 后的整数毫秒）。
 * - resolvedTimeMs：解码结果最接近的实际显示时间；VFR 下为解码返回的真实时间。
 * - frameNumber：仅在帧率可信（CFR）时为整数帧号，VFR 恒为 null（不伪造精确帧号）。
 */
export interface FramePreview {
  requestedTimeMs: number;
  resolvedTimeMs: number;
  frameNumber: number | null;
  mediaUrl: string;
}

/* ------------------------------------------------------------------ */
/* 各接口参数 / 返回体                                                   */
/* ------------------------------------------------------------------ */

/** 打开项目后的结果：快照 + 播放地址 + 素材状态（规格 2.4 / 9.3）。 */
export interface OpenedProject {
  projectId: string;
  snapshot: ProjectSnapshot;
  /** laipian-media: 播放 URL；素材缺失时为 null（此时仅可查看分析）。 */
  mediaUrl: string | null;
  /** 打开时按素材存在性推导的状态（规格 2.4）。 */
  status: ProjectCardStatus;
  /** 检测到比主文件更新的有效恢复快照时非空（规格 8.4：异常退出恢复）。 */
  recovery: RecoveryInfo | null;
}

/** 未提交的恢复快照信息（规格 8.4 / 11.1 recovery/）。 */
export interface RecoveryInfo {
  pendingId: string;
  revision: number;
  updatedAt: string;
}

export interface RestoreRecoveryParams {
  projectId: string;
  pendingId: string;
}

export interface CreateProjectParams {
  /** dialog.pickVideoFile() 返回的令牌。 */
  sourceSelectionToken: FileSelectionToken;
  /** 项目展示名；磁盘目录名由 main 过滤并附加短 UUID（规格 2.3）。 */
  name: string;
  /** dialog.pickProjectDir() 返回的保存位置令牌。 */
  destinationSelectionToken: FileSelectionToken;
  /**
   * 用户已确认"重复导入同一个视频仍要新建"时为 true。
   * 缺省（false）时，main 检测到与已有项目同名同大小即返回 DUPLICATE_SOURCE，
   * 由 renderer 弹确认对话框后再带本标记重试（规格 2 重复导入）。
   */
  allowDuplicate?: boolean;
}

/** 重复导入预检参数：源视频展示名 + 字节大小（均来自 VideoPickResult）。 */
export interface CheckDuplicateParams {
  fileName: string;
  sizeBytes: number;
}

export interface CheckDuplicateResult {
  /** 命中已有项目时返回其 id 与名称；无重复为 null。 */
  duplicate: { projectId: string; name: string } | null;
}

export interface OpenProjectParams {
  /** dialog.pickOpenProjectFolder() 返回的令牌。 */
  projectSelectionToken: FileSelectionToken;
}

export interface RenameProjectParams {
  projectId: string;
  name: string;
}

export interface SaveProjectParams {
  projectId: string;
  /** 乐观锁：只允许在期望 revision 上落盘，冲突时停止覆盖并提示（规格 12.4）。 */
  expectedRevision: number;
  snapshot: ProjectSnapshot;
}

export interface ProjectIdParams {
  projectId: string;
}

export interface RestoreBackupParams {
  projectId: string;
  backupId: string;
}

export interface RelocateSourceParams {
  projectId: string;
  /** 重新定位只接受 SHA-256 一致的同一素材（规格 9.3）。 */
  sourceSelectionToken: FileSelectionToken;
}

export interface CancelTaskParams {
  taskId: string;
}

/** 时间线缩略图列表请求（规格 4.4）。 */
export type ListThumbnailsParams = ProjectIdParams;

/** 精确画面帧请求（规格 5.5）；timeMs 会被 main 侧 clamp 到 [0, durationMs]。 */
export interface FramePreviewParams {
  projectId: string;
  timeMs: number;
  width: number;
  height: number;
}

/**
 * 时间线画面帧带批处理请求（本轮重构）：一次 ffmpeg 按可视范围抽一批等间隔帧。
 * count 为期望帧数（渲染层按"帧宽固定"规划得出），main 侧归一化并受队列并发限制。
 */
export interface FilmstripBatchParams {
  projectId: string;
  startMs: number;
  endMs: number;
  count: number;
  width: number;
  height: number;
}

/** 批处理返回的单帧：时间点 + 受控 URL（不含真实路径）。 */
export interface FilmstripFrame {
  index: number;
  timeMs: number;
  mediaUrl: string;
}

/** 智能镜头识别（硬切检测）参数：灵敏度阈值 + 最短镜头长度。 */
export interface DetectShotsParams {
  projectId: string;
  /** scdet 阈值：保守 14 / 标准 10 / 灵敏 8。 */
  threshold: number;
  /** 最短镜头长度（毫秒）：距离小于该值的两个切点只保留分数更高者。 */
  minShotMs: number;
}

/** 单个硬切检测结果（时间转换为整数毫秒）。 */
export interface DetectedCut {
  timeMs: number;
  score: number;
}

/**
 * 局部（选中区域）镜头识别参数：在 [inMs, outMs) 内做硬切检测。
 * 与全片 detectShots 分开，避免重复扫描整段视频。
 */
export interface ShotRangeParams {
  projectId: string;
  /** scdet 阈值：保守 14 / 标准 10 / 灵敏 8。 */
  threshold: number;
  /** 最短镜头长度（毫秒）。 */
  minShotMs: number;
  /** 选区起点（全局毫秒，含）。 */
  inMs: number;
  /** 选区终点（全局毫秒，不含）。 */
  outMs: number;
}

/**
 * 导出保存（规格 13）。payload：
 * - markdown：纯文本 Markdown 内容。
 * - png：renderer 生成的 PNG data URL（一次性、≤2400px 宽，不涉及大视频流）。
 * 取消不算错误：返回 data 为 null。
 */
export interface ExportSaveParams {
  suggestedName: string;
  type: ExportType;
  payload: string;
}

/* ------------------------------------------------------------------ */
/* 导出中心（v0.9：标准导出 + 专业自定义）                                */
/*                                                                     */
/* 设计原则：                                                           */
/* - 标准导出只让用户选 2 件事：PDF/Excel + 范围；其余用合理默认值；      */
/* - 专业自定义在标准导出下方，暴露范围/模块/画面/字段/排版/输出格式；      */
/* - 只有当用户同时选多个输出格式时，才询问是否合并为 ZIP；                 */
/* - 所有导出在本地完成，不上传视频或画面。                                */
/* ------------------------------------------------------------------ */

/** 导出产物格式（使用常见格式，不包装新术语）。 */
export type ExportKind = 'pdf' | 'xlsx' | 'png' | 'json' | 'markdown';

/** 导出范围类型。 */
export type ExportScopeKind = 'project' | 'chapter' | 'section' | 'shots' | 'timeRange';

/** 导出范围：整个项目 / 当前章 / 当前段落 / 选中镜头 / 自定义时间范围。 */
export interface ExportScope {
  kind: ExportScopeKind;
  /** chapter/section/shots：目标结构节点 id（shots 可多个）。 */
  nodeIds?: string[];
  /** timeRange：自定义区间（毫秒，含首不含尾）。 */
  startMs?: number;
  endMs?: number;
}

/** 分镜表可选字段（顺序即列序，可拖拽调整）。 */
export type ExportFieldId =
  | 'index'
  | 'frame'
  | 'chapterName'
  | 'sectionName'
  | 'shotName'
  | 'startTime'
  | 'endTime'
  | 'duration'
  | 'curveStart'
  | 'curvePeak'
  | 'curveEnd'
  | 'annotationSummary'
  | 'note';

/** 内容模块（可多选）。 */
export type ExportModuleId =
  | 'projectInfo'
  | 'rhythmCurve'
  | 'outline'
  | 'shotTable'
  | 'curveNodes'
  | 'annotations'
  | 'notes'
  | 'statistics';

/** 代表画面取样位置：已有封面帧 / 首帧 / 中间帧 / 尾帧。 */
export type ExportFramePosition = 'cover' | 'first' | 'middle' | 'last';

/** 画面质量档（决定最大边长与 JPEG 质量）。 */
export type ExportQualityId = 'standard' | 'high' | 'max';

/** 画面设置。 */
export interface ExportFrameSettings {
  /** 每个镜头一张代表画面。 */
  includeShotFrame: boolean;
  /** 代表画面取样位置（默认中间帧，避开硬切瞬间）。 */
  framePosition: ExportFramePosition;
  /** 标注时间点画面。 */
  includeAnnotationFrames: boolean;
  /** 曲线节点对应画面。 */
  includeCurveNodeFrames: boolean;
  quality: ExportQualityId;
  /** 输出画面最大宽度（像素）；不得超过源视频宽度（导入视频最高分辨率）。 */
  maxWidth: number;
}

/** 表格字段设置。 */
export interface ExportTableSettings {
  /** 分镜表字段顺序（也即表头列顺序）。 */
  fields: ExportFieldId[];
}

/** 排版方式：标准表格式 / 图片展示式 / 紧凑打印式。 */
export type ExportLayoutTemplate = 'table' | 'gallery' | 'compact';

/** 页面方向。 */
export type ExportOrientation = 'portrait' | 'landscape';

/** 排版设置。 */
export interface ExportLayoutSettings {
  template: ExportLayoutTemplate;
  orientation: ExportOrientation;
  /** 显示页眉。 */
  showHeader: boolean;
  /** 显示页码。 */
  showPageNumber: boolean;
  /** 显示项目名称。 */
  showProjectName: boolean;
}

/** 完整导出请求（标准导出会填充合理默认值）。 */
export interface ExportRequest {
  projectId: string;
  /** 当前编辑状态快照（导出前已保存，保证与曲线/标注/三级结构一致）。 */
  snapshot: ProjectSnapshot;
  kinds: ExportKind[];
  scope: ExportScope;
  modules: ExportModuleId[];
  frames: ExportFrameSettings;
  table: ExportTableSettings;
  layout: ExportLayoutSettings;
  /** 多个产物时是否合并为 ZIP 压缩文件。 */
  zip: boolean;
  /** 建议文件名基名（main 侧再过滤非法字符并补扩展名）。 */
  suggestedName: string;
}

/** 单条导出产物。 */
export interface ExportProduct {
  path: string;
  kind: ExportKind;
  sizeBytes: number;
}

export interface ExportStartResult {
  taskId: string;
}

/** 导出前预览：预计页数与文件大小。 */
export interface ExportEstimate {
  /** 大致页数（仅 PDF）。 */
  pages: number;
  /** 大致文件大小（字节）。 */
  bytes: number;
  /** 产物数量（文件数）。 */
  fileCount: number;
  /** 将包含的画面数（估算）。 */
  frameCount: number;
}

/** 预览估算入参（不含 snapshot 时用快照推断，含则精确）。 */
export interface ExportEstimateParams {
  snapshot: ProjectSnapshot;
  kinds: ExportKind[];
  scope: ExportScope;
  modules: ExportModuleId[];
  frames: ExportFrameSettings;
  table: ExportTableSettings;
  layout: ExportLayoutSettings;
}

/** 可复用的专业导出模板（跨项目保存于应用设置）。 */
export interface ExportTemplate {
  id: string;
  name: string;
  kinds: ExportKind[];
  /** 只保存范围类型，不保存具体节点 id（跨项目不可移植）。 */
  scopeKind: ExportScopeKind;
  modules: ExportModuleId[];
  frames: ExportFrameSettings;
  table: ExportTableSettings;
  layout: ExportLayoutSettings;
  zip: boolean;
}

/* ------------------------------------------------------------------ */
/* 类型化 API 契约（preload 暴露 window.laipian）                         */
/* ------------------------------------------------------------------ */

/**
 * renderer 可见的全部能力（规格 12.4 全量方法 + 文件选择入口）。
 * preload 通过 contextBridge 以同名结构暴露；后续阶段逐个填充真实实现。
 */
export interface LaipianApi {
  app: {
    /** 用户点击系统关闭按钮时，由 main 请求 renderer 先完成保存。 */
    onCloseRequested(listener: () => void): () => void;
    /** renderer 确认保存成功后，允许 main 真正关闭窗口。 */
    confirmClose(): Promise<Result<null>>;
  };
  /** 系统文件/目录选择入口，全部返回一次性令牌；用户取消返回 data: null。 */
  dialog: {
    /**
     * 选择单条视频：.mp4 .mov .m4v .webm .mkv（规格 10.1）。
     * 返回令牌 + 视频元信息（名称/大小/时长/画面比例），供新建弹窗预览。
     */
    pickVideoFile(): Promise<Result<VideoPickResult | null>>;
    /** 选择新建项目的保存位置（可创建目录）。 */
    pickProjectDir(): Promise<Result<FileSelectionToken | null>>;
    /** 选择已存在的项目文件夹（打开项目文件夹入口）。 */
    pickOpenProjectFolder(): Promise<Result<FileSelectionToken | null>>;
  };

  projects: {
    listRecent(): Promise<Result<ProjectSummary[]>>;
    /** 创建项目：快速返回 projectId，复制/探测在后台任务中进行（规格 2.4）。 */
    create(params: CreateProjectParams): Promise<Result<{ projectId: string }>>;
    /**
     * 重复导入预检（规格 2 重复导入）：按源文件名 + 大小查询是否已导入过。
     * 不消费选择令牌（只是查询），供新建弹窗在提交前弹确认对话框。
     */
    checkDuplicate(params: CheckDuplicateParams): Promise<Result<CheckDuplicateResult>>;
    open(params: OpenProjectParams): Promise<Result<OpenedProject>>;
    /** 按 projectId 打开最近项目（规格 2.1：最近项目 → 分析工作台）。 */
    openRecent(params: ProjectIdParams): Promise<Result<OpenedProject>>;
    rename(params: RenameProjectParams): Promise<Result<null>>;
    save(params: SaveProjectParams): Promise<Result<{ revision: number }>>;
    listBackups(params: ProjectIdParams): Promise<Result<BackupSummary[]>>;
    restoreBackup(params: RestoreBackupParams): Promise<Result<ProjectSnapshot>>;
    /** 恢复异常退出留下的未提交快照（恢复前保留原版本，规格 8.4）。 */
    restoreRecovery(params: RestoreRecoveryParams): Promise<Result<ProjectSnapshot>>;
    /** 放弃未提交快照（删除 recovery 文件）。 */
    discardRecovery(params: RestoreRecoveryParams): Promise<Result<null>>;
    /** 仅移除应用内最近索引，不删除磁盘内容（规格 2.2）。 */
    removeRecent(params: ProjectIdParams): Promise<Result<null>>;
    /** 在系统文件管理器中显示项目文件夹。 */
    reveal(params: ProjectIdParams): Promise<Result<null>>;
    /** 返回项目库前关闭项目：注销媒体注册、释放项目锁（规格 8.4 / 8.5）。 */
    close(params: ProjectIdParams): Promise<Result<null>>;
  };

  media: {
    probe(params: ProjectIdParams): Promise<Result<ProjectMedia>>;
    /** 启动兼容副本转换（WebM/VP8/Opus，规格 10.2），返回任务 ID。 */
    createCompatibleCopy(params: ProjectIdParams): Promise<Result<{ taskId: string }>>;
    rebuildThumbnails(params: ProjectIdParams): Promise<Result<{ taskId: string }>>;
    relocateSource(params: RelocateSourceParams): Promise<Result<null>>;
    /** 列出已生成的时间线缩略图（时间点 + 受控 URL）；无缓存时返回空数组。 */
    listThumbnails(params: ListThumbnailsParams): Promise<Result<TimelineThumbnail[]>>;
    /** 解析指定时间的精确画面帧（ffmpeg 抽帧 + 缓存），供节点联动显示（规格 5.5）。 */
    getFramePreview(params: FramePreviewParams): Promise<Result<FramePreview>>;
    /**
     * 时间线画面帧带（应用级队列批处理）：一次抽取可视范围的等间隔帧。
     * 结果驱动"视频画面轨"渲染；同项目新的可视请求会取消旧任务并终止其 ffmpeg。
     */
    filmstrip(params: FilmstripBatchParams): Promise<Result<FilmstripFrame[]>>;
    /** 取消本项目所有在途/排队的画面帧任务（渲染层切换项目或卸载时调用）。 */
    cancelFilmstrip(params: ProjectIdParams): Promise<Result<null>>;
    /** 启动智能镜头识别（scdet 硬切检测，后台任务）；立即返回 taskId，结果写缓存。 */
    detectShots(params: DetectShotsParams): Promise<Result<{ taskId: string }>>;
    /** 读取已缓存的镜头识别结果（相同参数命中缓存）；无缓存返回 data: null。 */
    readDetectedCuts(params: DetectShotsParams): Promise<Result<DetectedCut[] | null>>;
    /** 启动“选中区域”局部镜头识别（只分析 [inMs,outMs)）；立即返回 taskId，结果写范围缓存。 */
    detectShotsRange(params: ShotRangeParams): Promise<Result<{ taskId: string }>>;
    /** 读取局部识别结果（同范围命中缓存）；无缓存返回 data: null。 */
    readDetectedCutsRange(params: ShotRangeParams): Promise<Result<DetectedCut[] | null>>;
  };

  tasks: {
    /**
     * 订阅后台任务事件（进度/状态/取消）。preload 用 ipcRenderer.on 转发；
     * 返回取消订阅函数。渲染层挂载时订阅、卸载时退订。
     */
    subscribe(listener: (event: TaskEvent) => void): () => void;
    /** 页面挂载时补齐该项目已发生的任务事件（避免错过早期进度而卡死）。 */
    snapshot(params: ProjectIdParams): Promise<Result<TaskEvent[]>>;
    cancel(params: CancelTaskParams): Promise<Result<null>>;
  };

  exports: {
    /** 弹出原生保存对话框并写文件；用户取消返回 data: null（规格 13）。 */
    save(params: ExportSaveParams): Promise<Result<{ savedPath: string } | null>>;
    /**
     * 启动导出后台任务（标准导出 / 专业自定义共用）。立即返回 taskId，
     * 进度与终态经 tasks 事件推送（可取消）。完成产物用 products 查询。
     * 用户在保存对话框取消时返回 data: null（不算错误）。
     */
    start(params: ExportRequest): Promise<Result<ExportStartResult | null>>;
    /** 查询某导出任务已完成的产物列表（未完成时返回空数组）。 */
    products(params: { taskId: string }): Promise<Result<ExportProduct[]>>;
    /** 在系统文件管理器中显示导出产物（仅限本会话已生成的产物路径）。 */
    reveal(params: { path: string }): Promise<Result<null>>;
    /** 用系统默认程序打开导出产物（仅限本会话已生成的产物路径）。 */
    open(params: { path: string }): Promise<Result<null>>;
  };

  settings: {
    /** 读取应用级设置（全局，跨项目）。文件缺失/损坏时返回默认设置。 */
    get(): Promise<Result<AppSettings>>;
    /** 写入应用级设置（main 侧再次校验，非法键位条目丢弃）。 */
    set(params: SettingsSetParams): Promise<Result<AppSettings>>;
  };
}

/** 应用级设置（全局，跨项目保存于 userData/settings.json）。 */
export interface AppSettings {
  /** 快捷键覆盖：命令 id → 规范化键位字符串（只存与默认不同的项）。 */
  keymap: Record<string, string>;
  /** 专业导出模板（用户保存后可跨项目复用）。 */
  exportTemplates?: ExportTemplate[];
}

export interface SettingsSetParams {
  settings: AppSettings;
}

/* ------------------------------------------------------------------ */
/* 全局对象声明                                                          */
/* ------------------------------------------------------------------ */

declare global {
  interface Window {
    /**
     * preload 注入的窄接口（contextBridge.exposeInMainWorld('laipian', ...)）。
     * 可选类型：浏览器预览模式（纯 UI 开发，无 Electron）下不存在，
     * renderer 必须先检测再使用，不得让页面崩溃。
     */
    laipian?: LaipianApi;
  }
}
