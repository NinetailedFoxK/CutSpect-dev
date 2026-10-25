import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import {
  MEDIA_PROTOCOL_SCHEME,
  buildMediaUrl,
  isMediaResourceKind,
  isNamedResourceKind,
  isSafeMediaName,
} from '../shared/media-url';
import type { MediaResourceKind } from '../shared/media-url';

/**
 * laipian-media: 安全流式媒体协议（规格 12.5）。
 *
 * 安全模型：
 * - URL 只携带 `laipian-media://<projectId>/<mediaId>/<resourceKind>`，
 *   绝不携带绝对路径；真实路径登记在 main 侧模块级注册表，
 *   渲染层永远无法通过 URL 探测或遍历文件系统（未注册 → 403）。
 * - 注册表按 projectId 分组，项目关闭时 unregisterProject 整组失效。
 * - Range 支持保证拖动定位不重读完整文件（规格 12.5 必测行为）。
 *
 * 接线（集成阶段，main.ts）：
 *   protocol.registerSchemesAsPrivileged([
 *     { scheme: 'laipian-media', privileges: { standard: true, stream: true } },
 *   ]);
 *   // app ready 之后：
 *   protocol.handle('laipian-media', createMediaProtocolHandler());
 * 本模块不 import electron，可在纯 Node 环境（vitest）下完整测试。
 */

/** 协议 scheme / URL 构造 / kind 判定统一来自 shared（集成阶段注入用）。 */
export { MEDIA_PROTOCOL_SCHEME, buildMediaUrl, isMediaResourceKind };
export type { MediaResourceKind };

/* ------------------------------------------------------------------ */
/* 资源注册表                                                           */
/* ------------------------------------------------------------------ */

/**
 * 注册表结构：projectId → mediaId → kind → 绝对路径。
 *
 * projectId/mediaId 统一小写归一：WHATWG URL 对非特殊 scheme 的 host
 * 在 Node 中保留大小写，但 Chromium（standard scheme）会小写化 host 段；
 * 双向 toLowerCase 保证两种运行时下同一资源命中同一登记项。
 * projectId/mediaId 均为 UUID（十六进制小写字符集），归一无信息损失。
 */
const registry = new Map<string, Map<string, Map<MediaResourceKind, string>>>();

function projectBucket(projectId: string, create: boolean): Map<string, Map<MediaResourceKind, string>> | undefined {
  let bucket = registry.get(projectId);
  if (!bucket && create) {
    bucket = new Map();
    registry.set(projectId, bucket);
  }
  return bucket;
}

/**
 * 登记一条媒体资源（main 侧调用；absPath 必须是绝对路径）。
 * - source / playback / cover：登记**文件**绝对路径。
 * - thumb / frame（命名资源）：登记**目录**绝对路径，URL 再带受控文件名访问目录内文件。
 * 重复登记同一 (projectId, mediaId, kind) 时后者覆盖前者（重新导入/换副本）。
 */
export function registerMediaResource(
  projectId: string,
  mediaId: string,
  resourceKind: MediaResourceKind,
  absPath: string,
): void {
  if (!projectId || !mediaId || !isMediaResourceKind(resourceKind)) {
    throw new Error('registerMediaResource: 参数不合法。');
  }
  if (!path.isAbsolute(absPath)) {
    throw new Error(`registerMediaResource: absPath 必须是绝对路径（收到 ${absPath}）。`);
  }
  const bucket = projectBucket(projectId.toLowerCase(), true)!;
  let kinds = bucket.get(mediaId.toLowerCase());
  if (!kinds) {
    kinds = new Map();
    bucket.set(mediaId.toLowerCase(), kinds);
  }
  kinds.set(resourceKind, absPath);
}

/** 项目关闭/移除时整组失效；未注册的 projectId 静默忽略。 */
export function unregisterProject(projectId: string): void {
  registry.delete(projectId.toLowerCase());
}

function lookupResource(
  projectId: string,
  mediaId: string,
  resourceKind: MediaResourceKind,
): string | undefined {
  return projectBucket(projectId, false)?.get(mediaId)?.get(resourceKind);
}


/** 解析后的协议引用。命名资源（thumb/frame）额外携带目录内的受控文件名。 */
export interface MediaUrlRef {
  projectId: string;
  mediaId: string;
  resourceKind: MediaResourceKind;
  name: string | null;
}

/**
 * 解析协议 URL；非法结构（缺段/多余段/未知 kind/非法文件名/非本协议）返回 null → 403。
 * thumb / frame 允许且至多允许一段受控文件名；其余 kind 不允许额外段。
 */
