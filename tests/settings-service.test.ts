import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SETTINGS_FILE_NAME,
  createSettingsService,
  sanitizeSettings,
} from '../src/main/services/settings-service';

/** 应用设置存储测试（v1.1 快捷键自定义）：原子读写与强校验。 */

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'laipian-settings-'));
  cleanups.push(dir);
  return dir;
}

describe('sanitizeSettings', () => {
  it('丢弃未知命令与非法键位', () => {
    const clean = sanitizeSettings({
      keymap: { 'play.toggle': 'p', 'tool.line': '-', unknown: 'x', 'file.save': 'mod+s' },
    });
    expect(clean.keymap).toEqual({ 'play.toggle': 'p', 'file.save': 'mod+s' });
  });

  it('非对象输入回落为空键位', () => {
    expect(sanitizeSettings(null)).toEqual({ keymap: {} });
    expect(sanitizeSettings('x')).toEqual({ keymap: {} });
    expect(sanitizeSettings({})).toEqual({ keymap: {} });
  });
});

describe('createSettingsService', () => {
  it('写入后可读回（原子文件）', async () => {
    const dir = await tempDir();
    const service = createSettingsService({ userDataDir: dir });
    const written = await service.write({ keymap: { 'play.toggle': 'p' } });
    expect(written.keymap).toEqual({ 'play.toggle': 'p' });

    const text = await readFile(path.join(dir, SETTINGS_FILE_NAME), 'utf8');
    expect(JSON.parse(text)).toEqual({ keymap: { 'play.toggle': 'p' } });

    expect(await service.read()).toEqual({ keymap: { 'play.toggle': 'p' } });
  });

  it('文件缺失返回默认；损坏文件也回落默认（不抛错）', async () => {
    const dir = await tempDir();
    const service = createSettingsService({ userDataDir: dir });
    expect(await service.read()).toEqual({ keymap: {} });

    await writeFile(path.join(dir, SETTINGS_FILE_NAME), '{ not json');
    expect(await service.read()).toEqual({ keymap: {} });
  });

  it('写入时同样做校验（非法条目丢弃）', async () => {
    const dir = await tempDir();
    const service = createSettingsService({ userDataDir: dir });
    const written = await service.write({
      keymap: { 'play.toggle': 'p', bogus: 'x', 'tool.line': '!' },
    });
    expect(written.keymap).toEqual({ 'play.toggle': 'p' });
  });
});