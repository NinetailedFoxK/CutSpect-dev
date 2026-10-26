import { describe, expect, it } from 'vitest';
import type { ProjectMedia, ProjectSnapshot, ProjectView } from '../src/shared/api-types';
import {
  createInitialSnapshot,
  DEFAULT_VIEW_WINDOW_MS,
  isSafeProjectRelativePath,
  migrateTimelineView,
  needsTimelineViewMigration,
  TIMELINE_VIEW_VERSION,
  validateProjectSnapshot,
} from '../src/shared/schema';

/**
 * shared/schema 测试（规格 11.2 / 11.3）。
 * 覆盖自动化清单要求：schema 拒绝坏数据、路径穿越、初始快照有效性。
 */

function makeMedia(overrides: Partial<ProjectMedia> = {}): ProjectMedia {
  return {
    id: 'media-1',
    originalName: '原视频.mp4',
    sourcePath: 'media/source.mp4',
    playbackPath: null,
    sha256: 'a'.repeat(64),
    sizeBytes: 1024,
    durationMs: 60_000,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    audioCodec: 'aac',
    avgFrameRate: { num: 30, den: 1 },
    isVfr: false,
    isHdr: false,
    ...overrides,
  };
}

function validSnapshot(): ProjectSnapshot {
  return createInitialSnapshot({ projectId: 'proj-1', name: '测试项目', media: makeMedia() });
}

/** 深拷贝以便逐字段破坏。 */
function clone(snapshot: ProjectSnapshot): ProjectSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ProjectSnapshot;
}

describe('createInitialSnapshot（规格 5.1 / 7.1）', () => {
  it('生成的默认快照通过整体校验', () => {
    const result = validateProjectSnapshot(validSnapshot());
    expect(result.ok).toBe(true);
  });

  it('曲线首尾端点为 0 / durationMs 且值为 50；段落与非终点边界一一对应', () => {
    const snapshot = validSnapshot();
    expect(snapshot.curve.nodes.map((n) => n.timeMs)).toEqual([0, 60_000]);
    expect(snapshot.curve.nodes.every((n) => n.value === 50)).toBe(true);
    expect(snapshot.boundaries).toHaveLength(2);
    expect(snapshot.sections).toHaveLength(1);
    expect(snapshot.sections[0]?.startBoundaryId).toBe(snapshot.boundaries[0]?.id);
  });

  it('默认视图窗口为片头 120 秒、默认为谱面视图（视频保持干净）', () => {
    const longDuration = 14 * 60 * 1000 + 32_000; // 14:32
    const snapshot = createInitialSnapshot({
      projectId: 'p-long',
      name: '长视频',
      media: makeMedia({ durationMs: longDuration }),
    });
    expect(snapshot.view.viewStartMs).toBe(0);
    expect(snapshot.view.viewEndMs).toBe(DEFAULT_VIEW_WINDOW_MS);
    expect(snapshot.view.viewEndMs).toBeLessThan(longDuration);
    expect(snapshot.view.canvasLayout).toBe('sheet');
  });

  it('短片默认窗口不超过总时长', () => {
    const snapshot = validSnapshot();
    expect(snapshot.view.viewEndMs).toBe(60_000);
    expect(validateProjectSnapshot(snapshot).ok).toBe(true);
  });
});

describe('validateProjectSnapshot：结构级拒绝（zod）', () => {
  it('durationMs 非正数被拒绝', () => {
    const bad = clone(validSnapshot());
    bad.media.durationMs = 0;
    const result = validateProjectSnapshot(bad);
    expect(result.ok).toBe(false);
  });

  it('sha256 非 64 位十六进制被拒绝', () => {
    const bad = clone(validSnapshot());
    bad.media.sha256 = 'xyz';
    expect(validateProjectSnapshot(bad).ok).toBe(false);
  });

  it('标注标题超过 80 字符被拒绝', () => {
    const bad = clone(validSnapshot());
    bad.annotations.push({
      id: 'a1',
      timeMs: 1000,
      title: 'x'.repeat(81),
      body: '',
      labelOffset: { x: 0, y: 0 },
    });
    expect(validateProjectSnapshot(bad).ok).toBe(false);
  });
});

