import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  DEFAULT_KEYMAP,
  bindingOwner,
  commandForEvent,
  commandForWheel,
  eventToBinding,
  findConflicts,
  formatBinding,
  isValidBinding,
  normalizeKey,
  parseBinding,
  resolveKeymap,
  wheelToBinding,
} from '../src/shared/keymap';

interface WheelEv {
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}


/** 快捷键键位模型测试（v1.1 需求 6）：默认表、规范化、匹配、冲突。 */

interface Ev {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}
const ev = (key: string, mods: Partial<Omit<Ev, 'key'>> = {}): Ev => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('默认键位表', () => {
  it('覆盖全部命令、取值合法且无冲突', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(isValidBinding(DEFAULT_KEYMAP[id])).toBe(true);
    }
    expect(findConflicts(resolveKeymap(null))).toEqual([]);
  });

  it('双层键位：通用层沿用剪辑习惯，左手层为拉片台专属映射', () => {
    // 通用剪辑层
    expect(DEFAULT_KEYMAP['play.forward']).toBe('l');
    expect(DEFAULT_KEYMAP['mark.add']).toBe('m');
    expect(DEFAULT_KEYMAP['mark.next']).toBe('shift+m');
    expect(DEFAULT_KEYMAP['mark.prev']).toBe('mod+shift+m');
    expect(DEFAULT_KEYMAP['tool.select']).toBe('v');
    expect(DEFAULT_KEYMAP['play.toggle']).toBe('space');
    expect(DEFAULT_KEYMAP['help.shortcuts']).toBe('question');
    // 拉片台左手快速层
    expect(DEFAULT_KEYMAP['left.prevFrame']).toBe('a');
    expect(DEFAULT_KEYMAP['left.nextFrame']).toBe('d');
    expect(DEFAULT_KEYMAP['left.prev5']).toBe('shift+a');
    expect(DEFAULT_KEYMAP['left.nextMark']).toBe('alt+d');
    expect(DEFAULT_KEYMAP['node.add']).toBe('q');
    expect(DEFAULT_KEYMAP['mark.addAlt']).toBe('w');
    expect(DEFAULT_KEYMAP['section.add']).toBe('e');
    expect(DEFAULT_KEYMAP['draw.freehandOnce']).toBe('r');
    expect(DEFAULT_KEYMAP['draw.lineOnce']).toBe('g');
    expect(DEFAULT_KEYMAP['draw.lineHold']).toBe('shift+g');
    expect(DEFAULT_KEYMAP['curve.auto']).toBe('1');
    expect(DEFAULT_KEYMAP['node.stepPrev']).toBe('comma');
    expect(DEFAULT_KEYMAP['node.stepNext5']).toBe('shift+period');
    expect(DEFAULT_KEYMAP['node.valueUp']).toBe('alt+up');
    // 时间线视图（Control + 滚轮缩放）
    expect(DEFAULT_KEYMAP['timeline.follow']).toBe('f');
    expect(DEFAULT_KEYMAP['timeline.wheelZoom']).toBe('ctrl+wheel');
    expect(DEFAULT_KEYMAP['timeline.wheelPan']).toBe('shift+wheel');
  });
});

describe('normalizeKey / parseBinding / isValidBinding', () => {
  it('具名键与单字符归一化', () => {
    expect(normalizeKey(' ')).toBe('space');
    expect(normalizeKey('ArrowLeft')).toBe('arrowleft');
    expect(normalizeKey('Escape')).toBe('escape');
    expect(normalizeKey('=')).toBe('equals');
    expect(normalizeKey('+')).toBe('plus');
    expect(normalizeKey('?')).toBe('question');
    expect(normalizeKey('A')).toBe('a');
    expect(normalizeKey('Shift')).toBeNull();
  });

  it('parseBinding 解析修饰键与主键', () => {
    expect(parseBinding('mod+shift+z')).toEqual({
      key: 'z',
      mod: true,
      ctrl: false,
      shift: true,
      alt: false,
    });
    expect(parseBinding('arrowleft')).toEqual({
      key: 'arrowleft',
      mod: false,
      ctrl: false,
      shift: false,
      alt: false,
    });
    expect(parseBinding('mod')).toBeNull();
    expect(parseBinding('a+b')).toBeNull();
    expect(parseBinding('')).toBeNull();
  });

  it('isValidBinding 只接受字母数字单键或具名键', () => {
    expect(isValidBinding('a')).toBe(true);
    expect(isValidBinding('mod+shift+z')).toBe(true);
    expect(isValidBinding('arrowleft')).toBe(true);
    expect(isValidBinding('question')).toBe(true);
    expect(isValidBinding('shift')).toBe(false);
    expect(isValidBinding('zz')).toBe(false);
    expect(isValidBinding('-')).toBe(false);
  });
});

