import type { Annotation } from './api-types';
import { ANNOTATION_BODY_MAX, ANNOTATION_TITLE_MAX } from './schema';

/**
 * 标注结构操作（规格 6：创建、查看与修改、唯一性）。
 *
 * 约定：
 * - 每条标注属于当前曲线；纵向位置由曲线在该时间的值推导，不存高度；
 * - 同一毫秒只允许一个标注（重复创建则打开已有标注）；
 * - 时间范围 [0, durationMs]；标题 ≤ 80、正文 ≤ 5000 字符；
 * - labelOffset 是标签在画布中的像素偏移，重排时由渲染层夹紧在画布内。
 *
 * 纯函数，返回新数组。
 */

export interface AnnotationAddResult {
  /** 是否新建（false 表示该时刻已存在标注，返回 existing 供“打开已有”）。 */
  created: boolean;
  existing?: Annotation;
  annotations: Annotation[];
}

export interface AnnotationEditResult {
  ok: boolean;
  message?: string;
  annotations: Annotation[];
}

/** 新建标注的默认标签偏移（右上），单位 CSS 像素。 */
export const DEFAULT_LABEL_OFFSET = { x: 12, y: -16 } as const;

export function sortAnnotations(annotations: readonly Annotation[]): Annotation[] {
  return [...annotations].sort((a, b) => a.timeMs - b.timeMs);
}

export function findAnnotationAt(
  annotations: readonly Annotation[],
  timeMs: number,
): Annotation | undefined {
  return annotations.find((a) => a.timeMs === timeMs);
}

/**
 * 在 timeMs 创建标注；同一毫秒已存在时返回 created:false 与已有标注
 * （规格 6.1：重复创建则打开已有标注，不重复叠点）。
 */
export function addAnnotation(
  annotations: readonly Annotation[],
  timeMs: number,
  id: string,
  labelOffset: { x: number; y: number } = DEFAULT_LABEL_OFFSET,
): AnnotationAddResult {
  const existing = findAnnotationAt(annotations, timeMs);
  if (existing) {
    return { created: false, existing, annotations: annotations.map((a) => ({ ...a })) };
  }
  const annotation: Annotation = {
    id,
    timeMs,
    title: '',
    body: '',
    labelOffset: { ...labelOffset },
  };
  return {
    created: true,
    annotations: sortAnnotations([...annotations.map((a) => ({ ...a })), annotation]),
  };
}

export interface AnnotationPatch {
  title?: string;
  body?: string;
  timeMs?: number;
  labelOffset?: { x: number; y: number };
}

/**
 * 修改标注；校验标题/正文长度与时间唯一性。失败返回原因且不改动原数组。
 */
export function updateAnnotation(
  annotations: readonly Annotation[],
  id: string,
  patch: AnnotationPatch,
): AnnotationEditResult {
  const target = annotations.find((a) => a.id === id);
  if (!target) {
    return { ok: false, message: '找不到该标注。', annotations: annotations.map((a) => ({ ...a })) };
  }
  if (patch.title !== undefined && patch.title.length > ANNOTATION_TITLE_MAX) {
    return {
      ok: false,
      message: `标题最多 ${ANNOTATION_TITLE_MAX} 个字符。`,
      annotations: annotations.map((a) => ({ ...a })),
    };
  }
  if (patch.body !== undefined && patch.body.length > ANNOTATION_BODY_MAX) {
    return {
      ok: false,
      message: `正文最多 ${ANNOTATION_BODY_MAX} 个字符。`,
      annotations: annotations.map((a) => ({ ...a })),
    };
  }
  if (
    patch.timeMs !== undefined &&
    annotations.some((a) => a.id !== id && a.timeMs === patch.timeMs)
  ) {
    return {
      ok: false,
      message: '同一时刻只能有一个标注。',
      annotations: annotations.map((a) => ({ ...a })),
    };
  }
  const next = annotations.map((a) =>
    a.id === id
      ? {
          ...a,
          title: patch.title ?? a.title,
          body: patch.body ?? a.body,
          timeMs: patch.timeMs ?? a.timeMs,
          labelOffset: patch.labelOffset ?? a.labelOffset,
        }
      : { ...a },
  );
  return { ok: true, annotations: sortAnnotations(next) };
}

export function removeAnnotation(annotations: readonly Annotation[], id: string): Annotation[] {
  return annotations.filter((a) => a.id !== id).map((a) => ({ ...a }));
}

/**
 * 标题为空而正文有内容时，取正文首个非空行的前 20 字符作标题（规格 6.1）。
 * 两者都空返回空串（由调用方决定取消、不留下空点）。
 */
export function titleFromBody(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) {
    return '';
  }
  return firstLine.slice(0, 20);
}