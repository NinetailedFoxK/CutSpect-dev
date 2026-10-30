import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { VideoPickResult } from '../src/shared/api-types';
import {
  VIDEO_EXTENSIONS,
  isSupportedVideoFileName,
  macFileAssociationExtendInfo,
} from '../src/shared/video-extensions';
import {
  createExternalVideoOpenCoordinator,
  extractVideoPathsFromArgv,
} from '../src/main/external-open';
import type { ExternalVideoOpen } from '../src/main/external-open';
import {
  planWindowsFileAssociationOps,
  resolveWindowsAssociationTarget,
  WINDOWS_VIDEO_PROGID,
} from '../src/main/windows-file-assoc';

function videoResult(fileName: string, token: string): VideoPickResult {
  return {
    token: token as VideoPickResult['token'],
    fileName,
    sizeBytes: 10,
    durationMs: null,
    width: null,
    height: null,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error('等待外部打开结果超时');
}

describe('可打开的视频扩展名', () => {
  it('与规格 10.1 一致，不包含 avi', () => {
    expect([...VIDEO_EXTENSIONS]).toEqual(['mp4', 'mov', 'm4v', 'webm', 'mkv']);
    expect(isSupportedVideoFileName('片段.MP4')).toBe(true);
    expect(isSupportedVideoFileName('clip.mkv')).toBe(true);
    expect(isSupportedVideoFileName('clip.avi')).toBe(false);
    expect(isSupportedVideoFileName('.mp4')).toBe(false);
    expect(isSupportedVideoFileName('mp4')).toBe(false);
  });
});

describe('命令行视频路径', () => {
  it('跳过可执行文件、开关和项目入口，保留受支持的视频', () => {
    const fileUrl = pathToFileURL('/library/样片.webm').href;
    const found = extractVideoPathsFromArgv(
      [
        '/usr/bin/electron',
        '.',
        '--smoke',
        '--squirrel-firstrun',
        'clips/开场.MP4',
        'notes.txt',
        fileUrl,
        '/library/样片.webm',
      ],
      '/work',
    );
    expect(found).toEqual([
      path.normalize('/work/clips/开场.MP4'),
      path.normalize('/library/样片.webm'),
    ]);
  });

  it('不把 argv[0] 当成要打开的视频', () => {
    expect(extractVideoPathsFromArgv(['/tmp/app/video.mp4', '/tmp/real.mov'], '/tmp')).toEqual([
      path.normalize('/tmp/real.mov'),
    ]);
  });
});

describe('外部打开协调', () => {
  it('ready 之前只排队，启动后按顺序交付，拒绝信息不含绝对路径', async () => {
    const delivered: ExternalVideoOpen[] = [];
    let existsCalls = 0;
    const coordinator = createExternalVideoOpenCoordinator({
      cwd: '/work',
      now: () => 1_000,
      existsFile: async (filePath) => {
        existsCalls += 1;
        return filePath.endsWith('exists.mp4');
      },
      describeVideo: async (filePath) => videoResult(path.basename(filePath), 'token-1'),
      deliver: (payload) => {
        delivered.push(payload);
      },
    });

    coordinator.enqueuePath('/library/exists.mp4');
    coordinator.enqueueArgv(['app', '/library/missing.mkv', 'readme.txt'], '/work');
    expect(existsCalls).toBe(0);

    coordinator.start();
    await waitUntil(() => delivered.length === 2);

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toEqual({
      status: 'ready',
      video: videoResult('exists.mp4', 'token-1'),
    });
    const rejected = delivered[1];
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.fileName).toBe('missing.mkv');
      expect(rejected.message).toContain('missing.mkv');
      expect(rejected.message).not.toContain('/library');
    }
  });

  it('短时间内同一路径只处理一次，间隔过后可以再打开', async () => {
    let now = 5_000;
    const described: string[] = [];
    const coordinator = createExternalVideoOpenCoordinator({
      cwd: '/work',
      now: () => now,
      dedupeMs: 1500,
      existsFile: async () => true,
      describeVideo: async (filePath) => {
        described.push(filePath);
        return videoResult('again.mov', `token-${described.length}`);
      },
      deliver: () => undefined,
    });
    coordinator.start();
    coordinator.enqueuePath('/library/again.mov');
    coordinator.enqueuePath('/library/again.mov');
    await waitUntil(() => described.length === 1);
    expect(described).toEqual(['/library/again.mov']);

    now += 1_500;
    coordinator.enqueuePath('/library/again.mov');
    await waitUntil(() => described.length === 2);
  });

  it('读取失败时给出可展示的说明', async () => {
    const delivered: ExternalVideoOpen[] = [];
    const coordinator = createExternalVideoOpenCoordinator({
      cwd: '/work',
      now: () => 0,
      existsFile: async () => true,
      describeVideo: async () => {
        throw new Error('/library/secret.mp4 exploded');
      },
      deliver: (payload) => {
        delivered.push(payload);
      },
    });
    coordinator.start();
    coordinator.enqueuePath('/library/secret.mp4');
    await waitUntil(() => delivered.length === 1);
    expect(delivered[0]).toEqual({
      status: 'rejected',
      fileName: 'secret.mp4',
      message: '无法读取「secret.mp4」，请重新选择该视频。',
    });
  });
});

