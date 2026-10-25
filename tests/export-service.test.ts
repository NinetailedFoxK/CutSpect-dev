import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExportService, decodePngDataUrl, sanitizeExportName } from '../src/main/services/export-service';

/** 导出保存服务测试（规格 13：取消/覆盖/失败语义、原子写入）。 */

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'laipian-export-'));
  cleanups.push(dir);
  return dir;
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

describe('sanitizeExportName / decodePngDataUrl', () => {
  it('过滤目录与非法字符', () => {
    expect(sanitizeExportName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeExportName('a/b:c')).toBe('b_c');
    expect(sanitizeExportName('x?y*z')).toBe('x_y_z');
    expect(sanitizeExportName('')).toBe('CutSpect导出');
  });

  it('PNG data URL 解码与校验', () => {
    expect(decodePngDataUrl(PNG_DATA_URL).equals(PNG_BYTES)).toBe(true);
    expect(() => decodePngDataUrl('data:text/plain;base64,AAAA')).toThrowError();
  });
});

describe('ExportService.save（规格 13.2）', () => {
  it('Markdown：调用保存对话框并原子写入内容', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'out.md');
    const service = createExportService({ showSaveDialog: async () => target });
    const result = await service.save({ suggestedName: '笔记', type: 'markdown', payload: '# 标题' });
    expect(result).toEqual({ ok: true, data: { savedPath: target } });
    expect(await readFile(target, 'utf8')).toBe('# 标题');
  });

  it('PNG：从 data URL 解码后写入字节', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'out.png');
    const service = createExportService({ showSaveDialog: async () => target });
    const result = await service.save({ suggestedName: '图', type: 'png', payload: PNG_DATA_URL });
    expect(result.ok).toBe(true);
    expect((await readFile(target)).equals(PNG_BYTES)).toBe(true);
  });

  it('用户取消返回 data: null，不写文件', async () => {
    const dir = await tempDir();
    const service = createExportService({ showSaveDialog: async () => null });
    const result = await service.save({ suggestedName: 'x', type: 'markdown', payload: 'y' });
    expect(result).toEqual({ ok: true, data: null });
    await expect(readFile(path.join(dir, 'x.md'), 'utf8')).rejects.toThrow();
  });

  it('覆盖已有文件：内容被替换，旧内容不再残留', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'over.md');
    await writeFile(target, '旧内容');
    const service = createExportService({ showSaveDialog: async () => target });
    await service.save({ suggestedName: 'over', type: 'markdown', payload: '新内容' });
    expect(await readFile(target, 'utf8')).toBe('新内容');
  });

  it('写入失败返回可重试错误而非抛出', async () => {
    // 目标目录不存在 → 原子写入失败。
    const service = createExportService({
      showSaveDialog: async () => path.join(tmpdir(), 'laipian-missing-dir-xyz', 'a.md'),
    });
    const result = await service.save({ suggestedName: 'a', type: 'markdown', payload: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
      expect(result.error.code).toBe('IO');
    }
  });
});