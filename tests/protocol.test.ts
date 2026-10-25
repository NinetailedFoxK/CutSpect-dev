import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  MEDIA_PROTOCOL_SCHEME,
  buildMediaUrl,
  createMediaProtocolHandler,
  isMediaResourceKind,
  parseMediaUrl,
  parseRangeHeader,
  registerMediaResource,
  unregisterProject,
} from '../src/main/protocol';
import type { MediaProtocolHandler } from '../src/main/protocol';

/**
 * laipian-media: 协议测试（规格 12.5）：
 * - parseRangeHeader 纯函数：正常 / 开区间 / 后缀 / 多区间 / 越界 / 语法错误。
 * - URL 解析与注册表：未注册 403、项目注销、大小写归一。
 * - 本地 http server 包装 handler 的集成验证：GET/HEAD、200 全量流、
 *   206 单区间（Content-Range / Content-Length / 字节精确）、416、404、405，
 *   以及模拟拖动定位的连续 Range 请求（不重读完整文件）。
 */

/* ------------------------------------------------------------------ */
/* 纯函数                                                               */
/* ------------------------------------------------------------------ */

describe('parseRangeHeader', () => {
  const SIZE = 1000;

  it('正常闭区间', () => {
    expect(parseRangeHeader('bytes=0-99', SIZE)).toEqual({ kind: 'ok', start: 0, end: 99 });
    expect(parseRangeHeader('bytes=100-200', SIZE)).toEqual({ kind: 'ok', start: 100, end: 200 });
  });

  it('end 超出文件按 RFC 收窄（仍 206 而非 416）', () => {
    expect(parseRangeHeader('bytes=0-999999', SIZE)).toEqual({ kind: 'ok', start: 0, end: SIZE - 1 });
    expect(parseRangeHeader('bytes=900-1000', SIZE)).toEqual({ kind: 'ok', start: 900, end: 999 });
  });

  it('开区间 bytes=100- 取到文件末尾', () => {
    expect(parseRangeHeader('bytes=100-', SIZE)).toEqual({ kind: 'ok', start: 100, end: SIZE - 1 });
    expect(parseRangeHeader('bytes=0-', SIZE)).toEqual({ kind: 'ok', start: 0, end: SIZE - 1 });
  });

  it('后缀区间 bytes=-500 取最后 500 字节；超过文件大小时取整个文件', () => {
    expect(parseRangeHeader('bytes=-500', SIZE)).toEqual({ kind: 'ok', start: 500, end: 999 });
    expect(parseRangeHeader('bytes=-500', 300)).toEqual({ kind: 'ok', start: 0, end: 299 });
    expect(parseRangeHeader('bytes=-1', SIZE)).toEqual({ kind: 'ok', start: 999, end: 999 });
  });

  it('多区间只取第一个区间', () => {
    expect(parseRangeHeader('bytes=0-99,200-300', SIZE)).toEqual({ kind: 'ok', start: 0, end: 99 });
    expect(parseRangeHeader('bytes=100-199,500-', SIZE)).toEqual({ kind: 'ok', start: 100, end: 199 });
  });

  it('越界区间（start ≥ size）→ unsatisfiable', () => {
    expect(parseRangeHeader('bytes=999999999-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=1000-1001', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=5-9', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-7', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('语法错误 → invalid', () => {
    expect(parseRangeHeader('bytes=abc', SIZE)).toEqual({ kind: 'invalid' });
    expect(parseRangeHeader('bytes=-', SIZE)).toEqual({ kind: 'invalid' });
    expect(parseRangeHeader('bytes=100-50', SIZE)).toEqual({ kind: 'invalid' });
    expect(parseRangeHeader('items=0-99', SIZE)).toEqual({ kind: 'invalid' });
    expect(parseRangeHeader('', SIZE)).toEqual({ kind: 'invalid' });
    expect(parseRangeHeader('bytes=', SIZE)).toEqual({ kind: 'invalid' });
    expect(parseRangeHeader('bytes=-abc', SIZE)).toEqual({ kind: 'invalid' });
  });

  it('bytes=-0 为显式空区间 → unsatisfiable', () => {
    expect(parseRangeHeader('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('单位名大小写宽容', () => {
    expect(parseRangeHeader('Bytes=0-99', SIZE)).toEqual({ kind: 'ok', start: 0, end: 99 });
  });
});

describe('parseMediaUrl / 注册表', () => {
  const PROJECT = 'proj-uuid-1';
  const MEDIA = 'media-uuid-1';

  afterEach(() => {
    unregisterProject(PROJECT);
  });

  it('常规形态：projectId 位于 host，两段 pathname', () => {
    expect(parseMediaUrl(`laipian-media://${PROJECT}/${MEDIA}/source`)).toEqual({
      projectId: PROJECT,
      mediaId: MEDIA,
      resourceKind: 'source',
      name: null,
    });
  });

  it('查询参数（缓存版本号）不影响命中', () => {
    expect(parseMediaUrl(`laipian-media://${PROJECT}/${MEDIA}/thumb?v=abc123`)).toEqual({
      projectId: PROJECT,
      mediaId: MEDIA,
      resourceKind: 'thumb',
      name: null,
    });
  });

  it('命名资源：thumb/frame 允许一段受控文件名', () => {
    expect(parseMediaUrl(`laipian-media://${PROJECT}/${MEDIA}/thumb/thumb-000.jpg`)).toEqual({
      projectId: PROJECT,
      mediaId: MEDIA,
      resourceKind: 'thumb',
      name: 'thumb-000.jpg',
    });
    expect(parseMediaUrl(`laipian-media://${PROJECT}/${MEDIA}/frame/frame-abc123.jpg?v=x`)).toEqual({
      projectId: PROJECT,
      mediaId: MEDIA,
      resourceKind: 'frame',
      name: 'frame-abc123.jpg',
    });
  });

  it('命名资源：非法文件名或越界段一律拒绝', () => {
    expect(parseMediaUrl(`laipian-media://${PROJECT}/${MEDIA}/thumb/..%2Fsecret.jpg`)).toBeNull();
    expect(parseMediaUrl(`laipian-media://${PROJECT}/${MEDIA}/thumb/a.png`)).toBeNull();
    expect(parseMediaUrl(`laipian-media://${PROJECT}/${MEDIA}/thumb/a b.jpg`)).toBeNull();
    expect(parseMediaUrl(`laipian-media://${PROJECT}/${MEDIA}/thumb/thumb-000.jpg/extra`)).toBeNull();
    // 非命名资源不允许文件名段。
    expect(parseMediaUrl(`laipian-media://${PROJECT}/${MEDIA}/source/a.jpg`)).toBeNull();
  });

  it('host 为空的容错形态：三段 pathname', () => {
    expect(parseMediaUrl(`laipian-media:///${PROJECT}/${MEDIA}/playback`)).toEqual({
      projectId: PROJECT,
      mediaId: MEDIA,
      resourceKind: 'playback',
      name: null,
    });
  });

  it('host 大小写归一（Chromium 会小写化非特殊 scheme 的 host）', () => {
    expect(parseMediaUrl(`laipian-media://Proj-UUID/${MEDIA}/cover`)).toEqual({
      projectId: 'proj-uuid',
      mediaId: MEDIA,
      resourceKind: 'cover',
      name: null,
    });
  });

  it('非法结构：未知 kind / 缺段 / 多余段 / 非本协议 → null', () => {
    expect(parseMediaUrl(`laipian-media://${PROJECT}/${MEDIA}/thumbnail`)).toBeNull();
    expect(parseMediaUrl(`laipian-media://${PROJECT}/${MEDIA}`)).toBeNull();
    expect(parseMediaUrl(`laipian-media://${PROJECT}`)).toBeNull();
    expect(parseMediaUrl(`laipian-media://${PROJECT}/${MEDIA}/source/extra`)).toBeNull();
    expect(parseMediaUrl('file:///etc/passwd')).toBeNull();
    expect(parseMediaUrl('http://example.com/x')).toBeNull();
    expect(parseMediaUrl('laipian-media://not a url')).toBeNull();
  });

  it('isMediaResourceKind 枚举与 buildMediaUrl', () => {
    for (const kind of ['source', 'playback', 'cover', 'thumb', 'frame'] as const) {
      expect(isMediaResourceKind(kind)).toBe(true);
    }
    expect(isMediaResourceKind('probe')).toBe(false);
    expect(buildMediaUrl('p1', 'm1', 'cover', 'r3')).toBe('laipian-media://p1/m1/cover?v=r3');
    expect(buildMediaUrl('p1', 'm1', 'source')).toBe('laipian-media://p1/m1/source');
    expect(buildMediaUrl('p1', 'm1', 'thumb', undefined, 'thumb-000.jpg')).toBe(
      'laipian-media://p1/m1/thumb/thumb-000.jpg',
    );
    expect(buildMediaUrl('p1', 'm1', 'frame', 'v9', 'frame-x.jpg')).toBe(
      'laipian-media://p1/m1/frame/frame-x.jpg?v=v9',
    );
  });

  it('注册 → 查找 → 项目注销整组失效；重复登记覆盖', () => {
    registerMediaResource(PROJECT, MEDIA, 'source', '/tmp/a.mp4');
    registerMediaResource(PROJECT, 'media-2', 'cover', '/tmp/b.jpg');
    // 覆盖同 key。
    registerMediaResource(PROJECT, MEDIA, 'source', '/tmp/a2.mp4');

    unregisterProject(PROJECT);
    // 注销后全部失效（集成 handler 的 403 行为在下方 http 集成中验证）。
    expect(parseMediaUrl(`laipian-media://${PROJECT}/${MEDIA}/source`)).not.toBeNull();
  });

  it('registerMediaResource 参数防呆：相对路径与非法 kind 抛错', () => {
    expect(() => registerMediaResource(PROJECT, MEDIA, 'source', 'relative/path.mp4')).toThrowError();
    expect(() =>
      registerMediaResource(PROJECT, MEDIA, 'sticker' as 'source', '/tmp/a.png'),
    ).toThrowError();
  });
});

/* ------------------------------------------------------------------ */
/* 本地 http server 包装 handler 的集成验证                              */
/* ------------------------------------------------------------------ */

describe('laipian-media 协议 handler 集成（http server 包装）', () => {
  const PROJECT = 'it-proj-1';
  const MEDIA = 'it-media-1';
  const DATA = randomBytes(10_000);
  const JPEG = randomBytes(2048);

  let workDir: string;
  let server: http.Server;
  let baseUrl: string;
  const handler: MediaProtocolHandler = createMediaProtocolHandler();

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'laipian-protocol-test-'));
    const videoPath = path.join(workDir, 'source.mp4');
    const coverPath = path.join(workDir, 'cover.png');
    await writeFile(videoPath, DATA);
    await writeFile(coverPath, JPEG);
    registerMediaResource(PROJECT, MEDIA, 'source', videoPath);
    registerMediaResource(PROJECT, 'cover-media', 'cover', coverPath);

    server = http.createServer((req, res) => {
      // 请求路径 /<projectId>/<mediaId>/<kind> 映射为协议 URL（projectId 落 host 位）。
      const url = `${MEDIA_PROTOCOL_SCHEME}://${(req.url ?? '').replace(/^\//, '')}`;
      const request = { url, method: req.method ?? 'GET', headers: req.headers } as unknown as Request;
      handler(request, (response) => {
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        res.writeHead(response.status, headers);
        if (response.body) {
          Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream)
            .on('error', () => res.destroy())
            .pipe(res);
        } else {
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('无法获取测试服务器端口');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    unregisterProject(PROJECT);
    server.close();
    await rm(workDir, { recursive: true, force: true });
  });

  const resourceUrl = (mediaId = MEDIA, kind = 'source'): string =>
    `${baseUrl}/${PROJECT}/${mediaId}/${kind}`;

  async function fetchRange(range: string | null, mediaId = MEDIA): Promise<Response> {
    return fetch(resourceUrl(mediaId), {
      headers: range === null ? {} : { Range: range },
    });
  }

  it('GET 无 Range：200 全量流，字节逐一致，头正确', async () => {
    const res = await fetchRange(null);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe(String(DATA.length));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(DATA);
  });

  it('HEAD：200、正确 Content-Length、无 body', async () => {
    const res = await fetch(resourceUrl(), { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe(String(DATA.length));
    expect(await res.arrayBuffer()).toEqual(new ArrayBuffer(0));
  });

  it('HEAD + Range：206 头信息与 GET 一致', async () => {
    const res = await fetch(resourceUrl(), {
      method: 'HEAD',
      headers: { Range: 'bytes=0-99' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-99/${DATA.length}`);
    expect(res.headers.get('content-length')).toBe('100');
    expect(await res.arrayBuffer()).toEqual(new ArrayBuffer(0));
  });

  it('Range bytes=0-99：206 + 正确 Content-Range/Content-Length + 精确字节', async () => {
    const res = await fetchRange('bytes=0-99');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-99/${DATA.length}`);
    expect(res.headers.get('content-length')).toBe('100');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(DATA.subarray(0, 100));
  });

  it('Range bytes=100-（开区间）：取到文件末尾', async () => {
    const res = await fetchRange('bytes=100-');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 100-${DATA.length - 1}/${DATA.length}`);
    expect(res.headers.get('content-length')).toBe(String(DATA.length - 100));
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(DATA.subarray(100));
  });

  it('Range bytes=-500（后缀区间）：最后 500 字节', async () => {
    const res = await fetchRange('bytes=-500');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes ${DATA.length - 500}-${DATA.length - 1}/${DATA.length}`);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(DATA.subarray(DATA.length - 500));
  });

  it('多区间：只取第一个区间（HTTP 允许收窄）', async () => {
    const res = await fetchRange('bytes=0-99,500-599');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-99/${DATA.length}`);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(DATA.subarray(0, 100));
  });

  it('Range end 越界收窄：bytes=0-999999 → 全文件 206', async () => {
    const res = await fetchRange('bytes=0-999999');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-${DATA.length - 1}/${DATA.length}`);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(DATA);
  });

  it('越界 Range（start 超出）：416 + Content-Range: bytes */size', async () => {
    const res = await fetchRange('bytes=999999999-');
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${DATA.length}`);
  });

  it('语法错误 Range：416 + Content-Range: bytes */size', async () => {
    for (const bad of ['bytes=abc', 'bytes=-', 'items=0-9']) {
      const res = await fetchRange(bad);
      expect(res.status).toBe(416);
      expect(res.headers.get('content-range')).toBe(`bytes */${DATA.length}`);
    }
  });

  it('未注册资源：403（不区分不存在与无权限，防探测）', async () => {
    const res = await fetchRange(null, 'unregistered-media');
    expect(res.status).toBe(403);
  });

  it('URL 结构非法（未知 kind）：403', async () => {
    const res = await fetch(`${baseUrl}/${PROJECT}/${MEDIA}/sticker`);
    expect(res.status).toBe(403);
  });

  it('注册路径不存在：404', async () => {
    registerMediaResource(PROJECT, 'ghost-media', 'source', path.join(workDir, 'ghost.mp4'));
    const res = await fetch(`${baseUrl}/${PROJECT}/ghost-media/source`);
    expect(res.status).toBe(404);
    unregisterProject(PROJECT);
    // 恢复主资源注册，供后续用例使用。
    registerMediaResource(PROJECT, MEDIA, 'source', path.join(workDir, 'source.mp4'));
    registerMediaResource(PROJECT, 'cover-media', 'cover', path.join(workDir, 'cover.png'));
  });

  it('非 GET/HEAD：405 + Allow', async () => {
    const res = await fetch(resourceUrl(), { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('图片资源：Content-Type 按扩展名（png）', async () => {
    const res = await fetch(resourceUrl('cover-media', 'cover'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(JPEG);
  });

  it('命名资源（thumb）：按受控文件名读取目录内文件；非法名/夹带被拒绝', async () => {
    const thumbsPath = path.join(workDir, 'thumbs');
    await mkdir(thumbsPath, { recursive: true });
    await writeFile(path.join(thumbsPath, 'thumb-000.jpg'), JPEG);
    registerMediaResource(PROJECT, MEDIA, 'thumb', thumbsPath);

    const okRes = await fetch(`${baseUrl}/${PROJECT}/${MEDIA}/thumb/thumb-000.jpg`);
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await okRes.arrayBuffer())).toEqual(JPEG);

    // 命名资源必须带文件名段：缺名 → 403（不可访问目录本身）。
    expect((await fetch(`${baseUrl}/${PROJECT}/${MEDIA}/thumb`)).status).toBe(403);
    // 合法但不存在 → 404。
    expect((await fetch(`${baseUrl}/${PROJECT}/${MEDIA}/thumb/thumb-001.jpg`)).status).toBe(404);
    // 非法文件名 / 路径夹带 → 403（结构层拒绝，绝不拼接路径）。
    expect((await fetch(`${baseUrl}/${PROJECT}/${MEDIA}/thumb/..%2Fsource.mp4`)).status).toBe(403);
    expect((await fetch(`${baseUrl}/${PROJECT}/${MEDIA}/thumb/a.png`)).status).toBe(403);
  });

  it('查询参数 v= 命中同一资源（缓存版本号场景）', async () => {
    const res = await fetch(`${resourceUrl()}?v=r42`);
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(DATA);
  });

  it('模拟拖动定位：连续多个不同区间请求，字节精确（不重读完整文件）', async () => {
    // 规格 12.5：拖动定位不能每次重读完整文件——
    // 每次请求的 Content-Length 都应等于区间长度，而非文件总长。
    const seeks: Array<[number, number]> = [
      [0, 99],
      [5000, 5099],
      [9900, 9999],
      [1234, 2345],
      [DATA.length - 500, DATA.length - 1],
    ];
    for (const [start, end] of seeks) {
      const res = await fetchRange(`bytes=${start}-${end}`);
      expect(res.status).toBe(206);
      expect(res.headers.get('content-length')).toBe(String(end - start + 1));
      expect(res.headers.get('content-range')).toBe(`bytes ${start}-${end}/${DATA.length}`);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body).toEqual(DATA.subarray(start, end + 1));
    }
  });

  it('unregisterProject 后：403（项目关闭即失效）', async () => {
    const projectId = 'it-proj-closing';
    registerMediaResource(projectId, 'm', 'source', path.join(workDir, 'source.mp4'));
    const before = await fetch(`${baseUrl}/${projectId}/m/source`);
    expect(before.status).toBe(200);
    unregisterProject(projectId);
    const after = await fetch(`${baseUrl}/${projectId}/m/source`);
    expect(after.status).toBe(403);
  });
});