import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createExportService } from '../src/main/services/export-service';

/** 导出目标选择（单文件 / 多文件目录 / ZIP）测试。 */

describe('ExportService.chooseTarget', () => {
  it('单个格式：走保存对话框，返回文件目标', async () => {
    const service = createExportService({ showSaveDialog: async (opts) => `/tmp/${opts.defaultPath}` });
    const result = await service.chooseTarget({ suggestedName: '项目-导出', kinds: ['pdf'], zip: false });
    expect(result.ok).toBe(true);
    if (result.ok && result.data !== null) {
      expect(result.data.mode).toBe('file');
      expect(result.data.path).toContain('.pdf');
    }
  });

  it('多格式不压缩：走目录对话框', async () => {
    let dirTitleSeen = false;
    const service = createExportService({
      showSaveDialog: async () => '/tmp/should-not-use.pdf',
      showDirectoryDialog: async () => {
        dirTitleSeen = true;
        return '/tmp/outdir';
      },
    });
    const result = await service.chooseTarget({ suggestedName: 'x', kinds: ['pdf', 'xlsx'], zip: false });
    expect(dirTitleSeen).toBe(true);
    if (result.ok && result.data !== null) {
      expect(result.data.mode).toBe('directory');
      expect(result.data.path).toBe('/tmp/outdir');
    }
  });

  it('多格式 + ZIP：走保存对话框保存 .zip', async () => {
    const service = createExportService({ showSaveDialog: async (opts) => path.join('/tmp', opts.defaultPath) });
    const result = await service.chooseTarget({ suggestedName: 'x', kinds: ['pdf', 'png'], zip: true });
    if (result.ok && result.data !== null) {
      expect(result.data.mode).toBe('file');
      expect(result.data.path).toContain('.zip');
    }
  });

  it('用户取消返回 data: null', async () => {
    const service = createExportService({ showSaveDialog: async () => null });
    const result = await service.chooseTarget({ suggestedName: 'x', kinds: ['pdf'], zip: false });
    expect(result).toEqual({ ok: true, data: null });
  });
});

describe('ExportService 产物白名单', () => {
  it('remember 后 owns 为真，未知路径为假', () => {
    const service = createExportService({ showSaveDialog: async () => null });
    service.remember('t1', [{ path: '/tmp/a.pdf', kind: 'pdf', sizeBytes: 10 }]);
    expect(service.owns('/tmp/a.pdf')).toBe(true);
    expect(service.owns('/tmp/b.pdf')).toBe(false);
    expect(service.products('t1')).toHaveLength(1);
    expect(service.products('unknown')).toEqual([]);
  });

  it('reveal 未登记路径返回错误', async () => {
    const service = createExportService({ showSaveDialog: async () => null, revealInFolder: () => undefined });
    const result = await service.reveal('/tmp/not-owned.pdf');
    expect(result.ok).toBe(false);
  });
});