describe('eventToBinding（平台差异）', () => {
  it('mac 用 Command（meta）、win 用 Ctrl；mac 的 Control 单独记为 ctrl', () => {
    expect(eventToBinding(ev('z', { metaKey: true }), true)).toBe('mod+z');
    expect(eventToBinding(ev('z', { metaKey: true }), false)).toBe('z');
    expect(eventToBinding(ev('z', { ctrlKey: true }), false)).toBe('mod+z');
    // macOS：Control 与 Command 不同，需显式区分（用户可绑 ctrl+…）。
    expect(eventToBinding(ev('z', { ctrlKey: true }), true)).toBe('ctrl+z');
    expect(eventToBinding(ev('z', { metaKey: true, ctrlKey: true }), true)).toBe('mod+ctrl+z');
  });

  it('Shift / Alt 与具名键组合；符号键不叠加 Shift', () => {
    expect(eventToBinding(ev('a', { shiftKey: true }), true)).toBe('shift+a');
    expect(eventToBinding(ev('ArrowLeft', { shiftKey: true }), true)).toBe('shift+arrowleft');
    expect(eventToBinding(ev(' ', {}), true)).toBe('space');
    expect(eventToBinding(ev('Escape', {}), true)).toBe('escape');
    expect(eventToBinding(ev('?', { shiftKey: true }), true)).toBe('question');
    // Shift+'=' 在浏览器中 key 为 '+'。
    expect(eventToBinding(ev('+', { shiftKey: true }), true)).toBe('plus');
    expect(eventToBinding(ev('=', {}), true)).toBe('equals');
  });

  it('Shift + , / . 折算为 shift+comma / shift+period（节点微调）', () => {
    expect(eventToBinding(ev(','), true)).toBe('comma');
    expect(eventToBinding(ev('.', {}), true)).toBe('period');
    expect(eventToBinding(ev('<', { shiftKey: true }), true)).toBe('shift+comma');
    expect(eventToBinding(ev('>', { shiftKey: true }), true)).toBe('shift+period');
  });

  it('纯修饰键返回 null', () => {
    expect(eventToBinding(ev('Shift', { shiftKey: true }), true)).toBeNull();
    expect(eventToBinding(ev('Meta', { metaKey: true }), true)).toBeNull();
  });
});

describe('formatBinding（按平台展示）', () => {
  it('mac 用符号、非 mac 用 Ctrl/Shift', () => {
    expect(formatBinding('mod+shift+z', true)).toBe('⌘⇧Z');
    expect(formatBinding('mod+shift+z', false)).toBe('Ctrl+Shift+Z');
    expect(formatBinding('arrowleft', true)).toBe('←');
    expect(formatBinding('space', true)).toBe('Space');
    expect(formatBinding('question', true)).toBe('?');
    expect(formatBinding('equals', true)).toBe('=');
  });
});

describe('resolveKeymap / 冲突', () => {
  it('合法覆盖生效，非法与未知命令被忽略', () => {
    const resolved = resolveKeymap({ 'play.toggle': 'p', 'draw.lineOnce': '-', nope: 'x' });
    expect(resolved['play.toggle']).toBe('p');
    expect(resolved['draw.lineOnce']).toBe(DEFAULT_KEYMAP['draw.lineOnce']);
    expect(Object.keys(resolved)).toHaveLength(COMMANDS.length);
  });

  it('findConflicts 找出被多命令占用的键位', () => {
    const resolved = resolveKeymap({ 'play.toggle': 'm' });
    const conflicts = findConflicts(resolved);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.binding).toBe('m');
    expect(conflicts[0]?.commandIds.sort()).toEqual(['mark.add', 'play.toggle']);
  });

  it('bindingOwner 排除自身', () => {
    const resolved = resolveKeymap(null);
    expect(bindingOwner(resolved, 'm', 'mark.add')).toBeNull();
    expect(bindingOwner(resolved, 'm', 'draw.lineOnce')).toBe('mark.add');
  });
});