export function parseMediaUrl(url: string): MediaUrlRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_PROTOCOL_SCHEME}:`) {
    return null;
  }
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  // 常规形态 `laipian-media://p/m/k`：projectId 位于 host，pathname 余两段。
  // 容错形态 host 为空（`laipian-media:///p/m/k`）时全部落在 pathname。
  const hasHost = parsed.host.length > 0;
  const baseSegmentCount = hasHost ? 2 : 3;
  const baseIndex = hasHost ? 0 : 1;
  const projectId = hasHost ? parsed.host : segments[0];
  const mediaId = segments[baseIndex];
  const resourceKind = segments[baseIndex + 1];
  if (!projectId || !mediaId || !resourceKind || !isMediaResourceKind(resourceKind)) {
    return null;
  }
  const extra = segments.length - baseSegmentCount;
  let name: string | null = null;
  if (extra === 1 && isNamedResourceKind(resourceKind)) {
    const raw = segments[baseIndex + 2];
    if (raw === undefined || !isSafeMediaName(raw)) {
      return null;
    }
    name = raw;
  } else if (extra !== 0) {
    // 非命名资源不允许文件名段；多段一律拒绝（杜绝路径夹带与遍历）。
    return null;
  }
  return { projectId: projectId.toLowerCase(), mediaId: mediaId.toLowerCase(), resourceKind, name };
}

/**
 * 将注册项解析为真实绝对路径：
 * - 命名资源：注册项是目录，name 必须是合法受控文件名，拼出的路径须仍是该目录直属子项
 *   （双保险防 `..` / 绝对路径夹带）；未提供 name 时不可访问目录本身。
 * - 其余资源：注册项是文件，带 name 一律拒绝。
 */
export function resolveRegisteredPath(ref: MediaUrlRef): string | undefined {
  const base = lookupResource(ref.projectId, ref.mediaId, ref.resourceKind);
  if (base === undefined) {
    return undefined;
  }
  if (isNamedResourceKind(ref.resourceKind)) {
    if (ref.name === null || !isSafeMediaName(ref.name)) {
      return undefined;
    }
    const dir = path.resolve(base);
    const candidate = path.resolve(dir, ref.name);
    if (candidate !== path.join(dir, ref.name) || !candidate.startsWith(dir + path.sep)) {
      return undefined;
    }
    return candidate;
  }
  return ref.name === null ? base : undefined;
}

/* ------------------------------------------------------------------ */
/* Range 解析（纯函数，单测重点）                                         */
/* ------------------------------------------------------------------ */

export type ParsedRange =
  | { kind: 'ok'; start: number; end: number }
  /** 语法错误（bytes=abc、bytes=-、非 bytes 单位等）。 */
  | { kind: 'invalid' }
  /** 语法正确但区间落在文件之外（start ≥ size、空后缀等）。 */
  | { kind: 'unsatisfiable' };

/**
 * 解析 Range 头（RFC 9110 语义子集）：
 * - `bytes=100-200`：闭区间；end ≥ size 时夹紧到 size-1（合法 206）；
 * - `bytes=100-`：开区间，end = size-1；
 * - `bytes=-500`：后缀区间取最后 500 字节；后缀长度超过文件大小时取整个文件；
 * - 多区间 `bytes=0-99,200-300`：只取第一个区间（HTTP 允许服务器收窄为单区间）；
 * - start > end、非数字、空区间（`bytes=-`）→ invalid；
 * - start ≥ size（含 size=0 的任何区间）、`bytes=-0` → unsatisfiable。
 *
 * 注：RFC 规定语法错误的 Range 应忽略并返回 200，但本项目从严处理为 416
 * （规格 12.5 要求覆盖"越界 Range/416"，且本地受控资源下从严更易排错）。
 */
export function parseRangeHeader(header: string, size: number): ParsedRange {
  if (!Number.isSafeInteger(size) || size < 0) {
    return { kind: 'invalid' };
  }
  const match = /^bytes\s*=\s*(.*)$/i.exec(header.trim());
  if (!match || match[1] === undefined) {
    return { kind: 'invalid' };
  }
  // 多区间：仅取第一个（本协议不返回 multipart/byteranges）。
  const firstSpec = match[1].split(',')[0]?.trim() ?? '';
  const rangeMatch = /^(\d*)-(\d*)$/.exec(firstSpec);
  if (!rangeMatch) {
    return { kind: 'invalid' };
  }
  const startRaw = rangeMatch[1] ?? '';
  const endRaw = rangeMatch[2] ?? '';

  if (startRaw === '' && endRaw === '') {
    // `bytes=-`：两端都空，既无起点也无长度。
    return { kind: 'invalid' };
  }

  if (startRaw === '') {
    // 后缀区间：最后 N 字节；N=0 是显式空区间 → unsatisfiable。
    const suffixLength = Number(endRaw);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return suffixLength === 0 ? { kind: 'unsatisfiable' } : { kind: 'invalid' };
    }
    if (size === 0) {
      return { kind: 'unsatisfiable' };
    }
    const start = Math.max(0, size - suffixLength);
    return { kind: 'ok', start, end: size - 1 };
  }

  const start = Number(startRaw);
  if (!Number.isSafeInteger(start) || start < 0) {
    return { kind: 'invalid' };
  }
  if (start >= size) {
    return { kind: 'unsatisfiable' };
  }
  if (endRaw === '') {
    // 开区间：直到文件末尾。
    return { kind: 'ok', start, end: size - 1 };
  }
  const end = Number(endRaw);
  if (!Number.isSafeInteger(end) || end < start) {
    return { kind: 'invalid' };
  }
  // end 超出文件按 RFC 收窄为余量（仍返回 206，而非 416）。
  return { kind: 'ok', start, end: Math.min(end, size - 1) };
}

