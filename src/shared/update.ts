/**
 * 自动更新：共享纯逻辑与类型（main / renderer / 测试共用，不依赖 Electron 或 DOM）。
 *
 * 设计要点：
 * - 更新地址集中在 resolveUpdateConfig / buildUpdateFeedUrl，禁止散落硬编码。
 * - 开发环境、未注入公开发布仓库、显式关闭时一律不检查更新（安全默认）。
 * - 本模块纯函数化，便于单元测试覆盖版本比较、feed 构造、Squirrel 参数解析。
 */

/** 更新状态机（main 推送给 renderer 的唯一状态）。 */
export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'ready'
  | 'up-to-date'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  /** 可用 / 已就绪的版本号（无则 null）。 */
  version: string | null;
  /** 下载进度 0..100；Electron 未提供进度事件时保持 null。 */
  percent: number | null;
  /** 面向用户的可读消息（提示或错误原因）。 */
  message: string | null;
  /** 是否允许用户主动触发「重启并安装」。 */
  canInstall: boolean;
}

export const INITIAL_UPDATE_STATE: UpdateState = {
  status: 'idle',
  version: null,
  percent: null,
  message: null,
  canInstall: false,
};

/**
 * 更新相关环境变量（构建时注入，禁止在源码中硬编码仓库名 / Token）。
 * - LAIPIAN_RELEASE_REPO：公开发布仓库 owner/repo。
 * - LAIPIAN_UPDATE_FEED：自定义 feed 基础地址（覆盖官方托管；用于自建更新服务）。
 * - LAIPIAN_UPDATE_DISABLE：设为 1/true/yes/on 时彻底关闭更新。
 * - LAIPIAN_UPDATE_SIGNED：仅构建机使用。设为 1/true/yes/on 时，把
 *   `signed: true` 写入 update-config.json。只有 Developer ID / Authenticode
 *   正式签名包才应设置。ad-hoc（`codesign -`）和未签名包不要设置。
 *   运行时环境变量不能把未签名包重新打开自动更新。
 */
export const UPDATE_ENV_KEYS = {
  repo: 'LAIPIAN_RELEASE_REPO',
  feed: 'LAIPIAN_UPDATE_FEED',
  disable: 'LAIPIAN_UPDATE_DISABLE',
} as const;

/** 常规启动后延迟检查（不打扰用户，也让窗口先完成首帧）。 */
export const UPDATE_CHECK_DELAY_MS = 15_000;
/** 首次安装启动（--squirrel-firstrun）后延迟检查，避免与首次初始化竞争。 */
export const UPDATE_FIRST_RUN_DELAY_MS = 60_000;

/* ------------------------------------------------------------------ */
/* 版本比较                                                              */
/* ------------------------------------------------------------------ */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** 预发布后缀（如 beta.1）；正式版为 null。 */
  prerelease: string | null;
}

/** 解析语义化版本；非 `x.y.z(-pre)` 形态返回 null。 */
export function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_RE.exec(input.trim());
  if (match === null) {
    return null;
  }
  const major = Number(match[1] ?? '');
  const minor = Number(match[2] ?? '');
  const patch = Number(match[3] ?? '');
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  const pre = match[4];
  return {
    major,
    minor,
    patch,
    prerelease: pre === undefined || pre.length === 0 ? null : pre,
  };
}

/**
 * 比较两个版本：a < b 返回 -1，a == b 返回 0，a > b 返回 1。
 * 预发布版小于同号正式版（1.0.0-beta < 1.0.0）。无法解析时退化为字符串比较，不抛错。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  const numeric: readonly (keyof Pick<ParsedVersion, 'major' | 'minor' | 'patch'>)[] = [
    'major',
    'minor',
    'patch',
  ];
  for (const key of numeric) {
    if (pa[key] !== pb[key]) {
      return pa[key] < pb[key] ? -1 : 1;
    }
  }
  if (pa.prerelease === pb.prerelease) {
    return 0;
  }
  if (pa.prerelease === null) {
    return 1;
  }
  if (pb.prerelease === null) {
    return -1;
  }
  if (pa.prerelease === pb.prerelease) {
    return 0;
  }
  return pa.prerelease < pb.prerelease ? -1 : 1;
}

/** candidate 是否比 current 新（用于判断是否存在可安装的新版本）。 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/* ------------------------------------------------------------------ */
/* 更新地址（集中构造）                                                   */
/* ------------------------------------------------------------------ */

/** Electron 官方更新托管服务（从公开 GitHub Releases 读取，无需 Token、无需登录）。 */
export const ELECTRON_UPDATE_SERVICE = 'https://update.electronjs.org';

/**
 * 构造更新 feed 地址：
 * - 提供 feedBaseUrl 时直接使用（自建更新服务，末尾斜杠去掉）；
 * - 否则使用 Electron 官方托管：`https://update.electronjs.org/<owner/repo>/<platform>/<version>`。
 *   注意：官方服务在 platform 段之后**直接**是版本号，**不接受 arch** ——
 *   `/win32/x64/1.0.0` 会被判为 `Invalid SemVer`（已实测返回 400）。
 */
