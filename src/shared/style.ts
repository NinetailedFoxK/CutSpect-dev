/**
 * 分析监视器样式模型（第一阶段：专业调色台风格）。
 *
 * 样式是项目数据的一部分（随 project.json 保存、进入撤销历史），
 * 与「视图状态」（图层开关、干净预览）分离：后者只改变显示，不写入内容。
 *
 * 第一版只提供四套经过设计的预设；不做自由主题系统，
 * 用户图片/视觉徽章留到第二阶段（作为节点附加徽章，不替代控制点）。
 */

export type StylePresetId = 'pro' | 'mono' | 'contrast' | 'midnight';

/** 节点形状（第一阶段预设；不含星形/爱心等装饰形状，避免削弱专业感）。 */
export type NodeShape = 'circle' | 'diamond' | 'rounded' | 'hexagon' | 'ring';

export const NODE_SHAPES: readonly NodeShape[] = ['circle', 'diamond', 'rounded', 'hexagon', 'ring'];

/** 曲线线型与状态（规格第四点：普通 / 悬停 / 选中 / 锁定 / 隐藏）。 */
export interface CurveStyle {
  /** 主线粗细（px）。 */
  width: number;
  /** 主线透明度（0—1）。 */
  opacity: number;
  /** 辅助光晕透明度（0—1，约 7px 宽，让曲线在复杂画面上仍然清晰）。 */
  halo: number;
  /** 锁定时的整体透明度（规格：降到约 65%）。 */
  lockedOpacity: number;
}

/** 节点外观（规格第五 / 六点）。 */
export interface NodeStyle {
  shape: NodeShape;
  /** 节点直径（px）。 */
  size: number;
  /** 描边粗细（px）。 */
  stroke: number;
  /** 节点描边颜色；null 表示跟随曲线颜色。 */
  color: string | null;
  /** 首尾端点形状（默认圆角方形，不能只靠颜色区分）。 */
  endpointShape: NodeShape;
}

/** 标注外观（规格第八点：与曲线节点明显不同）。 */
export interface AnnotationStyle {
  color: string;
}

/** 网格外观（规格第十一点：只辅助判断高度，不抢画面）。 */
export interface GridStyle {
  visible: boolean;
  /** 主线透明度（0—1）。 */
  opacity: number;
}

export interface ProjectStyle {
  preset: StylePresetId;
  curve: CurveStyle;
  node: NodeStyle;
  annotation: AnnotationStyle;
  grid: GridStyle;
}

export interface StylePreset {
  label: string;
  description: string;
  /** 应用预设时同步写入的曲线颜色（曲线颜色本身是曲线数据 curve.color）。 */
  curveColor: string;
  style: ProjectStyle;
}

export const STYLE_PRESETS: Readonly<Record<StylePresetId, StylePreset>> = {
  pro: {
    label: '专业默认',
    description: '红色曲线 · 深色空心节点 · 黄色标注 · 无明显发光',
    curveColor: '#FF4D5A',
    style: {
      preset: 'pro',
      curve: { width: 3, opacity: 1, halo: 0.12, lockedOpacity: 0.65 },
      node: { shape: 'circle', size: 10, stroke: 2, color: null, endpointShape: 'rounded' },
      annotation: { color: '#FFC44D' },
      grid: { visible: true, opacity: 0.08 },
    },
  },
  mono: {
    label: '极简白',
    description: '白色曲线 · 白色圆环节点 · 灰色标注',
    curveColor: '#F1F3F6',
    style: {
      preset: 'mono',
      curve: { width: 3, opacity: 1, halo: 0.1, lockedOpacity: 0.6 },
      node: { shape: 'ring', size: 10, stroke: 2, color: null, endpointShape: 'rounded' },
      annotation: { color: '#8B93A1' },
      grid: { visible: true, opacity: 0.06 },
    },
  },
  contrast: {
    label: '高对比',
    description: '亮红曲线 · 更粗描边 · 节点略大 · 标签更醒目',
    curveColor: '#FF3B47',
    style: {
      preset: 'contrast',
      curve: { width: 3.5, opacity: 1, halo: 0.18, lockedOpacity: 0.7 },
      node: { shape: 'circle', size: 12, stroke: 2.5, color: null, endpointShape: 'rounded' },
      annotation: { color: '#FFD24D' },
      grid: { visible: true, opacity: 0.12 },
    },
  },
  midnight: {
    label: '深夜蓝',
    description: '蓝紫曲线 · 青色节点 · 暖黄标注',
    curveColor: '#8B7BFF',
    style: {
      preset: 'midnight',
      curve: { width: 3, opacity: 1, halo: 0.14, lockedOpacity: 0.65 },
      node: { shape: 'circle', size: 10, stroke: 2, color: '#5BD69A', endpointShape: 'rounded' },
      annotation: { color: '#FFB74D' },
      grid: { visible: true, opacity: 0.08 },
    },
  },
};

export const PRESET_ORDER: readonly StylePresetId[] = ['pro', 'mono', 'contrast', 'midnight'];

/** 默认样式：新项目与未保存 style 的旧项目共用。 */
export const DEFAULT_STYLE: ProjectStyle = STYLE_PRESETS.pro.style;

/** 部分样式（旧项目、或局部覆盖用）。 */
export interface PartialProjectStyle {
  preset?: StylePresetId;
  curve?: Partial<CurveStyle>;
  node?: Partial<NodeStyle>;
  annotation?: Partial<AnnotationStyle>;
  grid?: Partial<GridStyle>;
}

/** 合并（部分）已保存样式与默认，缺失字段用默认补齐（旧项目兼容）。 */
export function resolveStyle(style?: PartialProjectStyle | null): ProjectStyle {
  if (!style) {
    return DEFAULT_STYLE;
  }
  const base = DEFAULT_STYLE;
  return {
    preset: style.preset ?? base.preset,
    curve: { ...base.curve, ...style.curve },
    node: { ...base.node, ...style.node },
    annotation: { ...base.annotation, ...style.annotation },
    grid: { ...base.grid, ...style.grid },
  };
}