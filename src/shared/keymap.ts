/**
 * 快捷键键位模型（v1.1 需求 6）。
 *
 * 纯数据 + 纯函数，main / renderer 两侧共用：
 * - CommandId：可绑定命令的唯一标识（播放、逐帧、导航、标注、工具、时间线、文件）。
 * - 键位用规范化字符串表示（如 `mod+shift+z`、`arrowleft`、`space`、`backslash`），
 *   其中 `mod` 在 macOS 映射为 Command、Windows/Linux 映射为 Ctrl（需求 6.1）。
 * - 与平台无关：同一份绑定在两端按 isMac 解释/展示，便于跨平台共用设置。
 *
 * 本模块不依赖 DOM，可在 vitest（node）下直接测试。
 */

export type CommandCategory = 'general' | 'leftHand';

export type CommandId =
  /* 通用剪辑层：播放与定位 */
  | 'play.toggle'
  | 'play.prevFrame'
  | 'play.nextFrame'
  | 'play.prev5'
  | 'play.next5'
  | 'play.reverse'
  | 'play.pause'
  | 'play.forward'
  | 'nav.start'
  | 'nav.end'
  | 'nav.prevMark'
  | 'nav.nextMark'
  /* 通用剪辑层：标记与编辑 */
  | 'mark.add'
  | 'mark.next'
  | 'mark.prev'
  | 'tool.select'
  | 'edit.delete'
  | 'edit.escape'
  | 'edit.selectAll'
  /* 通用剪辑层：时间线视图 */
  | 'timeline.zoomIn'
  | 'timeline.zoomInAlt'
  | 'timeline.zoomOut'
  | 'timeline.fit'
  | 'timeline.follow'
  | 'timeline.wheelZoom'
  | 'timeline.wheelPan'
  /* 通用剪辑层：文件与帮助 */
  | 'file.undo'
  | 'file.redo'
  | 'file.save'
  | 'help.shortcuts'
  /* 拉片台左手快速层：播放辅助（右手握鼠标） */
  | 'left.prevFrame'
  | 'left.nextFrame'
  | 'left.prev5'
  | 'left.next5'
  | 'left.prevMark'
  | 'left.nextMark'
  /* 拉片台左手快速层：三种分析对象（即时动作，不进入工具模式） */
  | 'node.add'
  | 'mark.addAlt'
  | 'section.add'
  /* 拉片台左手快速层：曲线绘制 */
  | 'draw.freehandOnce'
  | 'draw.lineOnce'
  | 'draw.freehandHold'
  | 'draw.lineHold'
  /* 拉片台左手快速层：曲线类型 */
  | 'curve.auto'
  | 'curve.linear'
  | 'curve.bezier'
  /* 拉片台左手快速层：节点精确调整 */
  | 'node.stepPrev'
  | 'node.stepNext'
  | 'node.stepPrev5'
  | 'node.stepNext5'
  | 'node.valueUp'
  | 'node.valueDown'
  | 'node.valueUp5'
  | 'node.valueDown5';

export interface CommandMeta {
  id: CommandId;
  category: CommandCategory;
  label: string;
  description: string;
}

