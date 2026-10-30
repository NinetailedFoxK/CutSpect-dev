/**
 * 应用可导入的视频扩展名（规格 10.1）。
 *
 * 系统「打开方式」与应用内选择器共用这一份列表，避免登记了应用打不开的类型。
 * 规格明确的是 `.mp4 .mov .m4v .webm .mkv`；`.avi` 不在此列，因此不登记。
 * 扩展名只用于筛选，真正能否导入仍由 ffprobe 判断。
 *
 * 本文件不依赖 Node API，渲染层与打包配置都可以引用。
 */

export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const;

export type VideoExtension = (typeof VIDEO_EXTENSIONS)[number];

const VIDEO_EXTENSION_SET: ReadonlySet<string> = new Set(VIDEO_EXTENSIONS);

export function isSupportedVideoExtension(extension: string): boolean {
  const normalized = extension.startsWith('.') ? extension.slice(1) : extension;
  return VIDEO_EXTENSION_SET.has(normalized.toLowerCase());
}

/** 按文件名判断扩展名。无扩展名、或以点开头的隐藏文件名不算视频。 */
export function isSupportedVideoFileName(filePath: string): boolean {
  const base = filePath.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return false;
  }
  return isSupportedVideoExtension(base.slice(dot + 1));
}

/**
 * macOS Info.plist 文档类型。
 * LSHandlerRank = Alternate：出现在「打开方式」里，但不抢系统默认播放器。
 */
export interface MacDocumentType {
  CFBundleTypeName: string;
  CFBundleTypeRole: 'Viewer';
  LSHandlerRank: 'Alternate';
  CFBundleTypeExtensions: string[];
  LSItemContentTypes: string[];
}

export interface MacImportedUti {
  UTTypeIdentifier: string;
  UTTypeDescription: string;
  UTTypeConformsTo: string[];
  UTTypeTagSpecification: {
    'public.filename-extension': string[];
    'public.mime-type': string[];
  };
}

const MAC_UTI: Record<VideoExtension, string> = {
  mp4: 'public.mpeg-4',
  m4v: 'com.apple.m4v-video',
  mov: 'com.apple.quicktime-movie',
  mkv: 'org.matroska.mkv',
  webm: 'org.webmproject.webm',
};

const MAC_TYPE_NAME: Record<VideoExtension, string> = {
  mp4: 'MP4 视频',
  m4v: 'M4V 视频',
  mov: 'QuickTime 视频',
  mkv: 'Matroska 视频',
  webm: 'WebM 视频',
};

export function macCfBundleDocumentTypes(): MacDocumentType[] {
  return VIDEO_EXTENSIONS.map((extension) => ({
    CFBundleTypeName: MAC_TYPE_NAME[extension],
    CFBundleTypeRole: 'Viewer',
    LSHandlerRank: 'Alternate',
    CFBundleTypeExtensions: [extension],
    LSItemContentTypes: [MAC_UTI[extension]],
  }));
}

/**
 * mkv / webm 在较旧的 macOS 上不一定是系统 UTI。
 * 只导入这两种；mp4 / mov / m4v 使用系统类型，避免重复声明。
 */
export function macImportedVideoTypes(): MacImportedUti[] {
  return [
    {
      UTTypeIdentifier: 'org.matroska.mkv',
      UTTypeDescription: 'Matroska 视频',
      UTTypeConformsTo: ['public.movie'],
      UTTypeTagSpecification: {
        'public.filename-extension': ['mkv'],
        'public.mime-type': ['video/x-matroska'],
      },
    },
    {
      UTTypeIdentifier: 'org.webmproject.webm',
      UTTypeDescription: 'WebM 视频',
      UTTypeConformsTo: ['public.movie'],
      UTTypeTagSpecification: {
        'public.filename-extension': ['webm'],
        'public.mime-type': ['video/webm'],
      },
    },
  ];
}

export function macFileAssociationExtendInfo(): {
  CFBundleDocumentTypes: MacDocumentType[];
  UTImportedTypeDeclarations: MacImportedUti[];
} {
  return {
    CFBundleDocumentTypes: macCfBundleDocumentTypes(),
    UTImportedTypeDeclarations: macImportedVideoTypes(),
  };
}
