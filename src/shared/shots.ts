/**
 * 智能镜头识别（硬切检测）共享常量（v1.1 后续增强）。
 * main（scdet 阈值）与 renderer（三档灵敏度 UI）共用，避免两处各自硬编码。
 */

export type ShotSensitivityId = 'strict' | 'standard' | 'sensitive';

export interface ShotPreset {
  id: ShotSensitivityId;
  label: string;
  /** scdet 阈值：越大越保守（越少误判）。 */
  threshold: number;
}

/** 三档灵敏度（需求：保守 14 / 标准 10 默认 / 灵敏 8）。 */
export const SHOT_PRESETS: readonly ShotPreset[] = [
  { id: 'strict', label: '保守', threshold: 14 },
  { id: 'standard', label: '标准', threshold: 10 },
  { id: 'sensitive', label: '灵敏', threshold: 8 },
];

export const DEFAULT_SHOT_PRESET: ShotSensitivityId = 'standard';

/** 最短镜头长度默认值（毫秒）。 */
export const DEFAULT_MIN_SHOT_MS = 500;

/** 候选切点与已有手动边界的最小距离（毫秒）：小于该值时保留手动边界，不重复添加。 */
export const SHOT_BOUNDARY_DEDUPE_MS = 100;
/**
 * 系统占位镜头名称：旧项目迁移时为每个段落创建的“未划分镜头”。
 * 它不代表用户手动成果，可被智能识别结果替换（见 structure-shots.isPlaceholderShot）。
 */
export const PLACEHOLDER_SHOT_NAME = '未划分镜头';