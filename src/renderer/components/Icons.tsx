/**
 * 拉片台 · 统一图标组件（V2 图标系统接入）
 *
 * - 数据来源：src/renderer/components/icon-data.ts（由 scripts/gen-icons.mjs 从
 *   src/renderer/assets/icons/*.svg 生成）。图标为 24×24、currentColor、1.7 描边。
 * - 统一用 CSS 控制颜色与尺寸，不修改 SVG 内部颜色。
 * - 默认 aria-hidden；纯图标按钮由按钮提供 aria-label（见 IconButton）。
 * - 图标不存在时：开发环境告警，生产环境回退 help-circle，绝不渲染空白。
 *
 * 具名包装（IconBack 等）为兼容既有调用点而保留；新增代码建议直接用 <Icon name="…" />。
 */
import type { ButtonHTMLAttributes, SVGProps } from 'react';
import { ICONS, ICON_LABELS, ICON_SHORTCUTS } from './icon-data';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name?: string;
  /** 显示尺寸（正方形边长，px）。默认 18。 */
  size?: number;
  /** 无障碍名称；传入时设为 role=img + aria-label，否则 aria-hidden。 */
  title?: string;
}

const FALLBACK = 'help-circle';

export function Icon({ name = FALLBACK, size = 18, title, className, ...rest }: IconProps) {
  const def = ICONS[name] ?? ICONS[FALLBACK];
  if (ICONS[name] === undefined && import.meta.env?.DEV) {
    console.warn(`[icons] 未找到图标：${name}（已回退 ${FALLBACK}）`);
  }
  if (def === undefined) {
    return null;
  }
  return (
    <svg
      viewBox={def.viewBox}
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
      {...rest}
      dangerouslySetInnerHTML={{ __html: def.body }}
    />
  );
}

/** 图标按钮：统一状态与无障碍（图标由按钮提供名称）。 */
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: string;
  /** 动作中文名（aria-label / 工具提示的主文案）。 */
  label: string;
  /** 快捷键（可选，工具提示格式「动作名（快捷键）」）。 */
  shortcut?: string;
  /** 危险色（删除等不可逆动作）。 */
  danger?: boolean;
  /** 选中态（模式 / 显示开关）。 */
  selected?: boolean;
  size?: number;
}

export function IconButton({
  icon,
  label,
  shortcut,
  danger = false,
  selected = false,
  size = 18,
  className,
  ...rest
}: IconButtonProps) {
  const title = shortcut ? `${label}（${shortcut}）` : label;
  const classes = [
    'lp-icon-button',
    danger ? 'is-danger' : '',
    selected ? 'is-selected' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      aria-label={label}
      aria-pressed={selected ? true : undefined}
      title={title}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

/* ---------------- 具名包装（兼容既有调用点） ---------------- */

type WrappedProps = Omit<IconProps, 'name'>;

export const IconBack = (p: WrappedProps) => <Icon name="arrow-left" {...p} />;
export const IconArrowRight = (p: WrappedProps) => <Icon name="arrow-right" {...p} />;
export const IconUndo = (p: WrappedProps) => <Icon name="undo" {...p} />;
export const IconRedo = (p: WrappedProps) => <Icon name="redo" {...p} />;
export const IconKeyboard = (p: WrappedProps) => <Icon name="keyboard" {...p} />;
export const IconExport = (p: WrappedProps) => <Icon name="export" {...p} />;
export const IconLayers = (p: WrappedProps) => <Icon name="panels" {...p} />;
export const IconSettings = (p: WrappedProps) => <Icon name="sliders" {...p} />;
export const IconChevronLeft = (p: WrappedProps) => <Icon name="chevron-left" {...p} />;
export const IconChevronRight = (p: WrappedProps) => <Icon name="chevron-right" {...p} />;
export const IconChevronDown = (p: WrappedProps) => <Icon name="chevron-down" {...p} />;
export const IconLock = (p: WrappedProps) => <Icon name="lock" {...p} />;
export const IconUnlock = (p: WrappedProps) => <Icon name="unlock" {...p} />;
export const IconSelect = (p: WrappedProps) => <Icon name="select" {...p} />;
export const IconNodeAdd = (p: WrappedProps) => <Icon name="node-add" {...p} />;
export const IconAnnotationAdd = (p: WrappedProps) => <Icon name="annotation-add" {...p} />;
export const IconBoundaryAdd = (p: WrappedProps) => <Icon name="boundary-add" {...p} />;
export const IconFreehand = (p: WrappedProps) => <Icon name="curve-freehand" {...p} />;
export const IconLine = (p: WrappedProps) => <Icon name="curve-line" {...p} />;
export const IconFitAll = (p: WrappedProps) => <Icon name="fit-window" {...p} />;
export const IconGrid = (p: WrappedProps) => <Icon name="grid" {...p} />;
export const IconCleanPreview = (p: WrappedProps) => <Icon name="clean-preview" {...p} />;
export const IconFullscreen = (p: WrappedProps) => <Icon name="fullscreen" {...p} />;
export const IconOverlay = (p: WrappedProps) => <Icon name="node-frame-link" {...p} />;
export const IconSheet = (p: WrappedProps) => <Icon name="rhythm-score" {...p} />;
export const IconSmartShot = (p: WrappedProps) => <Icon name="smart-shot" {...p} />;
export const IconDetectRange = (p: WrappedProps) => <Icon name="detect-range" {...p} />;
export const IconSplit = (p: WrappedProps) => <Icon name="split" {...p} />;
export const IconPlaySegment = (p: WrappedProps) => <Icon name="play-segment" {...p} />;
export const IconFocusSegment = (p: WrappedProps) => <Icon name="focus-segment" {...p} />;
export const IconHierarchy = (p: WrappedProps) => <Icon name="hierarchy" {...p} />;
export const IconZoomIn = (p: WrappedProps) => <Icon name="timeline-zoom-in" {...p} />;
export const IconZoomOut = (p: WrappedProps) => <Icon name="timeline-zoom-out" {...p} />;
export const IconTimelineFit = (p: WrappedProps) => <Icon name="timeline-fit" {...p} />;
export const IconFollowPlayhead = (p: WrappedProps) => <Icon name="follow-playhead" {...p} />;

export { ICON_LABELS, ICON_SHORTCUTS };