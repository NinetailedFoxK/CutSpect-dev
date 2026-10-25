import { describe, expect, it } from 'vitest';
import { sanitizeExportTemplates, sanitizeSettings } from '../src/main/services/settings-service';

/** 应用设置中的导出模板清洗（不信任磁盘/渲染层输入）。 */

describe('sanitizeSettings + exportTemplates', () => {
  it('无 exportTemplates 时不新增该键（兼容旧断言）', () => {
    expect(sanitizeSettings({ keymap: {} })).toEqual({ keymap: {} });
  });

  it('保留合法的导出模板', () => {
    const result = sanitizeSettings({
      keymap: {},
      exportTemplates: [
        {
          id: 't1',
          name: '我的模板',
          kinds: ['pdf', 'xlsx'],
          scopeKind: 'section',
          modules: ['projectInfo', 'shotTable'],
          frames: { includeShotFrame: true, framePosition: 'middle', includeAnnotationFrames: false, includeCurveNodeFrames: true, quality: 'high', maxWidth: 1280 },
          table: { fields: ['index', 'frame', 'shotName'] },
          layout: { template: 'gallery', orientation: 'landscape', showHeader: true, showPageNumber: false, showProjectName: true },
          zip: true,
        },
      ],
    });
    expect(result.exportTemplates).toHaveLength(1);
    expect(result.exportTemplates?.[0]?.kinds).toEqual(['pdf', 'xlsx']);
    expect(result.exportTemplates?.[0]?.layout.template).toBe('gallery');
  });

  it('丢弃非法枚举与缺失字段，回退到安全默认', () => {
    const result = sanitizeExportTemplates([
      {
        id: 't2',
        name: 'x',
        kinds: ['bogus'],
        scopeKind: 'nope',
        modules: ['nope'],
        frames: { framePosition: 'nope', quality: 'nope' },
        table: { fields: ['nope'] },
        layout: { template: 'nope', orientation: 'nope' },
        zip: 'yes',
      },
      { id: '', name: 'bad' },
      'not-an-object',
    ]);
    expect(result).toHaveLength(1);
    const t = result[0];
    expect(t?.kinds).toEqual(['pdf']);
    expect(t?.scopeKind).toBe('project');
    expect(t?.frames.framePosition).toBe('middle');
    expect(t?.frames.quality).toBe('standard');
    expect(t?.layout.orientation).toBe('portrait');
    expect(t?.zip).toBe(false);
  });

  it('按 id 去重', () => {
    const dup = { id: 'same', name: 'a', kinds: ['pdf'], scopeKind: 'project', modules: ['shotTable'] };
    expect(sanitizeExportTemplates([dup, { ...dup, name: 'b' }])).toHaveLength(1);
  });
});