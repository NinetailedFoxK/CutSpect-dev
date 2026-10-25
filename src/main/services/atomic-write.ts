import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * 原子文件写入（规格 8.3）。
 *
 * 流程：同目录写临时文件 → 写入并 fsync 落盘 → rename 替换主文件。
 * 保证：
 * - 替换前旧主文件始终可读；失败绝不清空旧文件（先写临时再替换）；
 * - rename 在同一目录内是原子操作；
 * - Windows 上目标临时被占用会触发 EPERM/EACCES/EEXIST，做有限重试
 *   （不做无限循环，规格 8.3），最终失败则抛出并清理临时文件。
 */

const RENAME_RETRY_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 60;

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EEXIST', 'EBUSY', 'ENOTEMPTY']);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? '';
      if (!RETRYABLE_RENAME_CODES.has(code) || attempt === RENAME_RETRY_ATTEMPTS - 1) {
        throw error;
      }
      await delay(RENAME_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

/**
 * 原子写入文本或二进制内容；失败时旧文件保持不变（抛出错误）。
 */
export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(tmp, 'w');
  try {
    if (typeof data === 'string') {
      await handle.writeFile(data, 'utf8');
    } else {
      await handle.writeFile(data);
    }
    // fsync：确保内容真正落盘后再替换（崩溃时不丢已确认的保存）。
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await renameWithRetry(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}