/** 命令表（顺序即速查面板展示顺序）。 */
export const COMMANDS: readonly CommandMeta[] = [
  /* —— 通用剪辑层 —— */
  { id: 'play.toggle', category: 'general', label: '播放 / 暂停', description: '切换视频播放状态' },
  { id: 'play.prevFrame', category: 'general', label: '后退一帧', description: '按视频帧率后退一帧' },
  { id: 'play.nextFrame', category: 'general', label: '前进一帧', description: '按视频帧率前进一帧' },
  { id: 'play.prev5', category: 'general', label: '后退五帧', description: '按视频帧率后退五帧' },
  { id: 'play.next5', category: 'general', label: '前进五帧', description: '按视频帧率前进五帧' },
  { id: 'play.reverse', category: 'general', label: '反向播放', description: '反向播放（J）；重复按提高倍速' },
  { id: 'play.pause', category: 'general', label: '暂停', description: '暂停播放（K）' },
  { id: 'play.forward', category: 'general', label: '正向播放', description: '正向播放（L）；重复按提高倍速' },
  { id: 'nav.start', category: 'general', label: '跳到开头', description: '播放头移到 0' },
  { id: 'nav.end', category: 'general', label: '跳到结尾', description: '播放头移到末尾' },
  { id: 'nav.prevMark', category: 'general', label: '上一个分析点', description: '跳到前一个节点 / 标注 / 边界' },
  { id: 'nav.nextMark', category: 'general', label: '下一个分析点', description: '跳到后一个节点 / 标注 / 边界' },
  { id: 'mark.add', category: 'general', label: '添加标注', description: '在播放头添加标注并选中（行业通用）' },
  { id: 'mark.next', category: 'general', label: '下一个标注', description: '跳到下一条标注' },
  { id: 'mark.prev', category: 'general', label: '上一个标注', description: '跳到上一条标注' },
  { id: 'tool.select', category: 'general', label: '智能选择', description: '选择 / 移动节点、框选、双击加节点' },
  { id: 'edit.delete', category: 'general', label: '删除选中对象', description: '删除当前选中的节点 / 标注 / 分段' },
  { id: 'edit.escape', category: 'general', label: '取消 / 清除选择', description: '取消当前操作、关闭浮层并清除选择' },
  { id: 'edit.selectAll', category: 'general', label: '全选同类对象', description: '选择当前范围内全部同类对象' },
  { id: 'timeline.zoomIn', category: 'general', label: '放大时间线', description: '以播放头为锚点放大' },
  { id: 'timeline.zoomInAlt', category: 'general', label: '放大时间线（+）', description: '键盘 + 键放大时间线' },
  { id: 'timeline.zoomOut', category: 'general', label: '缩小时间线', description: '以播放头为锚点缩小' },
  { id: 'timeline.fit', category: 'general', label: '适应全部', description: '显示整条视频' },
  { id: 'timeline.follow', category: 'general', label: '回到播放头并跟随', description: '播放头居中并恢复自动跟随' },
  {
    id: 'timeline.wheelZoom',
    category: 'general',
    label: '滚轮缩放时间线',
    description: '按住 Control 滚动滚轮（含鼠标中键、触控板捏合），以指针位置为锚点缩放',
  },
  {
    id: 'timeline.wheelPan',
    category: 'general',
    label: '滚轮平移时间线',
    description: '按住 Shift 滚动滚轮（或触控板双指横滑），左右平移时间线',
  },
  { id: 'file.undo', category: 'general', label: '撤销', description: '撤销上一步编辑' },
  { id: 'file.redo', category: 'general', label: '重做', description: '重做已撤销的编辑' },
  { id: 'file.save', category: 'general', label: '保存', description: '立即写入项目' },
  { id: 'help.shortcuts', category: 'general', label: '快捷键速查', description: '打开本面板' },

  /* —— 拉片台左手快速层 —— */
  { id: 'left.prevFrame', category: 'leftHand', label: '后退一帧（左手）', description: '右手握鼠标时用 A 后退一帧' },
  { id: 'left.nextFrame', category: 'leftHand', label: '前进一帧（左手）', description: '右手握鼠标时用 D 前进一帧' },
  { id: 'left.prev5', category: 'leftHand', label: '后退五帧（左手）', description: 'Shift+A 后退五帧' },
  { id: 'left.next5', category: 'leftHand', label: '前进五帧（左手）', description: 'Shift+D 前进五帧' },
  { id: 'left.prevMark', category: 'leftHand', label: '上一个分析点（左手）', description: '⌥A 跳到上一个分析点' },
  { id: 'left.nextMark', category: 'leftHand', label: '下一个分析点（左手）', description: '⌥D 跳到下一个分析点' },
  { id: 'node.add', category: 'leftHand', label: '添加曲线节点', description: '在播放头添加节点并选中' },
  { id: 'mark.addAlt', category: 'leftHand', label: '添加标注（W）', description: '在播放头添加标注；M 的左手快速别名' },
  { id: 'section.add', category: 'leftHand', label: '添加分段边界', description: '在播放头创建段落边界并选中' },
  { id: 'draw.freehandOnce', category: 'leftHand', label: '自由绘制一笔', description: '完成一笔自由曲线后自动回到选择' },
  { id: 'draw.lineOnce', category: 'leftHand', label: '直线绘制一笔', description: '拖拽把一段替换为直线后回到选择' },
  { id: 'draw.freehandHold', category: 'leftHand', label: '持续自由绘制', description: '保持自由绘制工具，连续画多笔' },
  { id: 'draw.lineHold', category: 'leftHand', label: '持续直线绘制', description: '保持直线工具，连续替换多段' },
  { id: 'curve.auto', category: 'leftHand', label: '曲线自动平滑', description: '把选中节点所在段设为自动平滑' },
  { id: 'curve.linear', category: 'leftHand', label: '曲线改直线', description: '把选中节点所在段改为直线' },
  { id: 'curve.bezier', category: 'leftHand', label: '曲线转贝塞尔', description: '把选中节点所在段转为贝塞尔（编辑控制柄）' },
  { id: 'node.stepPrev', category: 'leftHand', label: '节点前移一帧', description: '选中节点沿时间轴前移一帧（,）' },
  { id: 'node.stepNext', category: 'leftHand', label: '节点后移一帧', description: '选中节点沿时间轴后移一帧（.）' },
  { id: 'node.stepPrev5', category: 'leftHand', label: '节点前移五帧', description: '选中节点前移五帧（Shift+,）' },
  { id: 'node.stepNext5', category: 'leftHand', label: '节点后移五帧', description: '选中节点后移五帧（Shift+.）' },
  { id: 'node.valueUp', category: 'leftHand', label: '节点数值 +1', description: '选中节点数值增加 1（⌥↑）' },
  { id: 'node.valueDown', category: 'leftHand', label: '节点数值 -1', description: '选中节点数值减少 1（⌥↓）' },
  { id: 'node.valueUp5', category: 'leftHand', label: '节点数值 +5', description: '选中节点数值增加 5（⌥⇧↑）' },
  { id: 'node.valueDown5', category: 'leftHand', label: '节点数值 -5', description: '选中节点数值减少 5（⌥⇧↓）' },
];