describe('commandForEvent（默认键位匹配）', () => {
  const keymap = resolveKeymap(null);

  it('按默认键位解析命令（双层）', () => {
    expect(commandForEvent(keymap, ev(' '), true)).toBe('play.toggle');
    expect(commandForEvent(keymap, ev('m'), true)).toBe('mark.add');
    expect(commandForEvent(keymap, ev('M', { shiftKey: true }), true)).toBe('mark.next');
    expect(commandForEvent(keymap, ev('m', { metaKey: true, shiftKey: true }), true)).toBe('mark.prev');
    // 拉片台左手快速层
    expect(commandForEvent(keymap, ev('a'), true)).toBe('left.prevFrame');
    expect(commandForEvent(keymap, ev('d'), true)).toBe('left.nextFrame');
    expect(commandForEvent(keymap, ev('A', { shiftKey: true }), true)).toBe('left.prev5');
    expect(commandForEvent(keymap, ev('a', { altKey: true }), true)).toBe('left.prevMark');
    expect(commandForEvent(keymap, ev('q'), true)).toBe('node.add');
    expect(commandForEvent(keymap, ev('w'), true)).toBe('mark.addAlt');
    expect(commandForEvent(keymap, ev('e'), true)).toBe('section.add');
    expect(commandForEvent(keymap, ev('r'), true)).toBe('draw.freehandOnce');
    expect(commandForEvent(keymap, ev('g'), true)).toBe('draw.lineOnce');
    expect(commandForEvent(keymap, ev('1'), true)).toBe('curve.auto');
    expect(commandForEvent(keymap, ev(','), true)).toBe('node.stepPrev');
    expect(commandForEvent(keymap, ev('>', { shiftKey: true }), true)).toBe('node.stepNext5');
    expect(commandForEvent(keymap, ev('ArrowUp', { altKey: true }), true)).toBe('node.valueUp');
    // 通用剪辑层
    expect(commandForEvent(keymap, ev('l'), true)).toBe('play.forward');
    expect(commandForEvent(keymap, ev('j'), true)).toBe('play.reverse');
    expect(commandForEvent(keymap, ev('k'), true)).toBe('play.pause');
    expect(commandForEvent(keymap, ev('ArrowLeft'), true)).toBe('play.prevFrame');
    expect(commandForEvent(keymap, ev('ArrowLeft', { shiftKey: true }), true)).toBe('play.prev5');
    expect(commandForEvent(keymap, ev('?', { shiftKey: true }), true)).toBe('help.shortcuts');
    expect(commandForEvent(keymap, ev('f'), true)).toBe('timeline.follow');
    expect(commandForEvent(keymap, ev('z', { metaKey: true }), true)).toBe('file.undo');
    expect(commandForEvent(keymap, ev('z', { metaKey: true, shiftKey: true }), true)).toBe('file.redo');
  });

  it('未绑定键返回 null', () => {
    expect(commandForEvent(keymap, ev('n'), true)).toBeNull();
  });
});
describe('滚轮键位（wheel）', () => {
  const wheel = (mods: Partial<Omit<WheelEv, 'deltaX' | 'deltaY'>> = {}): WheelEv => ({
    deltaX: 0,
    deltaY: 120,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it('wheelToBinding：无修饰；Control 跨平台统一记为 ctrl，Command 记为 mod', () => {
    expect(wheelToBinding(wheel(), true)).toBe('wheel');
    expect(wheelToBinding(wheel({ metaKey: true }), true)).toBe('mod+wheel');
    expect(wheelToBinding(wheel({ ctrlKey: true }), true)).toBe('ctrl+wheel');
    expect(wheelToBinding(wheel({ ctrlKey: true }), false)).toBe('ctrl+wheel');
    expect(wheelToBinding(wheel({ altKey: true }), true)).toBe('alt+wheel');
    expect(wheelToBinding(wheel({ shiftKey: true }), true)).toBe('shift+wheel');
  });

  it('无位移返回 null', () => {
    expect(
      wheelToBinding(
        { deltaX: 0, deltaY: 0, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
        true,
      ),
    ).toBeNull();
  });

  it('默认绑定：Control+滚轮缩放、Shift+滚轮平移（通用剪辑习惯）', () => {
    expect(DEFAULT_KEYMAP['timeline.wheelZoom']).toBe('ctrl+wheel');
    expect(DEFAULT_KEYMAP['timeline.wheelPan']).toBe('shift+wheel');
    const keymap = resolveKeymap(null);
    expect(commandForWheel(keymap, wheel({ ctrlKey: true }), true)).toBe('timeline.wheelZoom');
    expect(commandForWheel(keymap, wheel({ shiftKey: true }), true)).toBe('timeline.wheelPan');
    expect(commandForWheel(keymap, wheel({ altKey: true }), true)).toBeNull();
  });

  it('滚轮缩放可改绑到其它修饰键', () => {
    const keymap = resolveKeymap({ 'timeline.wheelZoom': 'alt+wheel' });
    expect(commandForWheel(keymap, wheel({ altKey: true }), true)).toBe('timeline.wheelZoom');
    expect(commandForWheel(keymap, wheel({ ctrlKey: true }), true)).toBeNull();
    expect(isValidBinding('ctrl+wheel')).toBe(true);
    expect(parseBinding('ctrl+wheel')).toEqual({
      key: 'wheel',
      mod: false,
      ctrl: true,
      shift: false,
      alt: false,
    });
  });

  it('滚轮键位的展示文本', () => {
    expect(formatBinding('ctrl+wheel', true)).toBe('⌃滚轮');
    expect(formatBinding('alt+wheel', false)).toBe('Alt+滚轮');
    expect(formatBinding('shift+wheel', true)).toBe('⇧滚轮');
  });
});