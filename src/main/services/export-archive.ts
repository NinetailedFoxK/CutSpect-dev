import { createWriteStream } from 'node:fs';
import type { Archiver } from 'archiver';

/**
 * ZIP 打包（仅当用户选择多个输出格式并同意压缩时使用）。
 *
 * archiver 运行时导出的是工厂函数（CJS），类型定义按命名导出，这里用 require
 * 断言规避 ESM/CJS 互操作差异，保证 Electron 主进程（CommonJS 输出）运行正确。
 */
const createArchive = require('archiver') as (
  format: string,
  options?: Record<string, unknown>,
) => Archiver;

export interface ZipEntry {
  /** 磁盘上的源文件绝对路径。 */
  path: string;
  /** 压缩包内的名字（含扩展名，不含目录）。 */
  name: string;
}

/** 把若干文件打包为 ZIP；返回最终字节数。 */
export async function zipFiles(zipPath: string, entries: readonly ZipEntry[]): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = createArchive('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(archive.pointer()));
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (warn: Error) => {
      if ((warn as NodeJS.ErrnoException).code === 'ENOENT') return;
      reject(warn);
    });
    archive.pipe(output);
    for (const entry of entries) {
      archive.file(entry.path, { name: entry.name });
    }
    void archive.finalize();
  });
}