import { describe, expect, it } from 'vitest';
import { outputArtifactKind } from '../src/shared/export-artifact';

describe('outputArtifactKind', () => {
  it('单个格式保持原 kind', () => {
    expect(outputArtifactKind(false, 'pdf')).toBe('pdf');
    expect(outputArtifactKind(false, 'json')).toBe('json');
    expect(outputArtifactKind(false, 'markdown')).toBe('markdown');
  });

  it('合并 ZIP 时产物 kind 是 zip，而不是某个输入格式', () => {
    expect(outputArtifactKind(true, 'json')).toBe('zip');
    expect(outputArtifactKind(true, 'pdf')).toBe('zip');
  });
});