export function buildUpdateFeedUrl(
  repo: string,
  platform: string,
  currentVersion: string,
  feedBaseUrl?: string | null,
): string {
  const custom = feedBaseUrl?.trim();
  if (custom !== undefined && custom.length > 0) {
    return custom.replace(/\/+$/, '');
  }
  const cleanRepo = repo.trim().replace(/^\/+|\/+$/g, '');
  const cleanVersion = currentVersion.trim().replace(/^v/, '');
  return `${ELECTRON_UPDATE_SERVICE}/${cleanRepo}/${platform}/${cleanVersion}`;
}

/* ------------------------------------------------------------------ */
/* 运行时配置解析（集中在 main 侧调用一次）                                */
/* ------------------------------------------------------------------ */

export type UpdateSupport = 'windows-squirrel' | 'macos-squirrel' | 'unsupported';

export type UpdateDisabledReason =
  | 'dev'
  | 'not-configured'
  | 'disabled-by-env'
  | 'unsupported-platform'
  | 'unsigned';

export interface UpdateRuntimeInput {
  /** app.isPackaged：未打包（开发环境）不检查更新。 */
  isPackaged: boolean;
  /** process.platform。 */
  platform: string;
  /** process.arch。 */
  arch: string;
  /** app.getVersion()。 */
  currentVersion: string;
  /**
   * 构建注入的正式签名标记。缺省视为未签名。
   * 未签名 / ad-hoc 构建必须为 false，从而禁用静默自动更新。
   */
  signedForAutoUpdate: boolean;
  /** process.env（只读取白名单键）。 */
  env: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedUpdateConfig {
  enabled: boolean;
  reason: UpdateDisabledReason | null;
  support: UpdateSupport;
  repo: string | null;
  feedUrl: string | null;
  currentVersion: string;
  platform: string;
  arch: string;
  checkDelayMs: number;
  firstRunDelayMs: number;
}

function parseSwitch(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * 解析更新配置（唯一入口）：
 * 优先级：显式关闭 → 开发环境 → 不支持的平台 → 未签名/ad-hoc → 未配置仓库 → 启用。
 * 未签名包需要用户手动下载安装包覆盖安装，不在应用内静默下载替换。
 */
export function resolveUpdateConfig(input: UpdateRuntimeInput): ResolvedUpdateConfig {
  const support: UpdateSupport =
    input.platform === 'win32'
      ? 'windows-squirrel'
      : input.platform === 'darwin'
        ? 'macos-squirrel'
        : 'unsupported';

  const base = {
    support,
    currentVersion: input.currentVersion,
    platform: input.platform,
    arch: input.arch,
    checkDelayMs: UPDATE_CHECK_DELAY_MS,
    firstRunDelayMs: UPDATE_FIRST_RUN_DELAY_MS,
  } as const;

  if (parseSwitch(input.env[UPDATE_ENV_KEYS.disable])) {
    return { ...base, enabled: false, reason: 'disabled-by-env', repo: null, feedUrl: null };
  }
  if (!input.isPackaged) {
    return { ...base, enabled: false, reason: 'dev', repo: null, feedUrl: null };
  }
  if (support === 'unsupported') {
    return { ...base, enabled: false, reason: 'unsupported-platform', repo: null, feedUrl: null };
  }
  if (input.signedForAutoUpdate !== true) {
    return { ...base, enabled: false, reason: 'unsigned', repo: null, feedUrl: null };
  }

  const repo = (input.env[UPDATE_ENV_KEYS.repo] ?? '').trim();
  const feedBase = (input.env[UPDATE_ENV_KEYS.feed] ?? '').trim();
  if (repo.length === 0 && feedBase.length === 0) {
    return { ...base, enabled: false, reason: 'not-configured', repo: null, feedUrl: null };
  }

  return {
    ...base,
    enabled: true,
    reason: null,
    repo: repo.length > 0 ? repo : null,
    feedUrl: buildUpdateFeedUrl(repo, input.platform, input.currentVersion, feedBase),
  };
}

/* ------------------------------------------------------------------ */
/* Squirrel.Windows 启动参数                                             */
/* ------------------------------------------------------------------ */

export type SquirrelStartupKind = 'install' | 'updated' | 'uninstall' | 'obsolete' | 'firstrun';

export interface SquirrelStartup {
  kind: SquirrelStartupKind;
  /** 版本号（`--squirrel-install=1.2.3` 中的 1.2.3）；无则 null。 */
  version: string | null;
}

const SQUIRREL_PREFIX = '--squirrel-';
const SQUIRREL_KINDS: readonly SquirrelStartupKind[] = [
  'install',
  'updated',
  'uninstall',
  'obsolete',
  'firstrun',
];

/** 解析 Squirrel 启动参数；非 Squirrel 启动返回 null。 */
export function parseSquirrelStartup(argv: readonly string[]): SquirrelStartup | null {
  for (const raw of argv) {
    if (typeof raw !== 'string') {
      continue;
    }
    const arg = raw.trim();
    if (!arg.startsWith(SQUIRREL_PREFIX)) {
      continue;
    }
    const body = arg.slice(SQUIRREL_PREFIX.length);
    const eq = body.indexOf('=');
    const name = (eq === -1 ? body : body.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? null : body.slice(eq + 1);
    for (const kind of SQUIRREL_KINDS) {
      if (name === kind) {
        return { kind, version: value !== null && value.length > 0 ? value : null };
      }
    }
  }
  return null;
}

/** 是否首次安装启动：用于延长首次更新检查延迟。 */
export function isSquirrelFirstRun(argv: readonly string[]): boolean {
  return parseSquirrelStartup(argv)?.kind === 'firstrun';
}