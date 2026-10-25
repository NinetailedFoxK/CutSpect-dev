import { randomUUID } from 'node:crypto';
import type { FileSelectionKind, FileSelectionToken } from '../shared/api-types';

/**
 * 文件选择令牌注册表（规格 12.4）。
 *
 * renderer 永远拿不到真实路径：系统选择器把选中路径登记在本表并返回
 * opaque 令牌；后续业务 handler（如 projects.create）用令牌兑换路径，
 * 兑换是一次性的，防止重放。令牌带 TTL，懒过期清理。
 */

interface FileSelectionEntry {
  token: FileSelectionToken;
  kind: FileSelectionKind;
  /** 选中的绝对路径（当前均为单选，数组结构为多选预留）。 */
  paths: string[];
  createdAt: number;
}

/** 15 分钟未消费的令牌过期（导入流程不会停留这么久）。 */
const SELECTION_TTL_MS = 15 * 60 * 1000;

const selections = new Map<string, FileSelectionEntry>();

function pruneExpired(now: number): void {
  for (const [key, entry] of selections) {
    if (now - entry.createdAt > SELECTION_TTL_MS) {
      selections.delete(key);
    }
  }
}

/** 登记一次选择并签发令牌。paths 为空视为调用方错误，直接抛出。 */
export function registerSelection(
  kind: FileSelectionKind,
  paths: readonly string[],
): FileSelectionToken {
  if (paths.length === 0) {
    throw new Error('registerSelection: paths 不能为空');
  }
  const now = Date.now();
  pruneExpired(now);
  const token = randomUUID() as FileSelectionToken;
  selections.set(token, { token, kind, paths: [...paths], createdAt: now });
  return token;
}

/**
 * 一次性兑换令牌：kind 必须匹配（视频令牌不能挪用作目录），
 * 兑换后立即失效；无效/过期/类型不符返回 null。
 */
export function consumeSelection(
  token: string,
  expectedKind: FileSelectionKind,
): string[] | null {
  const entry = selections.get(token);
  if (!entry || entry.kind !== expectedKind) {
    return null;
  }
  selections.delete(token);
  return entry.paths;
}