describe('validateProjectSnapshot：集合级不变量', () => {
  it('节点时间未严格递增被拒绝', () => {
    const bad = clone(validSnapshot());
    bad.curve.nodes.splice(1, 0, {
      id: 'mid',
      timeMs: 0,
      value: 50,
      outMode: 'auto',
      inHandle: null,
      outHandle: null,
    });
    const result = validateProjectSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(' ')).toContain('时间差不小于');
    }
  });

  it('末节点时间不等于 durationMs 被拒绝', () => {
    const bad = clone(validSnapshot());
    const last = bad.curve.nodes[bad.curve.nodes.length - 1];
    if (last) {
      last.timeMs = 59_999;
    }
    expect(validateProjectSnapshot(bad).ok).toBe(false);
  });

  it('节点值越界 0—100 被拒绝', () => {
    const bad = clone(validSnapshot());
    const first = bad.curve.nodes[0];
    if (first) {
      first.value = 120;
    }
    expect(validateProjectSnapshot(bad).ok).toBe(false);
  });

  it('贝塞尔段控制点横向顺序不单调被拒绝', () => {
    const bad = clone(validSnapshot());
    // 插入中间节点并令其为贝塞尔段（出柄右伸 40000ms）；
    // 末节点给一个左伸入柄，使 c1x(70000) > c2x(59000) → 非单调。
    bad.curve.nodes.splice(1, 0, {
      id: 'n2',
      timeMs: 30_000,
      value: 50,
      outMode: 'bezier',
      inHandle: null,
      outHandle: { dtMs: 40_000, dv: 0 },
    });
    const last = bad.curve.nodes[bad.curve.nodes.length - 1];
    if (last) {
      last.inHandle = { dtMs: -1_000, dv: 0 };
    }
    const result = validateProjectSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(' ')).toContain('控制点横向顺序');
    }
  });

  it('同一毫秒重复标注被拒绝', () => {
    const bad = clone(validSnapshot());
    bad.annotations.push(
      { id: 'a1', timeMs: 5000, title: '一', body: '', labelOffset: { x: 0, y: 0 } },
      { id: 'a2', timeMs: 5000, title: '二', body: '', labelOffset: { x: 0, y: 0 } },
    );
    expect(validateProjectSnapshot(bad).ok).toBe(false);
  });

  it('固定边界缺失终点被拒绝', () => {
    const bad = clone(validSnapshot());
    bad.boundaries[1] = { id: 'end', timeMs: 30_000, fixed: false, locked: false };
    expect(validateProjectSnapshot(bad).ok).toBe(false);
  });

  it('相邻边界间隔小于 100ms 被拒绝', () => {
    const bad = clone(validSnapshot());
    bad.boundaries.splice(1, 0, { id: 'mid', timeMs: 50, fixed: false, locked: false });
    bad.sections.push({ id: 's2', startBoundaryId: 'mid', name: '段落 2', note: '' });
    expect(validateProjectSnapshot(bad).ok).toBe(false);
  });

  it('段落引用了不存在的边界被拒绝', () => {
    const bad = clone(validSnapshot());
    bad.sections[0] = { id: 's1', startBoundaryId: 'ghost', name: '段落 1', note: '' };
    expect(validateProjectSnapshot(bad).ok).toBe(false);
  });

  it('相对路径穿越被拒绝（规格 9.2）', () => {
    const bad = clone(validSnapshot());
    bad.media.sourcePath = '../../etc/passwd';
    const result = validateProjectSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(' ')).toContain('相对路径');
    }
  });
});

describe('isSafeProjectRelativePath（规格 11.3）', () => {
  it('接受项目内相对路径', () => {
    expect(isSafeProjectRelativePath('media/source.mp4')).toBe(true);
    expect(isSafeProjectRelativePath('cache/thumbs/a.jpg')).toBe(true);
  });

  it('拒绝绝对路径、盘符与穿越', () => {
    expect(isSafeProjectRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeProjectRelativePath('C:/Windows/system32')).toBe(false);
    expect(isSafeProjectRelativePath('\\\\server\\share')).toBe(false);
    expect(isSafeProjectRelativePath('../secret')).toBe(false);
    expect(isSafeProjectRelativePath('media/../../secret')).toBe(false);
    expect(isSafeProjectRelativePath('')).toBe(false);
  });
});
describe('migrateTimelineView（时间轨修复 §6.2：一次性窗口迁移）', () => {
  const LONG = 14 * 60 * 1000 + 32_000; // 14:32

  function viewOf(durationMs: number, over: Partial<ProjectView> = {}): ProjectView {
    const snapshot = createInitialSnapshot({
      projectId: 'p-migrate',
      name: '迁移',
      media: makeMedia({ durationMs }),
    });
    return { ...snapshot.view, timelineViewVersion: undefined, ...over };
  }

  it('旧项目"接近全片"视图迁到以播放头为中心的 120 秒窗口并写入版本', () => {
    const view = viewOf(LONG, { viewStartMs: 0, viewEndMs: LONG, playheadMs: 8 * 60 * 1000 });
    expect(needsTimelineViewMigration(view, LONG)).toBe(true);
    const migrated = migrateTimelineView(view, LONG);
    expect(migrated.viewEndMs - migrated.viewStartMs).toBe(DEFAULT_VIEW_WINDOW_MS);
    expect(migrated.viewStartMs).toBeLessThanOrEqual(8 * 60 * 1000);
    expect(migrated.viewEndMs).toBeGreaterThanOrEqual(8 * 60 * 1000);
    expect(migrated.timelineViewVersion).toBe(TIMELINE_VIEW_VERSION);
  });

  it('已含迁移版本的项目不再迁移（保持原样）', () => {
    const view = viewOf(LONG, { viewStartMs: 0, viewEndMs: LONG, timelineViewVersion: 1 });
    expect(needsTimelineViewMigration(view, LONG)).toBe(false);
    expect(migrateTimelineView(view, LONG)).toBe(view);
  });

  it('已有自定义缩放（跨度小）只补写版本，窗口范围不变', () => {
    const view = viewOf(LONG, { viewStartMs: 120_000, viewEndMs: 300_000 });
    const migrated = migrateTimelineView(view, LONG);
    expect(migrated.viewStartMs).toBe(120_000);
    expect(migrated.viewEndMs).toBe(300_000);
    expect(migrated.timelineViewVersion).toBe(TIMELINE_VIEW_VERSION);
  });

  it('短片（短于默认窗口）不迁移', () => {
    const view = viewOf(60_000, { viewStartMs: 0, viewEndMs: 60_000 });
    expect(needsTimelineViewMigration(view, 60_000)).toBe(false);
    expect(migrateTimelineView(view, 60_000).viewEndMs).toBe(60_000);
  });

  it('迁移幂等：迁移结果再次迁移保持不变', () => {
    const view = viewOf(LONG, { viewStartMs: 0, viewEndMs: LONG, playheadMs: 0 });
    const once = migrateTimelineView(view, LONG);
    expect(migrateTimelineView(once, LONG)).toBe(once);
  });
});