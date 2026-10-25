/**
 * laipian-media: 协议 URL 的唯一构造入口（规格 12.5）。
 *
 * 放在 shared 是因为协议 URL 需要两侧一致：
 * - main 侧 protocol.ts 用它构造 ProjectSummary.coverMediaUrl 等；
 * - renderer 侧用它为 <video src> 生成播放地址（播放路径选择逻辑见
 *   `playbackMediaUrl`）。真实文件路径永远不进入 URL，只有
 *   `scheme://<projectId>/<mediaId>/<resourceKind>`。
 */

export const MEDIA_PROTOCOL_SCHEME = 'laipian-media';

/** 可授权的媒体资源种类（注册表按 kind 分组登记，规格 12.5）。 */
export type MediaResourceKind = 'source' | 'playback' | 'cover' | 'thumb' | 'frame';

const RESOURCE_KINDS: readonly MediaResourceKind[] = ['source', 'playback', 'cover', 'thumb', 'frame'];

export function isMediaResourceKind(value: string): value is MediaResourceKind {
  return (RESOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * 需要按名称访问目录内文件的资源种类（时间线缩略图 / 精确帧）。
 * 这两类一个项目有多个文件，URL 需带受控文件名段；其余 kind 仍是单文件。
 */
const NAMED_RESOURCE_KINDS: readonly MediaResourceKind[] = ['thumb', 'frame'];

export function isNamedResourceKind(value: MediaResourceKind): boolean {
  return (NAMED_RESOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * 受控文件名校验（防目录遍历，规格 12.5）：
 * 只允许字母/数字/点/下划线/连字符，且必须以 .jpg 结尾，长度受限。
 * 任何含路径分隔符、`..`、驱动盘或空段的名字一律拒绝。
 */
const SAFE_MEDIA_NAME = /^[A-Za-z0-9._-]{1,128}\.jpg$/;

export function isSafeMediaName(name: string): boolean {
  return SAFE_MEDIA_NAME.test(name) && !name.includes('..');
}

/**
 * 构造协议 URL。version 用于缓存失效（如封面按 revision 刷新）。
 * 项目/媒体 ID 均为 UUID，无需再做 URL 转义；version 走 query 转义。
 * name 仅对 thumb / frame 等命名资源生效，用于访问目录内的具体文件。
 */
export function buildMediaUrl(
  projectId: string,
  mediaId: string,
  resourceKind: MediaResourceKind,
  version?: string,
  name?: string,
): string {
  const query = version ? `?v=${encodeURIComponent(version)}` : '';
  const nameSegment = name !== undefined && name.length > 0 ? `/${name}` : '';
  return `${MEDIA_PROTOCOL_SCHEME}://${projectId}/${mediaId}/${resourceKind}${nameSegment}${query}`;
}

/** 有兼容副本时优先播放副本，否则播放项目内原片（规格 9.2 / 10.2）。 */
export interface PlaybackSourceInfo {
  projectId: string;
  mediaId: string;
  playbackPath: string | null;
  revision?: number;
}

/**
 * 为项目选择播放资源 URL：
 * - 已生成兼容副本（playbackPath 非空）→ playback；
 * - 否则 → source（原片）。
 * revision 作为 version 让副本生成/替换后 URL 自动变化。
 */
export function playbackMediaUrl(info: PlaybackSourceInfo): string {
  const kind: MediaResourceKind = info.playbackPath !== null ? 'playback' : 'source';
  return buildMediaUrl(info.projectId, info.mediaId, kind, info.revision?.toString());
}