/* ------------------------------------------------------------------ */
/* 协议 handler（适配 Electron protocol.handle 的 callback 形态）         */
/* ------------------------------------------------------------------ */

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

function contentTypeFor(absPath: string): string {
  const ext = path.extname(absPath).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * 兼容取请求头：Electron protocol.handle 传入的 request.headers 运行时是
 * Record<string,string>（尽管类型标注为 Headers），标准 fetch Request 则是
 * Headers 实例；两者统一按大小写不敏感取值。
 */
function getHeaderValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') {
    return null;
  }
  const maybeHeaders = headers as Headers;
  if (typeof maybeHeaders.get === 'function') {
    return maybeHeaders.get(name);
  }
  const record = headers as Record<string, string | string[]>;
  const target = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === target) {
      const value = record[key];
      if (typeof value === 'string') {
        return value;
      }
      if (Array.isArray(value)) {
        return value.join(', ');
      }
    }
  }
  return null;
}

function textResponse(status: number, body: string, extra?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extra },
  });
}

/** HEAD/GET 之外的 Method 一律 405（规格 12.5 要求支持 GET 与 HEAD）。 */
async function handleRequest(request: Request): Promise<Response> {
  const method = request.method.toUpperCase();

  if (method !== 'GET' && method !== 'HEAD') {
    return textResponse(405, '仅支持 GET 与 HEAD。', { Allow: 'GET, HEAD' });
  }

  const ref = parseMediaUrl(request.url);
  if (!ref) {
    return textResponse(403, '未授权的媒体地址。');
  }
  const absPath = resolveRegisteredPath(ref);
  if (!absPath) {
    // 未注册资源不区分"不存在"与"无权限"，避免渲染层探测文件系统。
    return textResponse(403, '未授权的媒体地址。');
  }

  let size: number;
  let isFile: boolean;
  try {
    const stats = await stat(absPath);
    size = stats.size;
    isFile = stats.isFile();
  } catch (error) {
    const nodeCode = (error as NodeJS.ErrnoException | null)?.code;
    if (nodeCode === 'ENOENT') {
      return textResponse(404, '媒体文件不存在。');
    }
    return textResponse(500, '读取媒体文件失败。');
  }
  if (!isFile) {
    return textResponse(404, '媒体文件不存在。');
  }

  const headers: Record<string, string> = {
    'Content-Type': contentTypeFor(absPath),
    'Accept-Ranges': 'bytes',
  };

  const rangeHeader = getHeaderValue(request.headers, 'range');
  if (rangeHeader) {
    const parsed = parseRangeHeader(rangeHeader, size);
    if (parsed.kind !== 'ok') {
      // 语法错误与越界统一 416，并回 Content-Range: bytes */size 便于客户端纠偏。
      return textResponse(416, '请求的区间不可满足。', { 'Content-Range': `bytes */${size}` });
    }
    headers['Content-Range'] = `bytes ${parsed.start}-${parsed.end}/${size}`;
    headers['Content-Length'] = String(parsed.end - parsed.start + 1);
    if (method === 'HEAD') {
      return new Response(null, { status: 206, headers });
    }
    const coversWholeFile = parsed.start === 0 && parsed.end === size - 1;
    const stream = createReadStream(
      absPath,
      coversWholeFile ? undefined : { start: parsed.start, end: parsed.end },
    );
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 206, headers });
  }

  headers['Content-Length'] = String(size);
  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }
  // 无 Range：200 全量流式返回（createReadStream 内部按需分块，不整读进内存）。
  const stream = createReadStream(absPath);
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 200, headers });
}

/** Electron protocol.handle 的 handler 形态：(request, callback) => void。 */
export type MediaProtocolHandler = (request: Request, callback: (response: Response) => void) => void;

/**
 * Electron 44 `protocol.handle` 需要的 Promise<Response> 形态 handler。
 * 与 createMediaProtocolHandler 共用同一 handleRequest；异常兜底为 500。
 */
export function createMediaRequestHandler(): (request: Request) => Promise<Response> {
  return (request) => handleRequest(request).catch(() => textResponse(500, '读取媒体文件失败。'));
}

/**
 * 创建协议 handler（集成阶段传入 protocol.handle('laipian-media', …)）。
 * 所有分支（含内部异常兜底）都会恰好回调一次 Response，不会悬挂请求。
 */
export function createMediaProtocolHandler(): MediaProtocolHandler {
  return (request, callback) => {
    handleRequest(request)
      .then(callback)
      .catch(() => {
        callback(textResponse(500, '读取媒体文件失败。'));
      });
  };
}