/** 默认键位：通用剪辑层沿用剪辑软件习惯，左手层为拉片台专属快速映射。 */
export const DEFAULT_KEYMAP: Readonly<Record<CommandId, string>> = {
  'play.toggle': 'space',
  'play.prevFrame': 'arrowleft',
  'play.nextFrame': 'arrowright',
  'play.prev5': 'shift+arrowleft',
  'play.next5': 'shift+arrowright',
  'play.reverse': 'j',
  'play.pause': 'k',
  'play.forward': 'l',
  'nav.start': 'home',
  'nav.end': 'end',
  'nav.prevMark': 'up',
  'nav.nextMark': 'down',
  'mark.add': 'm',
  'mark.next': 'shift+m',
  'mark.prev': 'mod+shift+m',
  'tool.select': 'v',
  'edit.delete': 'delete',
  'edit.escape': 'escape',
  'edit.selectAll': 'mod+a',
  'timeline.zoomIn': 'equals',
  'timeline.zoomInAlt': 'plus',
  'timeline.zoomOut': 'minus',
  'timeline.fit': 'backslash',
  'timeline.follow': 'f',
  'timeline.wheelZoom': 'ctrl+wheel',
  'timeline.wheelPan': 'shift+wheel',
  'file.undo': 'mod+z',
  'file.redo': 'mod+shift+z',
  'file.save': 'mod+s',
  'help.shortcuts': 'question',
  'left.prevFrame': 'a',
  'left.nextFrame': 'd',
  'left.prev5': 'shift+a',
  'left.next5': 'shift+d',
  'left.prevMark': 'alt+a',
  'left.nextMark': 'alt+d',
  'node.add': 'q',
  'mark.addAlt': 'w',
  'section.add': 'e',
  'draw.freehandOnce': 'r',
  'draw.lineOnce': 'g',
  'draw.freehandHold': 'shift+r',
  'draw.lineHold': 'shift+g',
  'curve.auto': '1',
  'curve.linear': '2',
  'curve.bezier': '3',
  'node.stepPrev': 'comma',
  'node.stepNext': 'period',
  'node.stepPrev5': 'shift+comma',
  'node.stepNext5': 'shift+period',
  'node.valueUp': 'alt+up',
  'node.valueDown': 'alt+down',
  'node.valueUp5': 'alt+shift+up',
  'node.valueDown5': 'alt+shift+down',
};


/** KeyboardEvent.key → 规范化键名（不带修饰）。未知具名键返回 null（不可绑定）。 */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  ' ': 'space',
  Spacebar: 'space',
  ArrowLeft: 'arrowleft',
  ArrowRight: 'arrowright',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
  Escape: 'escape',
  Delete: 'delete',
  Backspace: 'backspace',
  Enter: 'enter',
  '=': 'equals',
  '-': 'minus',
  '+': 'plus',
  '\\': 'backslash',
  '/': 'slash',
  '.': 'period',
  ',': 'comma',
  '?': 'question',
};

