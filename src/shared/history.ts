/**
 * 内容命令历史（规格 8.1 撤销/重做）。
 *
 * 采用**快照式**历史：每次内容提交保存一份新正文快照（曲线/标注/分段等），
 * 与规格“一次拖动、一次笔迹、一轮文字编辑各是一条历史操作”对应。
 * 之所以用快照而非增量命令：编辑操作形态多（节点、控制柄、整笔、段落…），
 * 快照实现更少出错；正文体量（<5MB，规格 16.1）可接受。
 *
 * 约定：
 * - 视图状态（图层、缩放、播放位置）**不进入**本历史（规格 12.3 第 2 层）。
 * - 连续输入可通过 coalesceKey 合并（规格 8.1：500ms 空闲或失焦后合并）。
 * - 最多保留 limit（默认 100）条操作。
 * - 保存不是历史节点（规格 8.1）：本模块与保存无关。
 *
 * 纯逻辑、无 DOM / Node 依赖，vitest 直接覆盖。
 */

export interface HistoryOptions<T> {
  /** 最多保留的历史操作数（默认 100）。 */
  limit?: number;
  /** 合并窗口（默认 500ms）。 */
  coalesceWindowMs?: number;
  /** 相等判定（默认引用相等）；用于跳过无变化的提交。 */
  isEqual?: (a: T, b: T) => boolean;
}

export interface CommitOptions {
  /** 相同 key 且间隔在合并窗口内的连续提交合并为一条（值取最新）。 */
  coalesceKey?: string;
  /** 注入时间（测试确定性）；默认 Date.now()。 */
  now?: number;
}

interface HistoryEntry<T> {
  value: T;
  key: string | undefined;
  at: number;
}

export interface History<T> {
  present(): T;
  canUndo(): boolean;
  canRedo(): boolean;
  /** 撤销：返回新的当前值；无可撤销时返回 null。 */
  undo(): T | null;
  /** 重做：返回新的当前值；无可重做时返回 null。 */
  redo(): T | null;
  /** 提交新内容；被 isEqual 判定为无变化或已被合并时返回 false。 */
  commit(next: T, options?: CommitOptions): boolean;
  /** 丢弃历史并以 value 作为新起点（切换项目时使用）。 */
  reset(value: T): void;
  /** 当前可撤销的操作数。 */
  depth(): number;
}

export function createHistory<T>(initial: T, options: HistoryOptions<T> = {}): History<T> {
  const limit = Math.max(1, options.limit ?? 100);
  const coalesceWindowMs = Math.max(0, options.coalesceWindowMs ?? 500);
  const isEqual = options.isEqual ?? ((a: T, b: T) => a === b);

  let presentValue = initial;
  const past: HistoryEntry<T>[] = [];
  const future: HistoryEntry<T>[] = [];
  // 最近一次“已入 past 的提交入口”的 key/time，用于合并判定。
  let lastKey: string | undefined;
  let lastAt = 0;

  return {
    present() {
      return presentValue;
    },
    canUndo() {
      return past.length > 0;
    },
    canRedo() {
      return future.length > 0;
    },
    undo() {
      const entry = past.pop();
      if (entry === undefined) {
        return null;
      }
      future.push({ value: presentValue, key: undefined, at: Date.now() });
      presentValue = entry.value;
      // 撤销后打断合并，避免紧接着的编辑被并入已撤销的时间点。
      lastKey = undefined;
      return presentValue;
    },
    redo() {
      const entry = future.pop();
      if (entry === undefined) {
        return null;
      }
      past.push({ value: presentValue, key: undefined, at: Date.now() });
      presentValue = entry.value;
      lastKey = undefined;
      return presentValue;
    },
    commit(next, commitOptions = {}) {
      if (isEqual(presentValue, next)) {
        return false;
      }
      const now = commitOptions.now ?? Date.now();
      const key = commitOptions.coalesceKey;
      if (key !== undefined && key === lastKey && now - lastAt <= coalesceWindowMs && past.length > 0) {
        // 合并：不新增 past 条目（保留更早的原始值作为撤销目标），仅更新现值。
        presentValue = next;
        lastAt = now;
        future.length = 0;
        return true;
      }
      past.push({ value: presentValue, key, at: now });
      if (past.length > limit) {
        past.shift();
      }
      presentValue = next;
      lastKey = key;
      lastAt = now;
      future.length = 0;
      return true;
    },
    reset(value) {
      presentValue = value;
      past.length = 0;
      future.length = 0;
      lastKey = undefined;
      lastAt = 0;
    },
    depth() {
      return past.length;
    },
  };
}