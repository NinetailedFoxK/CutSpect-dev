import type { ExportArtifactKind, ExportKind } from './api-types';

/**
 * 导出落盘后的产物类型。
 * 多个格式合并成 ZIP 时，产物本身是 zip，不能记成其中某一个输入格式（例如 json）。
 */
export function outputArtifactKind(useZip: boolean, kind: ExportKind): ExportArtifactKind {
  return useZip ? 'zip' : kind;
}