export function normalizeKey(key: string): string | null {
  const named = NAMED_KEYS[key];
  if (named !== undefined) {
    return named;
  }
  if (key.length !== 1) {
    return null; // 纯修饰键（Shift/Control/Alt/Meta）或未知具名键。
  }
  const lower = key.toLowerCase();
  return /[a-z0-9]/.test(lower) ? lower : key;
}

export interface ParsedBinding {
  key: string;
  mod: boolean;
  /** 显式 Control 键（macOS 上与 Command 不同；Windows/Linux 上等价于 mod，不重复出现）。 */
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** 解析规范化键位字符串；非法返回 null。 */
export function parseBinding(binding: string): ParsedBinding | null {
  if (binding.length === 0) {
    return null;
  }
  const parts = binding.split('+').filter((p) => p.length > 0);
  let key: string | null = null;
  let mod = false;
  let ctrl = false;
  let shift = false;
  let alt = false;
  for (const part of parts) {
    if (part === 'mod') {
      mod = true;
    } else if (part === 'ctrl') {
      ctrl = true;
    } else if (part === 'shift') {
      shift = true;
    } else if (part === 'alt') {
      alt = true;
    } else if (key === null) {
      key = part;
    } else {
      return null; // 出现多个非修饰键：非法。
    }
  }
  if (key === null) {
    return null;
  }
  return { key, mod, ctrl, shift, alt };
}

export function isValidBinding(binding: string): boolean {
  const parsed = parseBinding(binding);
  if (parsed === null) {
    return false;
  }
  // key 必须是单字符 [a-z0-9]，或已具名的按键 token（如 arrowleft / equals / question）。
  return parsed.key.length === 1 ? /^[a-z0-9]$/.test(parsed.key) : isKnownToken(parsed.key);
}

function isKnownToken(token: string): boolean {
  return (
    token === 'space' ||
    token === 'arrowleft' ||
    token === 'arrowright' ||
    token === 'up' ||
    token === 'down' ||
    token === 'home' ||
    token === 'end' ||
    token === 'escape' ||
    token === 'delete' ||
    token === 'backspace' ||
    token === 'enter' ||
    token === 'equals' ||
    token === 'minus' ||
    token === 'plus' ||
    token === 'backslash' ||
    token === 'slash' ||
    token === 'period' ||
    token === 'comma' ||
    token === 'question' ||
    token === 'wheel'
  );
}

/** 键盘事件 → 规范化键位字符串；纯修饰键/不可绑定键返回 null。 */
export function eventToBinding(
  event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean },
  isMac: boolean,
): string | null {
  let key = normalizeKey(event.key);
  if (key === null) {
    return null;
  }
  // Shift + , / . 在键盘上分别生成 '<' / '>'，显式折算为「带 Shift 的逗号/句号位」，
  // 以便节点前后微调（Shift+, / Shift+.）可绑定、可显示。
  let implicitShift = false;
  if (event.key === '<') {
    key = 'comma';
    implicitShift = true;
  } else if (event.key === '>') {
    key = 'period';
    implicitShift = true;
  }
  const rawSymbol = event.key.length === 1 && !/[a-z0-9]/i.test(event.key);
  const parts: string[] = [];
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (mod) {
    parts.push('mod');
  }
  // macOS 上 Control 与 Command 不同，需显式区分；Windows/Linux 上 ctrl 已计入 mod。
  if (isMac && event.ctrlKey) {
    parts.push('ctrl');
  }
  if (event.altKey) {
    parts.push('alt');
  }
  // 符号键（? / = / - 等）本身隐含 Shift，不再叠加 shift 修饰，避免绑定不可达。
  if ((event.shiftKey && !rawSymbol) || implicitShift) {
    parts.push('shift');
  }
  parts.push(key);
  return parts.join('+');
}

/** 滚轮事件形状（WheelEvent 子集，便于纯函数测试）。 */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * 滚轮事件 → 规范化键位字符串（键名固定为 `wheel`）。
 * - 无位移返回 null；
 * - macOS 上 Command（mod）与 Control（ctrl）分别记录；
 * - 鼠标中键滚动同样产生 wheel 事件，故与普通滚轮统一处理。
 */