describe('macOS 文件关联', () => {
  it('每种已支持视频都登记为 Viewer / Alternate，不声明自己是默认打开方式', () => {
    const info = macFileAssociationExtendInfo();
    expect(info.CFBundleDocumentTypes.map((entry) => entry.CFBundleTypeExtensions[0])).toEqual([
      ...VIDEO_EXTENSIONS,
    ]);
    for (const entry of info.CFBundleDocumentTypes) {
      expect(entry.CFBundleTypeRole).toBe('Viewer');
      expect(entry.LSHandlerRank).toBe('Alternate');
      expect(entry.LSItemContentTypes.length).toBeGreaterThan(0);
    }
    expect(info.UTImportedTypeDeclarations.map((entry) => entry.UTTypeIdentifier)).toEqual([
      'org.matroska.mkv',
      'org.webmproject.webm',
    ]);
  });

  it('打包配置引用共享的 Info.plist 描述', () => {
    const forge = readFileSync(path.resolve('forge.config.ts'), 'utf8');
    expect(forge).toContain('macFileAssociationExtendInfo()');
  });
});

describe('Windows 打开方式登记', () => {
  const exe = 'C:\\Users\\me\\AppData\\Local\\laipian-tai\\laipian-tai.exe';

  it('Squirrel 版本目录指向稳定的 stub', () => {
    const versioned = 'C:\\Users\\me\\AppData\\Local\\laipian-tai\\app-0.11.0\\laipian-tai.exe';
    const stub = path.win32.normalize(exe);
    expect(resolveWindowsAssociationTarget(versioned, (candidate) => candidate === stub)).toBe(stub);
    expect(resolveWindowsAssociationTarget(versioned, () => false)).toBe(path.win32.normalize(versioned));
    expect(resolveWindowsAssociationTarget(exe, () => false)).toBe(path.win32.normalize(exe));
  });

  it('只加入打开方式，不改扩展名的默认关联', () => {
    const plan = planWindowsFileAssociationOps('install', exe);
    expect(plan.operations.some((args) => args.some((part) => part === `"${exe}" "%1"`))).toBe(true);
    expect(plan.operations.some((args) => args.some((part) => part.includes('UserChoice')))).toBe(false);
    for (const args of plan.operations) {
      const key = args[1] ?? '';
      expect(key).not.toMatch(/\\Classes\\\.[a-z0-9]+$/i);
      if (key.endsWith('\\OpenWithProgids')) {
        expect(args).toContain(WINDOWS_VIDEO_PROGID);
      }
    }
    const flat = plan.operations.flat().join('\n');
    for (const extension of VIDEO_EXTENSIONS) {
      expect(flat).toContain(`.${extension}`);
    }
    expect(flat).not.toContain('.avi');
    expect(flat).toContain('FriendlyAppName');
    expect(flat).toContain('CutSpect');
  });

  it('卸载只删 CutSpect 的 ProgID 和打开方式项', () => {
    const plan = planWindowsFileAssociationOps('uninstall', exe);
    const keys = plan.operations.map((args) => args[1]);
    expect(keys).toContain('HKCU\\Software\\Classes\\CutSpect.Video');
    expect(keys).toContain('HKCU\\Software\\Classes\\Applications\\laipian-tai.exe');
    expect(keys).not.toContain('HKCU\\Software\\Classes\\.mp4');
    expect(
      plan.operations.some(
        (args) => args[0] === 'delete' && args[1]?.endsWith('\\OpenWithProgids') && args.includes(WINDOWS_VIDEO_PROGID),
      ),
    ).toBe(true);
  });

  it('可执行文件路径含引号时拒绝写入命令', () => {
    expect(() => planWindowsFileAssociationOps('install', 'C:\\bad"name.exe')).toThrow(/引号/);
  });
});
