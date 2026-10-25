/**
 * Electron 运行时适配（含 electron 依赖，不参与单元测试）。
 * 把内置 autoUpdater 收敛为 service.ts 定义的注入接口，其余逻辑全部可测。
 */
import { autoUpdater } from 'electron';
import type { UpdateAutoUpdater } from './service';

/** 唯一接触 Electron autoUpdater 的位置；Token / 仓库名一律不在此出现。 */
export function createElectronAutoUpdater(): UpdateAutoUpdater {
  return autoUpdater as unknown as UpdateAutoUpdater;
}