export function wheelToBinding(event: WheelLike, _isMac: boolean): string | null {
  if (event.deltaX === 0 && event.deltaY === 0) {
    return null;
  }
  // Control 统一记为 ctrl（跨平台一致，便于「Control + 滚轮」在 macOS / Windows 共用同一绑定）；
  // Command（macOS）记为 mod。
  const parts: string[] = [];
  if (event.metaKey) {
    parts.push('mod');
  }
  if (event.ctrlKey) {
    parts.push('ctrl');
  }
  if (event.altKey) {
    parts.push('alt');
  }
  if (event.shiftKey) {
    parts.push('shift');
  }
  parts.push('wheel');
  return parts.join('+');
}

/** 滚轮事件 → 匹配到的命令（未绑定则 null）。 */
export function commandForWheel(
  keymap: Readonly<Record<CommandId, string>>,
  event: WheelLike,
  isMac: boolean,
): CommandId | null {
  const binding = wheelToBinding(event, isMac);
  if (binding === null) {
    return null;
  }
  for (const command of COMMANDS) {
    if (keymap[command.id] === binding) {
      return command.id;
    }
  }
  return null;
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  space: 'Space',
  arrowleft: '←',
  arrowright: '→',
  up: '↑',
  down: '↓',
  home: 'Home',
  end: 'End',
  escape: 'Esc',
  delete: 'Del',
  backspace: '⌫',
  enter: 'Enter',
  equals: '=',
  minus: '-',
  plus: '+',
  backslash: '\\',
  slash: '/',
  period: '.',
  comma: ',',
  question: '?',
  wheel: '滚轮',
};

/** 展示用键位文本（按平台显示 Command / Ctrl）。 */
export function formatBinding(binding: string, isMac: boolean): string {
  const parsed = parseBinding(binding);
  if (parsed === null) {
    return binding;
  }
  const parts: string[] = [];
  if (parsed.mod) {
    parts.push(isMac ? '⌘' : 'Ctrl');
  }
  if (parsed.ctrl) {
    parts.push(isMac ? '⌃' : 'Ctrl');
  }
  if (parsed.alt) {
    parts.push(isMac ? '⌥' : 'Alt');
  }
  if (parsed.shift) {
    parts.push(isMac ? '⇧' : 'Shift');
  }
  const label = KEY_LABELS[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  parts.push(label);
  return parts.join(isMac ? '' : '+');
}

/** 合并默认键位与用户覆盖（非法覆盖忽略）。 */
export function resolveKeymap(
  overrides?: Readonly<Record<string, string>> | null,
): Record<CommandId, string> {
  const result = { ...DEFAULT_KEYMAP } as Record<CommandId, string>;
  if (overrides) {
    for (const command of COMMANDS) {
      const value = overrides[command.id];
      if (typeof value === 'string' && isValidBinding(value)) {
        result[command.id] = value;
      }
    }
  }
  return result;
}

export interface KeyConflict {
  binding: string;
  commandIds: CommandId[];
}

/** 找出被多个命令占用的键位。 */
export function findConflicts(keymap: Readonly<Record<CommandId, string>>): KeyConflict[] {
  const byBinding = new Map<string, CommandId[]>();
  for (const command of COMMANDS) {
    const binding = keymap[command.id];
    const list = byBinding.get(binding);
    if (list === undefined) {
      byBinding.set(binding, [command.id]);
    } else {
      list.push(command.id);
    }
  }
  const conflicts: KeyConflict[] = [];
  for (const [binding, commandIds] of byBinding) {
    if (commandIds.length > 1) {
      conflicts.push({ binding, commandIds });
    }
  }
  return conflicts;
}

/** 指定键位是否已被其它命令占用（用于录制改键时的冲突检测）。 */
export function bindingOwner(
  keymap: Readonly<Record<CommandId, string>>,
  binding: string,
  exceptId: CommandId,
): CommandId | null {
  for (const command of COMMANDS) {
    if (command.id !== exceptId && keymap[command.id] === binding) {
      return command.id;
    }
  }
  return null;
}

export function commandMeta(id: CommandId): CommandMeta | undefined {
  return COMMANDS.find((command) => command.id === id);
}

/** 事件 → 匹配到的命令（按规范化键位精确匹配）。 */
export function commandForEvent(
  keymap: Readonly<Record<CommandId, string>>,
  event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean },
  isMac: boolean,
): CommandId | null {
  const binding = eventToBinding(event, isMac);
  if (binding === null) {
    return null;
  }
  for (const command of COMMANDS) {
    if (keymap[command.id] === binding) {
      return command.id;
    }
  }
  return null;
}