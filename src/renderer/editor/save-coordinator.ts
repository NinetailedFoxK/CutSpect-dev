import type { LaipianError, Result } from '@shared/api-types';

export type SaveCoordinatorState = 'saved' | 'dirty' | 'saving' | 'error';

export interface SaveCoordinatorOptions<T> {
  initialRevision: number;
  readLatest(): T;
  write(snapshot: T, expectedRevision: number): Promise<Result<{ revision: number }>>;
  onState(state: SaveCoordinatorState): void;
  onRevision(revision: number): void;
  /** 保存失败：携带错误（code/message/retryable），供 UI 提示与重试（规格 10）。 */
  onError?(error: LaipianError): void;
  /** 每次成功落盘后回调（时间戳），供"最近成功保存时间"（规格 10）。 */
  onSaved?(at: number): void;
}

export interface SaveCoordinator {
  markDirty(): void;
  flush(): Promise<boolean>;
  reset(revision: number): void;
  isDirty(): boolean;
}

/**
 * 串行保存协调器。
 *
 * 编辑可以发生在一次磁盘写入尚未结束时。协调器会把新变化标记为下一代，
 * 等当前写入拿到新 revision 后立即继续保存最新快照，避免两个请求使用同一
 * expectedRevision 而互相冲突，也避免旧请求把更新后的界面误标成“已保存”。
 */
export function createSaveCoordinator<T>(options: SaveCoordinatorOptions<T>): SaveCoordinator {
  let revision = options.initialRevision;
  let changedGeneration = 0;
  let savedGeneration = 0;
  let inFlight: Promise<boolean> | null = null;

  const run = async (): Promise<boolean> => {
    while (savedGeneration < changedGeneration) {
      const targetGeneration = changedGeneration;
      const snapshot = options.readLatest();
      options.onState('saving');
      const result = await options.write(snapshot, revision);
      if (!result.ok) {
        options.onError?.(result.error);
        options.onState('error');
        return false;
      }
      revision = result.data.revision;
      savedGeneration = targetGeneration;
      options.onRevision(revision);
      options.onSaved?.(Date.now());
    }
    options.onState('saved');
    return true;
  };

  return {
    markDirty() {
      changedGeneration += 1;
      options.onState('dirty');
    },
    flush() {
      if (inFlight !== null) {
        return inFlight;
      }
      inFlight = run().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    reset(nextRevision) {
      revision = nextRevision;
      changedGeneration = 0;
      savedGeneration = 0;
      options.onState('saved');
    },
    isDirty() {
      return savedGeneration < changedGeneration;
    },
  };
}
