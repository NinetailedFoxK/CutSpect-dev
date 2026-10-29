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
  it('remember 后只对渲染层暴露 id 和文件名', () => {
    const service = createExportService({ showSaveDialog: async () => null });
    const absPath = '/tmp/laipian-secret/a.pdf';
    service.remember('t1', [{ absPath, kind: 'pdf', sizeBytes: 10 }]);
    const products = service.products('t1');
    expect(products).toHaveLength(1);
    const product = products[0];
    expect(product).toBeDefined();
    if (product === undefined) return;
    expect(product.fileName).toBe('a.pdf');
    expect(product.kind).toBe('pdf');
    expect(service.owns(product.id)).toBe(true);
    expect(service.owns(absPath)).toBe(false);
    expect(JSON.stringify(products)).not.toContain('laipian-secret');
    expect(service.products('unknown')).toEqual([]);
  });

  it('ZIP 产物 kind 是 zip，且不把目录交给渲染层', () => {
    const service = createExportService({ showSaveDialog: async () => null });
    service.remember('t-zip', [{ absPath: '/var/folders/out/bundle.zip', kind: 'zip', sizeBytes: 40 }]);
    const product = service.products('t-zip')[0];
    expect(product?.kind).toBe('zip');
    expect(product?.fileName).toBe('bundle.zip');
    expect(JSON.stringify(service.products('t-zip'))).not.toContain('/var/folders');
  });

  it('reveal / open 只接受 id，未登记 id 返回错误', async () => {
    const revealed: string[] = [];
    const service = createExportService({
      showSaveDialog: async () => null,
      revealInFolder: (absPath) => {
        revealed.push(absPath);
      },
      openWithSystem: async (absPath) => {
        revealed.push(absPath);
        return '';
      },
    });
    const absPath = '/tmp/owned-export.pdf';
    service.remember('t1', [{ absPath, kind: 'pdf', sizeBytes: 10 }]);
    const id = service.products('t1')[0]?.id;
    expect(id).toBeDefined();
    if (id === undefined) return;
    expect((await service.reveal(id)).ok).toBe(true);
    expect((await service.open(id)).ok).toBe(true);
    expect(revealed).toEqual([absPath, absPath]);
    expect((await service.reveal('00000000-0000-4000-8000-000000000000')).ok).toBe(false);
    expect((await service.open(absPath)).ok).toBe(false);
  });
});